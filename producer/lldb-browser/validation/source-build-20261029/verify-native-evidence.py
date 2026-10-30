#!/usr/bin/env python3
"""Independently verify recovered native qualification source inputs and transcripts.

The archive contains executable hash records, not executables. This program
authenticates those records and the CI recheck step without claiming a local
hash of executable bytes. It does not build or run a compiler or debugger.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent
SOURCE = '7bd1d38d61c6602fd05260f04af979abbfdc8e0f'
LLVM = 'ca7933e47d3a3451d81e72ac174dcb5aa28b59d1'
RUN = 40789115130
JOB = 123169617643
ARTIFACT = 12867233843
DIGEST = 'sha256:e5407fc6d994390870ccf0821fc98a8a872f189f766f0758a5879ffc74859ef5'
FILES = ['built-binaries.sha256', 'container-adaptors.log', 'fixture-modules.sha256',
         'function-end.log', 'hit-condition.json', 'source-inputs.json']
INPUTS = ['function-end.cpp', 'hit-count.c', 'container-adaptors.cpp',
          'run-native-cpp-baseline.mjs', 'run-native-hit-condition-baseline.mjs',
          'run-native-dap-baseline.mjs', 'native-processes.mjs']
PATCH_NAMES = ['0007-wasm-recursive-frame-cfa.patch', '0010-wasm-caller-pc-cache.patch',
               '0011-libcxx-container-adaptors.patch', '0012-lldb-dap-clear-hit-condition.patch',
               '0013-libcxx-native-deque.patch']


def digest(data):
    return hashlib.sha256(data).hexdigest()


def identity(path):
    data = path.read_bytes()
    return {'bytes': len(data), 'sha256': digest(data)}


def read_json(path):
    assert path.stat().st_size < 4 * 1024**2, path
    return json.loads(path.read_bytes())


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def git(directory, *args):
    return subprocess.check_output(['git', '-C', str(directory), *args])


def reconstruct(source, donor):
    assert git(source, 'rev-parse', 'HEAD').decode().strip() == SOURCE
    def source_bytes(relative):
        actual = (source / relative).read_bytes()
        assert actual == git(source, 'show', f'{SOURCE}:{relative}'), relative
        return actual
    clang_bytes = source_bytes('producer/clang-browser/manifest.json')
    lock_bytes = source_bytes('producer/lldb-browser/sources.lock.json')
    clang, lock = json.loads(clang_bytes), json.loads(lock_bytes)
    assert clang['sources']['llvm']['commit'] == lock['llvm']['commit'] == LLVM
    patches = [{'root': 'producer/clang-browser', **clang['sources']['wasmFunctionEndPatch']}]
    for name in PATCH_NAMES:
        matches = [entry for entry in lock['patches'] if entry['path'] == 'patches/' + name]
        assert len(matches) == 1, name
        patches.append({'root': 'producer/lldb-browser', **matches[0]})
    for patch in patches:
        assert digest(source_bytes(patch['root'] + '/' + patch['path'])) == patch['sha256']
    inputs = {}
    for name in INPUTS:
        data = source_bytes('test/native-wasm-debug/' + name)
        inputs[name] = {'bytes': len(data), 'sha256': digest(data)}
    # A private index reconstructs all six patches without a source checkout.
    # Its readonly object donor is the previously fetched pinned LLVM repository.
    repository = ROOT / 'native-source-identity.git'
    if not repository.exists():
        subprocess.run(['git', 'init', '--bare', '--quiet', str(repository)], check=True)
        (repository / 'objects/info/alternates').write_text(str(donor.resolve() / 'objects') + '\n')
    assert (repository / 'objects/info/alternates').read_text().strip() == str(donor.resolve() / 'objects')
    env = os.environ.copy()
    env['GIT_INDEX_FILE'] = str(ROOT / 'native-source.index')
    def index_git(*args):
        return subprocess.check_output(['git', '--git-dir=' + str(repository), *args], env=env)
    assert index_git('cat-file', '-t', LLVM).strip() == b'commit'
    index_git('read-tree', LLVM)
    for patch in patches:
        index_git('apply', '--cached', '--check', str(source / patch['root'] / patch['path']))
        index_git('apply', '--cached', str(source / patch['root'] / patch['path']))
    index_git('diff', '--cached', '--check', LLVM)
    changes = index_git('diff', '--cached', '--name-status', LLVM).decode().splitlines()
    assert all(line.split('\t', 1)[0] in {'A', 'M'} for line in changes), changes
    # CI applied patches to its worktree; its tracked diff excludes the new
    # LibCxxDeque.cpp file. That file remains bound by patch bytes above.
    tracked_diff = index_git('diff', '--cached', '--binary', '--full-index', '--diff-filter=M', LLVM).strip()
    expectation = {
        'revision': LLVM, 'qualificationCommit': SOURCE, 'qualificationInputs': inputs,
        'clangManifestSha256': digest(clang_bytes), 'lldbSourcesLockSha256': digest(lock_bytes),
        'patches': patches, 'trackedDiffSha256': digest(tracked_diff),
    }
    write_json(ROOT / 'native-source-reconstruction.json', {
        'baseRevision': LLVM, 'patchedTree': index_git('write-tree').decode().strip(),
        'changedPaths': changes, 'trackedDiffSha256': digest(tracked_diff),
        'method': 'Private Git index populated from pinned LLVM Git objects; six source-locked patches applied in order; new files excluded only from CI tracked-diff comparison.',
    })
    write_json(ROOT / 'expected-native-inputs.json', expectation)
    return expectation


def function_end(products, source):
    fixture = (source / 'test/native-wasm-debug/function-end.cpp').read_text().splitlines()
    def marker(name):
        matches = [i + 1 for i, line in enumerate(fixture) if line.endswith('// ' + name)]
        assert len(matches) == 1, name
        return matches[0]
    text = (products / 'function-end.log').read_text()
    assert 'Process 1 exited with status = 0' in text and 'error:' not in text
    pieces = re.split(r'^\(lldb\) ', text, flags=re.M)
    commands = [piece.split('\n', 1) for piece in pieces[1:]]
    steps = [body for command, body in commands if command == 'thread step-over']
    expected_steps = [
        ('simple(n=2)', marker('simple end')), ('main', marker('simple caller')),
        ('early(n=2)', marker('early end')), ('main', marker('early caller')),
        ('recursive(n=0)', marker('recursive end')), ('recursive(n=1)', marker('recursive end')),
        ('recursive(n=2)', marker('recursive end')), ('cleanup(n=2)', marker('cleanup end')),
        ('main', 43), ('implicit(n=2)', marker('implicit end')),
    ]
    assert len(steps) == len(expected_steps)
    for body, (function, line) in zip(steps, expected_steps):
        assert f'`{function} at function-end.cpp:{line}:' in body, (function, line)
        assert 'stop reason = step over' in body
    out_steps = [body for command, body in commands if command == 'thread step-out']
    expected_out = [('recursive(n=1)', marker('recursive call')),
                    ('recursive(n=2)', marker('recursive call')), ('main', marker('recursive caller'))]
    assert len(out_steps) == len(expected_out)
    for body, (function, line) in zip(out_steps, expected_out):
        assert f'`{function} at function-end.cpp:{line}:' in body
        assert 'stop reason = step out' in body
    locals_blocks = [body for command, body in commands if command.startswith('frame variable')]
    actual_answers = [int(re.search(r'^\(int\) answer = (-?\d+)$', body, re.M).group(1)) for body in locals_blocks]
    assert actual_answers == [12, 22, 30, 61, 93, 42, 52]
    assert '(int) n = 0\n' in locals_blocks[2]
    return {'stepOvers': len(steps), 'stepOuts': len(out_steps), 'liveAnswers': actual_answers, 'exitCode': 0}


def adaptors(products):
    text = (products / 'container-adaptors.log').read_text()
    assert 'Process 1 exited with status = 0' in text and 'error:' not in text
    stops = list(re.finditer(r'stop reason = breakpoint (\d+)\.1', text))
    assert [match.group(1) for match in stops] == ['1', '2']
    results = []
    for index, match in enumerate(stops):
        stage = text[match.end():stops[index + 1].start() if index + 1 < len(stops) else None]
        scalars = {name: int(value) for name, value in re.findall(r'^\([^\n]+\) ([\w.\[\]]+) = (-?\d+)\s*$', stage, re.M)}
        sequences = ({'deque_stack': [1, 2, 3], 'vector_stack': [4, 5, 6], 'max_heap': [4, 1, 2],
                      'min_heap': [1, 4, 2], 'deque_heap': [1, 4, 2]} if index == 0 else
                     {'deque_stack': [1, 2], 'vector_stack': [4, 5, 6, 9], 'max_heap': [2, 1],
                      'min_heap': [0, 1, 2, 4], 'deque_heap': [1, 4, 2]})
        sizes = {'empty_stack': 0, 'empty_heap': 0, 'nested_stack': 1, 'nested_heap': 2,
                 'block_deque': 1025, 'large_deque': 17, **{name: len(values) for name, values in sequences.items()}}
        for name, count in sizes.items():
            assert re.search(r'\b' + re.escape(name) + r' = size=' + str(count) + r'(?:\s|$)', stage), name
        for name, values in sequences.items():
            actual = [scalars[f'{name}[{i}]'] for i in range(len(values))]
            if name.endswith('_heap'):
                assert actual[0] == values[0] and sorted(actual) == sorted(values), name
            else:
                assert actual == values, name
        expected = {'nested_stack[0][0]': 7, 'nested_stack[0][1]': 8,
                    'nested_heap[0][0]': 3, 'nested_heap[0][1]': 4}
        expected.update({'block_deque[0]': 5 + index, 'block_deque[1018]': 1023 + index,
                         'block_deque[1019]': 1024 + index, 'block_deque[1024]': 1029 + index,
                         'large_deque[0].value': 10 + 10 * index, 'large_deque[14].value': 150 + 10 * index,
                         'large_deque[15].value': 160 + 10 * index, 'large_deque[16].value': 170 + 10 * index})
        for name, value in expected.items():
            assert scalars[name] == value, (index, name)
        results.append({'stop': index + 1, 'sizes': sizes, 'boundaryAndNestedValues': expected})
    return {'stops': results, 'dequeBoundaryCoverage': True, 'exitCode': 0}


def hit_conditions(products):
    recorded = read_json(products / 'hit-condition.json')
    cases = ['setting', 'clear-omitted', 'clear-empty']
    assert recorded['qualified'] == cases
    assert [result['case'] for result in recorded['results']] == cases
    summaries = []
    for result in recorded['results']:
        case = result['case']
        assert result['exitCode'] == result['targetExitCode'] == 0
        assert result['targetExitSignal'] is None and result['targetTerminatedByRunner'] is False
        assert result['dapStderr'] == result['targetStderr'] == ''
        values = [3, 4] if case == 'setting' else [1, 2]
        assert [stop['n'] for stop in result['stops']] == list(map(str, values))
        assert [stop['answer'] for stop in result['stops']] == [str(n + 10) for n in values]
        for stop in result['stops']:
            assert stop['reason'] == 'breakpoint' and stop['frame']['line'] == 6
            assert stop['frame']['source']['path'] == '/workspace/hit-count.c'
        expected_specs = [{'line': 6, 'hitCondition': '3'}] if case == 'setting' else [
            {'line': 6, 'hitCondition': '4'}, {'line': 6, **({'hitCondition': ''} if case == 'clear-empty' else {})},
            {'line': 6, 'hitCondition': '4'}, {'line': 6, **({'hitCondition': ''} if case == 'clear-empty' else {})}]
        assert [item['specification'] for item in result['updates']] == expected_specs
        for update in result['updates']:
            assert update['breakpoint']['id'] == result['breakpointId']
            assert update['breakpoint']['verified'] is True
        messages = result['protocol']
        requests = {entry['message']['seq']: entry['message'] for entry in messages if entry['direction'] == 'send'}
        responses = [entry['message'] for entry in messages if entry['direction'] == 'receive' and entry['message']['type'] == 'response']
        assert len(responses) == len(requests) and all(response['success'] is True for response in responses)
        for response in responses:
            assert requests[response['request_seq']]['command'] == response['command']
        break_requests = [request['arguments']['breakpoints'] for request in requests.values() if request['command'] == 'setBreakpoints']
        assert break_requests == [[specification] for specification in expected_specs] + [[]]
        variable_responses = [response['body']['variables'] for response in responses if response['command'] == 'variables']
        assert len(variable_responses) == 2
        for response, n in zip(variable_responses, values):
            values_by_name = {value['name']: value['value'] for value in response}
            assert values_by_name['n'] == str(n) and values_by_name['answer'] == str(n + 10)
        events = [entry['message'] for entry in messages if entry['message']['type'] == 'event']
        assert [entry['body']['reason'] for entry in events if entry['event'] == 'stopped'] == ['entry', 'breakpoint', 'breakpoint']
        assert [entry['body']['exitCode'] for entry in events if entry['event'] == 'exited'] == [0]
        assert len([entry for entry in events if entry['event'] == 'terminated']) == 1
        summaries.append({'case': case, 'breakpointId': result['breakpointId'], 'stoppedN': values,
                          'updates': len(expected_specs), 'protocolMessages': len(messages), 'exitCode': 0})
    return summaries


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--object-donor', type=Path, required=True)
    args = parser.parse_args()
    artifact = read_json(ROOT / 'github-artifact.json')
    assert artifact['id'] == ARTIFACT and artifact['digest'] == DIGEST
    archive = (ROOT / 'source-build.zip').read_bytes()
    assert len(archive) == artifact['size_in_bytes'] and 'sha256:' + digest(archive) == DIGEST
    evidence = read_json(ROOT / 'github-source-build.json')
    assert evidence['run']['id'] == RUN and evidence['run']['head_sha'] == SOURCE
    native_jobs = [job for job in evidence['jobs']['jobs'] if job['id'] == JOB]
    assert len(native_jobs) == 1 and native_jobs[0]['conclusion'] == 'success'
    steps = {step['name']: step for step in native_jobs[0]['steps']}
    baseline_steps = ['Run native LLDB command baseline', 'Run native LLDB DAP baseline',
                      'Run native LLDB DAP trap baseline', 'Run native LLDB DAP interrupt baseline']
    for name in ['Run native function-end baseline with patched binaries',
                 'Qualify native libc++ container adaptors with patched binaries',
                 'Qualify DAP hit conditions and both clearing forms with patched LLDB', *baseline_steps]:
        assert steps[name]['conclusion'] == 'success', name
    products = ROOT / 'products'
    assert sorted(path.name for path in products.iterdir()) == FILES
    with zipfile.ZipFile(ROOT / 'source-build.zip') as zipped:
        for name in FILES:
            assert (products / name).read_bytes() == zipped.read(name), name
    workflow_relative = '.github/workflows/lldb-browser.yml'
    workflow = (args.source / workflow_relative).read_bytes()
    assert workflow == git(args.source, 'show', f'{SOURCE}:{workflow_relative}')
    expectation = reconstruct(args.source.resolve(), args.object_donor.resolve())
    actual = read_json(products / 'source-inputs.json')
    assert actual == expectation, 'Native source inputs differ from independent reconstruction'
    assert expectation['trackedDiffSha256'] == '6093e1af5b189ac5025de5730132a2cbe06ace9f3b9eb7f08d4a4498a8813baa'
    binary_records = {}
    for name, expected_paths in [
        ('built-binaries.sha256', ['features/build/bin/clang', 'features/build/bin/lldb', 'features/build/bin/lldb-dap', 'wamr/build/iwasm', 'features/build/lib/liblldb.so']),
        ('fixture-modules.sha256', ['hit-count.wasm', 'function-end.wasm', 'container-adaptors.wasm'])]:
        records = []
        for line in (products / name).read_text().splitlines():
            matched = re.fullmatch(r'([a-f0-9]{64})  (/tmp/wasm-native-debug/\S+)', line)
            assert matched, name
            records.append({'path': matched.group(2), 'sha256': matched.group(1)})
        assert [entry['path'] for entry in records] == ['/tmp/wasm-native-debug/' + path for path in expected_paths]
        binary_records[name] = records
    result = {
        'schemaVersion': 1, 'kind': 'native-source-build-evidence-verification', 'passed': True,
        'checkedAt': datetime.now(timezone.utc).isoformat(), 'qualificationCommit': SOURCE,
        'workflowRun': RUN, 'jobId': JOB,
        'workflowSource': {'path': workflow_relative, 'bytes': len(workflow), 'sha256': digest(workflow),
                           'matchesQualificationCommit': True},
        'artifact': {'authenticatedArchiveVerified': True, 'id': ARTIFACT, 'digest': DIGEST,
                     'bytes': len(archive), 'files': {name: identity(products / name) for name in FILES}},
        'expectationSha256': identity(ROOT / 'expected-native-inputs.json')['sha256'],
        'sourceInputs': {key: {'expected': value, 'actual': actual[key], 'passed': True} for key, value in expectation.items()},
        'sourceReconstruction': read_json(ROOT / 'native-source-reconstruction.json'),
        'functionEnd': function_end(products, args.source), 'containerAdaptors': adaptors(products),
        'hitConditions': hit_conditions(products), 'binaryHashRecords': binary_records,
        'binaryEvidenceLimitation': 'Only authenticated hash records are downloaded. CI rechecked executable and fixture hashes after patched-binary tests; no local executable-byte verification is claimed.',
        'upstreamBaselines': {'llvmVersion': '22.1.8', 'binaryKind': 'pinned-upstream-unpatched',
                             'successfulSteps': baseline_steps},
    }
    write_json(ROOT / 'native-evidence-verification.json', result)
    print(json.dumps({'passed': True, 'report': str(ROOT / 'native-evidence-verification.json'),
                      'trackedDiffSha256': expectation['trackedDiffSha256'],
                      'functionEnd': result['functionEnd'], 'dapCases': [entry['case'] for entry in result['hitConditions']]}))


if __name__ == '__main__':
    main()
