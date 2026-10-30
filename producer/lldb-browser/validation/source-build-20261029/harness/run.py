#!/usr/bin/env python3
"""Qualify exact Clang + LLDB/WAMR source builds in real Chromium and the product UI."""
import argparse
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import uuid
from prepare import BASE, FIXTURE, HEAD, inventory

CASES = ['c-data-breakpoint', 'cpp-data-breakpoint', 'c-trap', 'rust-basic']
LABELS = ['C/c-data-breakpoint', 'CPP/cpp-data-breakpoint', 'C/c-trap', 'RUST/rust-basic']
ASSETS = ['debug/lldb-web-dap.js', 'debug/lldb-web-dap.wasm', 'debug/lldb-web-dap.pthread.mjs',
          'debug/wamr-debug.js', 'debug/wamr-debug.wasm', 'debug/wamr-debug.worker.mjs']
PIN_FILES = ['scripts/wasm-debug-release.v2.json', 'src/lib/playground/wasmDebugVersion.ts',
             'src/lib/playground/clangAssetIntegrity.ts', 'packages/core/src/runtime-asset-lock.generated.ts']
CUSTOM_SCRIPTS = ['prepare.py', 'build-packages.py', 'pin-clang.py', 'run.py', 'launch.py',
                  'freeze-fixtures.py', 'qualification-cpp-browser.mjs']

def digest(data):
    return hashlib.sha256(data).hexdigest()

def custom_script_inventory():
    records = {}
    for name in CUSTOM_SCRIPTS:
        file = BASE / name
        if file.is_symlink() or not file.is_file():
            raise RuntimeError(f'Custom qualification script must be a regular file: {name}')
        data = file.read_bytes()
        if name == 'qualification-cpp-browser.mjs':
            installed = FIXTURE / 'scripts' / name
            if installed.is_symlink() or not installed.is_file() or installed.read_bytes() != data:
                raise RuntimeError('Executed C++ probe differs from the preserved reproduction script')
        records[name] = {'bytes': len(data), 'sha256': digest(data)}
    return records

def write_json(path, value):
    temporary = path.with_name(path.name + '.tmp-' + uuid.uuid4().hex)
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)

def stop(process):
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=10)
    except ProcessLookupError:
        pass

def verify_sources():
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=FIXTURE, text=True).strip()
    if actual != HEAD:
        raise RuntimeError('Frozen consumer revision changed')
    if subprocess.check_output(['git', 'diff', '--cached', '--name-only'], cwd=FIXTURE):
        raise RuntimeError('Frozen consumer has staged changes')
    changed = subprocess.check_output(['git', 'diff', '--name-only', '-z'], cwd=FIXTURE).decode().split('\0')
    unexpected = [name for name in changed if name and name not in PIN_FILES and not name.startswith('static/')]
    if unexpected:
        raise RuntimeError('Unexpected tracked source changes: ' + ', '.join(unexpected))
    return {name: digest((FIXTURE / name).read_bytes()) for name in PIN_FILES}

def verify_bundle(options):
    bundle = options.bundle.resolve(strict=True)
    raw = (bundle / 'runtime-manifest.v2.json').read_bytes()
    if digest(raw) != options.manifest_sha256:
        raise RuntimeError('Debugger manifest differs from the explicitly selected artifact')
    manifest = json.loads(raw)
    if manifest.get('manifestVersion') != 2 or manifest.get('debugger', {}).get('transport') != 'shared-ring-v1':
        raise RuntimeError('Invalid debugger runtime manifest')
    records = []
    for group_name in ['lldb', 'targetRuntime']:
        group = manifest['debugger'][group_name]
        if group.get('moduleInstantiation') != 'emscripten-instantiate-wasm-v1':
            raise RuntimeError(f'{group_name} lacks the compiled-module API')
        for kind in ['js', 'wasm', 'worker']:
            name = group[kind]
            file = bundle / name
            if name not in ASSETS or not file.is_file() or file.is_symlink():
                raise RuntimeError(f'Unexpected debugger asset: {name}')
            data = file.read_bytes()
            if digest(data) != group[kind + 'Sha256']:
                raise RuntimeError(f'Debugger asset hash mismatch: {name}')
            records.append({'path': name, 'bytes': len(data), 'sha256': digest(data)})
    if [record['path'] for record in records] != ASSETS:
        raise RuntimeError('Debugger asset ordering/identity mismatch')
    lldb_raw, wamr_raw = options.lldb_receipt.read_bytes(), options.wamr_receipt.read_bytes()
    lldb, wamr = json.loads(lldb_raw), json.loads(wamr_raw)
    if lldb.get('build', {}).get('derivation') is not None:
        raise RuntimeError('Experimental post-link receipt cannot qualify as a source build')
    for record in records[:3]:
        pin = lldb['assets'][Path(record['path']).name]
        if pin['sha256'] != record['sha256'] or pin['size'] != record['bytes']:
            raise RuntimeError('LLDB receipt does not identify the selected runtime bytes')
    for record in records[3:]:
        pin = next(asset for asset in wamr['assets'] if asset['path'] == Path(record['path']).name)
        if pin['sha256'] != record['sha256'] or pin['bytes'] != record['bytes']:
            raise RuntimeError('WAMR receipt does not identify the selected runtime bytes')
    if lldb['producer']['sourcesLockSha256'] != manifest['debugger']['lldb']['sourcesLockSha256']:
        raise RuntimeError('LLDB manifest/receipt source-lock mismatch')
    if wamr['provenance'] != manifest['debugger']['targetRuntime']['provenance']:
        raise RuntimeError('WAMR manifest/receipt provenance mismatch')
    return raw, {'manifest': {'bytes': len(raw), 'sha256': digest(raw)}, 'assets': records,
                 'lldbReceiptSha256': digest(lldb_raw), 'wamrReceiptSha256': digest(wamr_raw),
                 'producerRevision': options.producer_revision}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true', help='Validate prepared sources and packages only; never installs assets or launches a browser')
    parser.add_argument('--producer-revision', help='Exact debugger and fixture producer revision')
    parser.add_argument('--clang-producer-revision', help='Exact compiler producer revision; may differ when the later change only affects LLDB')
    parser.add_argument('--bundle', type=Path)
    parser.add_argument('--manifest-sha256')
    parser.add_argument('--lldb-receipt', type=Path)
    parser.add_argument('--wamr-receipt', type=Path)
    parser.add_argument('--clang-source', type=Path)
    parser.add_argument('--clang-receipt-sha256')
    parser.add_argument('--report', type=Path)
    options = parser.parse_args()
    if options.dry_run:
        if HEAD is None:
            print(json.dumps({'state': 'awaiting-final-public-main', 'consumerFrozen': False, 'browserLaunched': False}))
            return 0
        verify_sources()
        identity = json.loads((BASE / 'fixture-identity.json').read_bytes())
        if identity['consumerRevision'] != HEAD:
            raise RuntimeError('Frozen consumer identity mismatch')
        actual_static = inventory(FIXTURE / 'static')
        for name, expected in identity['static'].items():
            if actual_static.get(name) != expected:
                raise RuntimeError(f'Prepared static snapshot is missing or changed: {name}')
        build_state = json.loads((BASE / 'package-build-status.json').read_bytes())
        if build_state.get('state') != 'passed' or build_state.get('exitCode') != 0 or build_state.get('consumerRevision') != HEAD:
            raise RuntimeError('Required package build has not passed')
        packages = json.loads((BASE / 'package-build-identity.json').read_bytes())
        for package, expected in packages.items():
            if inventory(FIXTURE / package / 'dist') != expected:
                raise RuntimeError(f'Frozen package output changed: {package}')
        for name, expected in identity['producerFiles'].items():
            data = (BASE / 'producer' / name).read_bytes()
            if len(data) != expected['bytes'] or digest(data) != expected['sha256']:
                raise RuntimeError(f'Frozen producer fixture/helper changed: {name}')
        subprocess.run(['node', '--check', 'scripts/qualification-cpp-browser.mjs'], cwd=FIXTURE, check=True)
        print(json.dumps({'state': 'prepared-no-browser', 'consumerRevision': HEAD,
                          'consumerMain': identity['consumerMain'], 'sourceKind': identity.get('sourceKind'),
                          'fixtureProducerRevision': identity['producerRevision'], 'packagesVerified': len(packages),
                          'officialUiCases': CASES, 'cacheModes': [False, False, True, True],
                          'cppCases': ['container-adaptors.cpp: two stops', 'function-end.cpp: simple/early/recursive/cleanup/implicit'],
                          'customScripts': custom_script_inventory(),
                          'remaining': 'Final producer revision and exact source-build artifacts must be supplied.'}, indent=2))
        return 0
    for name in ['producer_revision', 'clang_producer_revision', 'bundle', 'manifest_sha256', 'lldb_receipt', 'wamr_receipt', 'clang_source', 'clang_receipt_sha256', 'report']:
        if getattr(options, name) is None:
            parser.error('--' + name.replace('_', '-') + ' is required for an actual qualification')
    for revision in [options.producer_revision, options.clang_producer_revision]:
        if not re.fullmatch('[0-9a-f]{40}', revision):
            parser.error('Exact lowercase producer revisions are required')
    for value in [options.manifest_sha256, options.clang_receipt_sha256]:
        if not re.fullmatch('[0-9a-f]{64}', value):
            parser.error('Exact lowercase SHA-256 values are required')
    os.umask(0o077)
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:8]
    run = BASE / 'runs' / stamp
    run.mkdir(parents=True)
    # Chromium creates a Unix socket below TMPDIR; a long worktree path exceeds
    # its path limit. Keep browser temporary files on disk under a short root.
    runtime_tmp = Path('/tmp') / ('wdq-' + stamp)
    runtime_tmp.mkdir(mode=0o700)
    logs = Path.home() / 'logs' / ('wasm-debug-qualification-' + stamp)
    logs.mkdir(mode=0o700, parents=True)
    state_path = run / 'status.json'
    state = {'state': 'starting', 'pid': os.getpid(), 'exitCode': None, 'runDirectory': str(run), 'logs': str(logs),
             'temporaryDirectory': str(runtime_tmp)}
    write_json(state_path, state)
    report = {'schemaVersion': 1, 'kind': 'wasm-llvm-source-browser-qualification', 'passed': False,
              'consumerRevision': HEAD, 'producerRevision': options.producer_revision,
              'clangProducerRevision': options.clang_producer_revision, 'cases': CASES,
              'runDirectory': str(run), 'stateFile': str(state_path), 'commands': [],
              'harness': custom_script_inventory(), 'temporaryDirectory': str(runtime_tmp)}
    options.report.parent.mkdir(parents=True, exist_ok=True)
    if options.report.exists():
        raise RuntimeError('Refusing to overwrite an existing report')
    write_json(options.report, report)
    print(json.dumps({'pid': os.getpid(), 'status': str(state_path), 'logs': str(logs), 'report': str(options.report)}), flush=True)
    node = shutil.which('node')
    environment = dict(os.environ, TMPDIR=str(runtime_tmp), WASM_IDLE_STRICT_CSP='1', WASM_IDLE_REQUIRE_BROWSER_TESTS='1',
                       WASM_IDLE_RUN_REAL_BROWSER_DEBUG='1', WASM_IDLE_REQUIRE_LLDB_DEBUG='1',
                       WASM_IDLE_DEBUG_BROWSER_LANGUAGES='C,CPP,RUST', WASM_IDLE_DEBUG_BROWSER_CASES=','.join(CASES),
                       WASM_IDLE_DEBUG_BROWSER_TEST_TIMEOUT_MS='1200000', WASM_IDLE_REUSE_LOCAL_PREVIEW='1')
    environment.pop('NODE_ENV', None)
    for key in list(environment):
        if key.startswith('VITEST'):
            del environment[key]
    children = []
    def command(name, argv, timeout=600):
        log = logs / (name + '.log')
        state.update(state='running', phase=name)
        write_json(state_path, state)
        entry = {'name': name, 'argv': list(map(str, argv)), 'log': str(log), 'exitCode': None}
        report['commands'].append(entry)
        write_json(options.report, report)
        with log.open('xb') as stream:
            process = subprocess.Popen(list(map(str, argv)), cwd=FIXTURE, env=environment,
                                       stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
            children.append(process)
            try:
                code = process.wait(timeout=timeout)
            finally:
                stop(process)
                children.remove(process)
        entry['exitCode'] = code
        write_json(options.report, report)
        if code:
            raise RuntimeError(f'{name} exited {code}; see {log}')
        return log
    code = 1
    fixture_lock = browser_lock = preview_stream = None
    try:
        fixture_lock = (BASE / 'fixture.lock').open('a+')
        fcntl.flock(fixture_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if shutil.disk_usage(BASE).free < 1024**3:
            raise RuntimeError('Qualification needs at least 1 GiB available for its prepared fixture')
        identity = json.loads((BASE / 'fixture-identity.json').read_bytes())
        if identity['consumerRevision'] != HEAD or identity['producerRevision'] != options.producer_revision:
            raise RuntimeError('Fixture identity mismatch')
        for name, expected in identity['producerFiles'].items():
            data = (BASE / 'producer' / name).read_bytes()
            if len(data) != expected['bytes'] or digest(data) != expected['sha256']:
                raise RuntimeError(f'Producer fixture/helper changed: {name}')
        report['fixtureProducerRevision'] = identity['producerRevision']
        report['producerFiles'] = identity['producerFiles']
        adaptor_source = (BASE / 'producer/test/native-wasm-debug/container-adaptors.cpp').read_text()
        if 'block_deque' not in adaptor_source or 'large_deque' not in adaptor_source:
            raise RuntimeError('Freeze the final producer deque regression fixture before qualification')
        report['fixtureIdentitySha256'] = digest((BASE / 'fixture-identity.json').read_bytes())
        report['consumerMain'] = identity['consumerMain']
        report['consumerSourceKind'] = identity['sourceKind']
        verify_sources()
        initial_static = inventory(FIXTURE / 'static')
        for name, expected in identity['static'].items():
            if not name.startswith('clang/') and name not in ['compressed-runtime-assets.v1.json', 'layered-runtime-assets.v1.json'] and initial_static.get(name) != expected:
                raise RuntimeError(f'Frozen supporting asset changed: {name}')
        outputs = json.loads((BASE / 'package-build-identity.json').read_bytes())
        for package, expected in outputs.items():
            if inventory(FIXTURE / package / 'dist') != expected:
                raise RuntimeError(f'Fresh consumer package output changed: {package}')
        manifest_raw, artifact_evidence = verify_bundle(options)
        report['debuggerEvidence'] = artifact_evidence
        command('pin-candidate-clang', ['python3', BASE / 'pin-clang.py', '--clang-source', options.clang_source.resolve(),
                                       '--receipt-sha256', options.clang_receipt_sha256, '--work-dir', run / 'clang'])
        report['clangEvidence'] = json.loads((run / 'clang/evidence.json').read_bytes())
        report['clangEvidence']['producerRevision'] = options.clang_producer_revision
        command('sync-debugger', [node, 'scripts/sync-wasm-debug.mjs', options.bundle.resolve()])
        write_json(FIXTURE / 'scripts/wasm-debug-release.v2.json', {'schemaVersion': 1, 'producerRevision': options.producer_revision,
                                                                'manifestReceipt': artifact_evidence['manifest']})
        # Replacing Clang removes old generated .gz files; the small fixture's
        # delivery index must describe only files that actually remain installed.
        index_path = FIXTURE / 'static/compressed-runtime-assets.v1.json'
        index = json.loads(index_path.read_bytes())
        index['assets'] = [name for name in index['assets'] if (FIXTURE / 'static' / (name + '.gz')).is_file()]
        index['sizes'] = {name: len(gzip.decompress((FIXTURE / 'static' / (name + '.gz')).read_bytes())) for name in index['assets']}
        write_json(index_path, index)
        command('candidate-runtime-pins', [node, 'scripts/generate-runtime-asset-lock.mjs', 'static'])
        frozen_static = inventory(FIXTURE / 'static')
        frozen_pins = verify_sources()
        report['installedStatic'] = frozen_static
        report['candidatePinFiles'] = frozen_pins
        command('build-preview', [node, 'node_modules/vite/bin/vite.js', 'build'], timeout=900)
        command('compress-preview', [node, 'scripts/compress-static-runtime-assets.mjs', 'build'])
        command('verify-preview-debugger', [node, 'scripts/verify-page-wasm-debug.mjs', 'build', 'scripts/wasm-debug-release.v2.json'])
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        browser_url = f'http://127.0.0.1:{port}/wasm-idle/'
        environment['WASM_IDLE_BROWSER_URL'] = browser_url
        preview_log = logs / 'preview.log'
        preview_stream = preview_log.open('xb')
        preview = subprocess.Popen([node, 'node_modules/vite/bin/vite.js', 'preview', '--config', 'scripts/release-preview.config.mjs',
                                    '--host', '127.0.0.1', '--port', str(port), '--strictPort'], cwd=FIXTURE, env=environment,
                                   stdin=subprocess.DEVNULL, stdout=preview_stream, stderr=subprocess.STDOUT, start_new_session=True)
        children.append(preview)
        state.update(phase='preview-start', previewPid=preview.pid, previewLog=str(preview_log))
        write_json(state_path, state)
        deadline = time.monotonic() + 60
        while True:
            if preview.poll() is not None:
                raise RuntimeError(f'Preview exited {preview.returncode}; see {preview_log}')
            try:
                with urllib.request.urlopen(browser_url, timeout=2) as response:
                    body = response.read()
                    assert response.status == 200
                    assert response.headers['Cross-Origin-Opener-Policy'] == 'same-origin'
                    assert response.headers['Cross-Origin-Embedder-Policy'] == 'require-corp'
                    assert response.headers['Content-Security-Policy']
                    headers = dict(response.headers)
                break
            except (OSError, AssertionError):
                if time.monotonic() > deadline:
                    raise RuntimeError('Preview did not serve an isolated strict-CSP document')
                time.sleep(0.2)
        with urllib.request.urlopen(browser_url + 'wasm-debug/runtime-manifest.v2.json') as response:
            if response.read() != manifest_raw:
                raise RuntimeError('Preview served a different debugger manifest')
        report['preview'] = {'url': browser_url, 'indexSha256': digest(body), 'headers': headers}
        state.update(phase='waiting-browser-lock')
        write_json(state_path, state)
        browser_lock = open('/tmp/wasm-perf-browser-20261023.lock', 'a+')
        deadline = time.monotonic() + 600
        while True:
            try:
                fcntl.flock(browser_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise RuntimeError('Shared Chromium qualification lock is busy')
                time.sleep(1)
        report['browserLock'] = {'path': '/tmp/wasm-perf-browser-20261023.lock', 'ownerPid': os.getpid()}
        command('cache-off-off-on-on', [node, 'scripts/probe-lldb-first-pause.mjs', '--cache-mode', 'both',
                '--debug-assets', FIXTURE / 'static/wasm-debug', '--debug-manifest-sha256', options.manifest_sha256,
                '--json', run / 'cache.json'], timeout=900)
        report['cacheProbe'] = json.loads((run / 'cache.json').read_bytes())
        if [item['compiledModuleCache'] for item in report['cacheProbe']['results']] != [False, False, True, True]:
            raise RuntimeError('Cache probe omitted a required cold/fresh/reuse session')
        result_file = run / 'vitest.json'
        ui_log = command('official-product-ui', [node, 'node_modules/vitest/vitest.mjs', 'run', 'src/lib/playground/debug.playwright.test.ts',
                '--reporter=default', '--reporter=json', '--reporter=./scripts/required-browser-reporter.mjs', '--outputFile=' + str(result_file)], timeout=1250)
        result = json.loads(result_file.read_bytes())
        if result.get('success') is not True or result.get('numPassedTests') != 1 or result.get('numFailedTests') != 0 or result.get('numPendingTests', 0) != 0:
            raise RuntimeError('Required official UI test did not pass exactly once')
        text = ui_log.read_text()
        for label in LABELS:
            if text.count('[wasm-idle:debug-case] PASS ' + label) != 1:
                raise RuntimeError(f'Missing unique official UI result: {label}')
        if '[wasm-idle:debug-case] FAIL ' in text:
            raise RuntimeError('Official UI reported a failing case')
        report['officialUi'] = {'passed': True, 'cases': LABELS, 'vitestReport': str(result_file)}
        command('cpp-adaptors-function-end', [node, 'scripts/qualification-cpp-browser.mjs',
                '--debug-manifest-sha256', options.manifest_sha256, '--json', run / 'cpp.json'], timeout=900)
        report['cppProbe'] = json.loads((run / 'cpp.json').read_bytes())
        adaptor_result = next(result for result in report['cppProbe']['results'] if result['filename'] == 'container-adaptors.cpp')
        if adaptor_result.get('dequeBoundaryCoverage') is not True:
            raise RuntimeError('C++ probe omitted the required multi-block/large-element deque regressions')
        if inventory(FIXTURE / 'static') != frozen_static or verify_sources() != frozen_pins:
            raise RuntimeError('Qualification inputs changed during execution')
        if verify_bundle(options)[1] != artifact_evidence:
            raise RuntimeError('Producer debugger artifact changed during execution')
        if custom_script_inventory() != report['harness']:
            raise RuntimeError('Custom qualification helper/probe scripts changed during execution')
        if digest((BASE / 'fixture-identity.json').read_bytes()) != report['fixtureIdentitySha256']:
            raise RuntimeError('Frozen fixture identity changed during execution')
        for name, expected in report['producerFiles'].items():
            data = (BASE / 'producer' / name).read_bytes()
            if {'bytes': len(data), 'sha256': digest(data)} != expected:
                raise RuntimeError(f'Frozen producer fixture/helper changed during execution: {name}')
        report['passed'] = True
        code = 0
    except BaseException as error:
        report['error'] = f'{type(error).__name__}: {error}'
        print(report['error'], file=sys.stderr, flush=True)
    finally:
        for child in reversed(children):
            stop(child)
        if preview_stream:
            preview_stream.close()
        if browser_lock:
            browser_lock.close()
        if fixture_lock:
            fixture_lock.close()
        try:
            report['harnessUnchanged'] = custom_script_inventory() == report['harness']
            if not report['harnessUnchanged']:
                code = 1
                report['passed'] = False
                report['integrityError'] = 'Custom qualification scripts changed during execution'
        except Exception as error:
            code = 1
            report['passed'] = False
            report['integrityError'] = str(error)
        state.update(state='passed' if code == 0 else 'failed', exitCode=code)
        write_json(state_path, state)
        report['exitCode'] = code
        write_json(options.report, report)
    return code

if __name__ == '__main__':
    def interrupted(signum, _frame):
        raise KeyboardInterrupt(f'signal {signum}')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    sys.exit(main())
