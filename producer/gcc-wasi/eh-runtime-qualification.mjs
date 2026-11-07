import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { identity, runLibatomicValidationCommand as run } from './libatomic-qualification.mjs';
import { assertExceptionAssemblyReplay, canonicalExceptionAssembly } from './eh-assembly-replay.mjs';
import { nativeEhCases } from './eh-native-fixtures.mjs';
import { exceptionRuntimeCases } from './eh-runtime-fixtures.mjs';
import { exceptionLibraryCases } from './eh-library-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const content = record => ({ bytes: record.bytes, sha256: record.sha256 });
const identify = async file => ({ path: path.resolve(file), ...identity(await fs.readFile(file)) });
const fixtureCases = [...nativeEhCases, ...exceptionRuntimeCases, ...exceptionLibraryCases];
const helperNames = ['eh-runtime-qualification.mjs', 'eh-assembly-replay.mjs',
  'tls-assembly-replay.mjs', 'libatomic-qualification.mjs', 'tzdb-runtime-state.py'];
export const exceptionRuntimeFiles = Object.freeze(['libstdc++.a', 'libsupc++.a', 'libunwind.a']
  .map(name => 'lib/wasm32-wasi-eh/' + name));
export const exceptionRuntimeLinkFlags = Object.freeze(['--wrap=__main_void',
  '--wrap=__wasm_call_ctors', '--wrap=__wasm_call_dtors', '--wrap=exit']);

async function read(record, requiredPath) {
  assert(record && Number.isSafeInteger(record.bytes) && record.bytes >= 0
    && /^[0-9a-f]{64}$/u.test(record.sha256), 'Missing exception evidence identity');
  assert.equal(typeof record.path, 'string');
  if (requiredPath) assert.equal(path.resolve(record.path), path.resolve(requiredPath));
  const bytes = await fs.readFile(record.path);
  assert.deepEqual(identity(bytes), content(record), 'Changed exception evidence: ' + record.path);
  return bytes;
}

async function checkContent(record, file) {
  assert.deepEqual(identity(await fs.readFile(file)), content(record), 'Changed EH input: ' + file);
}

async function inventory(directory, allowLinks = false) {
  const result = [];
  async function walk(current) {
    for (const name of (await fs.readdir(current)).sort()) {
      const file = path.join(current, name), stat = await fs.lstat(file);
      if (stat.isDirectory()) await walk(file);
      else {
        assert(stat.isFile() || (allowLinks && stat.isSymbolicLink()), 'Unexpected EH artifact type: ' + file);
        result.push({ path: path.relative(directory, file), ...identity(await fs.readFile(file)) });
      }
    }
  }
  await walk(directory); return result;
}

const sorted = records => [...records].sort((a, b) => a.path.localeCompare(b.path));

export function verifyExceptionRuntimeBuildMetadata(report, expected) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'gcc-wasi-exception-runtime-build');
  assert.equal(report.status, 'built-unverified', 'A GNU archive build is not execution qualification');
  assert.equal(report.inputsUnchanged, true);
  assert.equal(report.fullGnuLibrary, true, 'A libsupc++ bootstrap is insufficient');
  assert.equal(report.target, 'wasm32-wasi');
  assert.equal(report.profile, 'ordinary-private-modern');
  for (const key of ['exceptions', 'rtti']) assert.equal(report[key], true);
  assert.equal(report.timezoneDatabase, true, 'The complete GNU runtime must include its timezone implementation');
  for (const key of ['threads', 'userTls', 'sharedMemory', 'coverage', 'debugger']) assert.equal(report[key], false);
  assert.deepEqual(report.gccSource, expected.gccSource);
  assert.deepEqual(content(report.nativeBuild), content(expected.nativeBuild));
  assert.equal(report.sourceLock.sha256, expected.sourceLockSha256);
  assert.deepEqual(report.files.map(record => record.path).sort(), [...exceptionRuntimeFiles].sort());
  assert.deepEqual(report.licenses.map(record => record.path).sort(), ['COPYING.RUNTIME', 'COPYING3', 'libunwind-LICENSE.TXT']);
  assert.deepEqual(report.linkFlags, exceptionRuntimeLinkFlags);
  assert.equal(report.filePrefixMap.to, '/gcc-wasi-eh-runtime');
  const flags = (report.compilerFlags.CXXFLAGS + ' ' + report.compilerFlags.EXTRA_CXX_FLAGS).split(/\s+/u);
  for (const flag of ['-mexception-handling', '-fexceptions', '-frtti', '-save-temps=obj']) assert(flags.includes(flag));
  assert(!flags.includes('-fno-exceptions') && !flags.includes('-fno-rtti'));
  for (const flag of ['-mtls', '-matomics', '-msimd128', '-mrelaxed-simd', '--coverage', '-ftest-coverage', '-fprofile-arcs'])
    assert(!flags.includes(flag), 'Unqualified exception runtime flag ' + flag);
  assert(flags.includes('-ffile-prefix-map=' + report.filePrefixMap.from + '=/gcc-wasi-eh-runtime'));
  assert(Array.isArray(report.headers) && report.headers.length > 100);
  assert.equal(new Set(report.headers.map(record => record.path)).size, report.headers.length);
  assert(report.headers.every(record => record.path.startsWith('include/c++/') && !record.path.split('/').includes('..')));
  assert(Array.isArray(report.inputs) && report.inputs.length > 100);
  assert.equal(new Set(report.inputs.map(record => record.path)).size, report.inputs.length);
}

export function verifyExceptionRuntimeExecutionMetadata(report, expected) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'gnu-native-wasm-eh-execution');
  assert.equal(report.status, 'passed'); assert.equal(report.inputsUnchanged, true);
  assert.equal(report.scope, 'full-gnu-runtime'); assert.equal(report.fullGnuLibrary, true);
  assert.deepEqual(report.gccSource, expected.gccSource);
  assert.deepEqual(content(report.nativeBuild), content(expected.nativeBuild));
  assert.equal(report.sourceLock.sha256, expected.sourceLockSha256);
  assert.deepEqual(content(report.runtimeBuild), content(expected.runtimeBuild));
  assert.deepEqual(report.counts, { total: 46, native: 14, runtime: 14, library: 18 });
  assert(Array.isArray(report.commands) && report.commands.length > 46);
  assert(report.commands.every(command => command.exitCode === 0 && command.timedOut !== true));
  assert.deepEqual(report.nativeCaseIds, nativeEhCases.map(fixture => fixture.id));
  assert.deepEqual(report.cases.map(fixture => fixture.id), fixtureCases.map(fixture => fixture.id));
  assert.deepEqual(report.files.map(record => record.path).sort(), [...exceptionRuntimeFiles].sort());
  for (const [index, fixture] of fixtureCases.entries()) {
    const item = report.cases[index], expectedResult = fixture.expected ?? {
      stdout: fixture.stdout, stderr: fixture.stderr, exitCode: fixture.exitCode,
    };
    assert.equal(item.status, 'passed'); assert.deepEqual(item.request, fixture.request);
    assert.deepEqual(item.run, fixture.run ?? {}); assert.deepEqual(item.expected, expectedResult);
    assert.equal(item.observations.escapedException, null, 'Escaping VM exceptions cannot prove GNU terminate');
    assert.equal(item.observations.stdout, expectedResult.stdout);
    assert.equal(item.observations.stderr, expectedResult.stderr ?? '');
    assert.equal(item.observations.exitCode, expectedResult.exitCode);
    assert.equal(item.units.length, 1 + (fixture.request.sources?.length ?? 0));
  }
}

async function currentContext(expected) {
  for (const key of ['work', 'sdk', 'sysroot', 'gccSource', 'sourceLockSha256', 'nativeBuild'])
    assert(expected[key], 'Missing exception context ' + key);
  const work = path.resolve(expected.work), sdk = path.resolve(expected.sdk), sysroot = path.resolve(expected.sysroot);
  const native = JSON.parse(await read(expected.nativeBuild, path.join(work, 'native-build.json')));
  assert.deepEqual(native.gccSource, expected.gccSource);
  assert.equal(native.sourceLockSha256, expected.sourceLockSha256);
  const lockBytes = await fs.readFile(path.join(here, 'sources.lock.json'));
  assert.equal(identity(lockBytes).sha256, expected.sourceLockSha256);
  const lock = JSON.parse(lockBytes);
  for (const patch of [...lock.gcc.patches, ...lock.wabt.patches])
    assert.equal((await identify(path.join(here, patch.path))).sha256, patch.sha256);
  for (const name of ['cc1', 'cc1plus', 'xgcc'])
    assert.equal((await identify(path.join(work, 'gcc-native/gcc', name))).sha256, native.tools[name].sha256);
  return { ...expected, work, sdk, sysroot, native, node: expected.node ?? process.execPath };
}

async function checkBuildFiles(directory, report, context) {
  verifyExceptionRuntimeBuildMetadata(report, context);
  assert.equal(report.filePrefixMap.from, directory);
  await read(report.nativeBuild, path.join(context.work, 'native-build.json'));
  for (const [key, name] of [['recipe', 'build-libstdcxx.sh'], ['patch', 'patches/libstdcxx-wasi-config.patch'],
    ['exceptionPatch', 'patches/libstdcxx-wasi-eh-config.patch'], ['errnoPatch', 'patches/wasi-libc-errno.patch'],
    ['runtimeLock', 'runtime.lock.json'], ['sourceLock', 'sources.lock.json']])
    await checkContent(report[key], path.join(here, name));
  const timezone = JSON.parse(execFileSync('python3', [path.join(here, 'tzdb-runtime-state.py'), 'inspect',
    '--source', path.join(context.work, 'gcc'), '--runtime', directory, '--work', context.work, '--sdk', context.sdk],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }));
  assert.deepEqual(report.timezone, timezone, 'GNU timezone source, data, cache port or actual archive member changed');
  for (const name of ['cc1', 'cc1plus', 'xgcc']) assert.equal(report.nativeCompiler[name], context.native.tools[name].sha256);
  assert.deepEqual(sorted(await inventory(path.join(directory, 'sysroot'))), sorted(report.files));
  assert.deepEqual(sorted(await inventory(path.join(directory, 'licenses'))), sorted(report.licenses));
  assert.deepEqual(sorted(await inventory(path.join(directory, 'install/include'), true)),
    sorted(report.headers.map(record => ({ ...record, path: record.path.slice('include/'.length) }))));
  for (const record of report.inputs) await read(record);
  const inputCheckFile = path.join(directory, 'eh-build-input-check.json');
  await checkContent(report.inputCheck, inputCheckFile);
  const check = JSON.parse(await fs.readFile(inputCheckFile));
  assert.equal(check.status, 'passed'); assert.equal(check.inputsUnchanged, true);
  assert.equal(check.count, report.inputs.length);
  const snapshot = JSON.parse(await read(check.snapshot, path.join(directory, 'eh-build-inputs.json')));
  assert.deepEqual(snapshot.inputs, report.inputs);
  const pinned = JSON.parse(await fs.readFile(path.join(here, 'runtime.lock.json'))).exceptionHandling;
  await checkContent(pinned.unwinder, path.join(context.sdk, pinned.unwinder.sdkRelativePath));
  await checkContent(pinned.unwinder, path.join(directory, 'sysroot/lib/wasm32-wasi-eh/libunwind.a'));
  await checkContent(pinned.license, path.join(here, pinned.license.path));
  await checkContent(pinned.license, path.join(directory, 'licenses/libunwind-LICENSE.TXT'));
  for (const name of ['COPYING3', 'COPYING.RUNTIME']) {
    assert.deepEqual(await fs.readFile(path.join(directory, 'licenses', name)),
      await fs.readFile(path.join(context.work, 'gcc', name)));
  }
}

async function sourceCheck(context, directory, label, replay) {
  const checked = await run('python3', [path.join(here, 'prepare-source.py'), '--source', path.join(context.work, 'gcc')],
    directory, label, 600000);
  replay.commands.push(checked);
  assert.deepEqual(JSON.parse(await fs.readFile(checked.stdout.path)), context.gccSource);
}

async function objectFiles(directory) {
  const result = new Map();
  async function walk(current) {
    for (const name of (await fs.readdir(current)).sort()) {
      const file = path.join(current, name), stat = await fs.lstat(file);
      if (stat.isDirectory()) await walk(file);
      else if (stat.isFile() && name.endsWith('.o')) {
        // GNU's dual-ABI ios_failure target deliberately rewrites the real
        // compiler assembly to cxx11-ios_failure-lt.s before assembling it.
        const assembly = file.slice(0, -2) + (name === 'cxx11-ios_failure.o' ? '-lt.s' : '.s');
        if (await fs.stat(assembly).then(value => value.isFile(), () => false)) {
          const records = result.get(name) ?? [];
          records.push({ path: path.relative(directory, file), object: await identify(file), assembly: await identify(assembly) });
          result.set(name, records);
        }
      }
    }
  }
  await walk(directory); return result;
}

async function assemble(context, assembly, object, directory, label, replay) {
  replay.commands.push(await run(path.join(context.work, 'wabt-native/wat2wasm'),
    ['--enable-annotations', '--enable-exceptions', '-r', assembly, '-o', object], directory, label));
}

async function replayObject(original, fresh, directory, context, replay) {
  await fs.mkdir(directory, { recursive: true });
  const originalWat = await read(original.assembly), freshWat = await read(fresh.assembly);
  assertExceptionAssemblyReplay(originalWat, freshWat);
  const rawDirectory = path.join(directory, 'original'); await fs.mkdir(rawDirectory);
  const raw = path.join(rawDirectory, path.basename(original.object.path));
  await assemble(context, original.assembly.path, raw, rawDirectory, 'assemble', replay);
  assert.deepEqual(identity(await fs.readFile(raw)), content(original.object), 'Original WAT did not produce the recorded object');
  const canonical = [];
  for (const [label, bytes] of [['original', originalWat], ['fresh', freshWat]]) {
    const destination = path.join(directory, 'canonical-' + label); await fs.mkdir(destination);
    const wat = path.join(destination, path.basename(original.assembly.path));
    const object = path.join(destination, path.basename(original.object.path));
    await fs.writeFile(wat, canonicalExceptionAssembly(bytes));
    await assemble(context, wat, object, destination, 'assemble', replay);
    canonical.push(await identify(object));
  }
  assert.deepEqual(content(canonical[0]), content(canonical[1]), 'GNU EH canonical objects differ');
  return { original: original.object, fresh: fresh.object, raw: await identify(raw), canonical };
}

// A fresh real GNU configure/make build is required. Rehashing a claimed
// archive alone cannot establish that every library object enables EH.
export async function reopenExceptionRuntimeBuild(directory, expected) {
  const context = await currentContext(expected);
  assert(expected.gccCxxSysroot, 'Current default GNU headers are required');
  directory = path.resolve(directory);
  const reportFile = path.join(directory, 'build.json'), report = JSON.parse(await fs.readFile(reportFile));
  await checkBuildFiles(directory, report, context);
  const defaultHeaders = await inventory(path.join(path.resolve(expected.gccCxxSysroot), 'include/c++'), true);
  assert.deepEqual(sorted(defaultHeaders), sorted(report.headers.map(record => ({ ...record, path: record.path.slice('include/c++/'.length) }))),
    'EH GNU headers differ from the installed default headers');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gcc-wasi-eh-build-replay-'));
  const replay = { status: 'running', directory: temporary, commands: [], objects: [], archives: [] };
  try {
    await sourceCheck(context, temporary, 'source-before', replay);
    const freshDirectory = path.join(temporary, 'fresh');
    replay.commands.push(await run('/usr/bin/env', [
      'GCC_WASI_WORK_DIR=' + context.work, 'WASI_SDK_PATH=' + context.sdk,
      'GCC_LIBSTDCXX_WORK_DIR=' + freshDirectory, 'GCC_WASI_JOBS=2',
      'bash', path.join(here, 'build-libstdcxx.sh'), '--exceptions'], temporary, 'build', 3600000));
    const fresh = JSON.parse(await fs.readFile(path.join(freshDirectory, 'build.json')));
    await checkBuildFiles(freshDirectory, fresh, context);
    assert.deepEqual(report.inputs, fresh.inputs, 'Full EH input inventory changed');
    assert.deepEqual(report.headers, fresh.headers);
    assert.deepEqual(report.licenses, fresh.licenses);
    const oldObjects = await objectFiles(path.join(directory, 'build'));
    const newObjects = await objectFiles(path.join(freshDirectory, 'build'));
    const replayed = new Map();
    for (const name of ['libstdc++.a', 'libsupc++.a']) {
      const archives = [directory, freshDirectory].map(root => path.join(root, 'sysroot/lib/wasm32-wasi-eh', name));
      const lists = [];
      for (const [index, archive] of archives.entries()) {
        const receipt = await run(path.join(context.sdk, 'bin/llvm-ar'), ['t', archive], temporary, name + '-list-' + index);
        replay.commands.push(receipt); lists.push((await fs.readFile(receipt.stdout.path, 'utf8')).trim().split('\n'));
      }
      assert.deepEqual(lists[0], lists[1], 'GNU archive member inventory changed');
      assert(lists[0].length >= 60); assert.equal(new Set(lists[0]).size, lists[0].length, 'Duplicate archive members');
      assert(lists[0].every(member => /^[A-Za-z0-9_.+-]+\.o$/u.test(member)), 'Unexpected GNU archive member name');
      for (const [index, member] of lists[0].entries()) {
        const pair = [];
        for (const [side, archive] of archives.entries()) {
          const extracted = await run(path.join(context.sdk, 'bin/llvm-ar'), ['p', archive, member], temporary,
            name + '-member-' + index + '-' + side);
          replay.commands.push(extracted);
          const objects = side ? newObjects : oldObjects;
          // libtool assigns ltN- archive member names when convenience
          // archives contain the same basename. Bind by exact member bytes;
          // do not guess the source from that generated prefix.
          const candidates = [...(objects.get(member) ?? []), ...[...objects.values()].flat()];
          const found = candidates.find(candidate => candidate.object.sha256 === extracted.stdout.sha256
            && candidate.object.bytes === extracted.stdout.bytes);
          assert(found, 'Archive member is not a retained real GNU object: ' + member); pair.push(found);
        }
        assert.equal(pair[0].path, pair[1].path);
        if (!replayed.has(pair[0].path)) {
          const result = await replayObject(pair[0], pair[1], path.join(temporary, 'objects', String(replayed.size)), context, replay);
          replayed.set(pair[0].path, result); replay.objects.push({ path: pair[0].path, ...result });
        }
      }
      replay.archives.push({ name, original: await identify(archives[0]), fresh: await identify(archives[1]), members: lists[0] });
    }
    await sourceCheck(context, temporary, 'source-after', replay);
    replay.status = 'passed';
    const result = { status: 'built-unverified', profile: report.profile, fullGnuLibrary: true,
      gccSource: context.gccSource, nativeBuild: report.nativeBuild, build: await identify(reportFile),
      directory, files: report.files, licenses: report.licenses, headers: report.headers,
      defaultHeadersIdentical: true, linkFlags: report.linkFlags,
      validators: await Promise.all(helperNames.map(name => identify(path.join(here, name)))) };
    const replayFile = path.join(temporary, 'reopen.json');
    await fs.writeFile(replayFile, JSON.stringify({ ...result, replayDetails: replay }, null, 2) + '\n');
    return { ...result, replay: await identify(replayFile) };
  } catch (error) {
    replay.status = 'failed'; replay.error = String(error.stack ?? error);
    await fs.writeFile(path.join(temporary, 'reopen.json'), JSON.stringify(replay, null, 2) + '\n'); throw error;
  }
}

function linkArguments(objects, program, context) {
  const base = path.join(context.sysroot, 'lib/wasm32-wasi');
  return ['--fatal-warnings', '--entry=_start', '--export=_start', ...exceptionRuntimeLinkFlags,
    '-z', 'stack-size=131072', '--initial-memory=4194304', '--max-memory=4194304',
    path.join(base, 'crt1-command.o'), ...objects,
    ...exceptionRuntimeFiles.map(file => path.join(context.runtime, 'sysroot', file)),
    ...['libm.a', 'libc.a', 'libclang_rt.builtins-wasm32.a'].map(name => path.join(base, name)), '-o', program];
}

async function inspectAndExecute(fixture, program, directory, context, replay) {
  const inspection = await run(path.join(context.work, 'wabt-native/wasm-objdump'), ['-x', '-d', program], directory, 'inspect');
  replay.commands.push(inspection);
  const text = await fs.readFile(inspection.stdout.path, 'utf8');
  assert(!/\|\s*(?:try|catch|catch_all|rethrow)(?:\s|$)/u.test(text), 'Legacy EH entered the GNU profile');
  assert.match(text, /Tag\[1\]:/u); assert.match(text, /\[\+\] exception-handling/u);
  assert.match(text, /\[\+\] multivalue/u);
  assert(!/__tls_base|__wasm_init_tls|__tls_size/u.test(text), 'Unexpected internal TLS dependency');
  const module = new WebAssembly.Module(await fs.readFile(program));
  assert(WebAssembly.Module.imports(module).every(item => item.kind === 'function' && item.module === 'wasi_snapshot_preview1'));
  await fs.writeFile(path.join(directory, 'stdin.txt'), fixture.run?.stdin ?? '');
  replay.commands.push(await run(context.node, ['--no-warnings', path.join(here, 'run-eh-program.mjs'),
    program, directory, ...(fixture.run?.args ?? [])], directory, 'run'));
  const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json')));
  const expected = fixture.expected ?? fixture;
  assert.equal(result.escapedException, null); assert.equal(result.stdout, expected.stdout);
  assert.equal(result.stderr, expected.stderr ?? ''); assert.equal(result.exitCode, expected.exitCode);
  return { inspection: inspection.stdout, result: await identify(path.join(directory, 'result.json')) };
}

export async function reopenExceptionRuntimeQualification(reportFile, expected) {
  const context = await currentContext(expected);
  assert(expected.runtime, 'A full EH runtime directory is required');
  context.runtime = path.resolve(expected.runtime);
  const buildFile = path.join(context.runtime, 'build.json'), buildIdentity = await identify(buildFile);
  if (expected.runtimeBuild) assert.deepEqual(content(expected.runtimeBuild), content(buildIdentity));
  context.runtimeBuild = buildIdentity;
  const build = JSON.parse(await fs.readFile(buildFile)); await checkBuildFiles(context.runtime, build, context);
  reportFile = path.resolve(reportFile);
  const originalDirectory = path.dirname(reportFile), report = JSON.parse(await fs.readFile(reportFile));
  verifyExceptionRuntimeExecutionMetadata(report, context);
  await read(report.nativeFixtures, path.join(here, 'eh-native-fixtures.mjs'));
  await read(report.runtimeBuild, buildFile);
  assert.deepEqual(report.files, build.files);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gcc-wasi-eh-runtime-replay-'));
  const replay = { status: 'running', directory: temporary, commands: [], cases: [] };
  try {
    const freshDirectory = path.join(temporary, 'fresh');
    replay.commands.push(await run('python3', [path.join(here, 'test-eh-runtime.py'),
      '--work', context.work, '--sdk', context.sdk, '--sysroot', context.sysroot,
      '--runtime', context.runtime, '--node', context.node, '--output', freshDirectory], temporary, 'compile-run', 1800000));
    const fresh = JSON.parse(await fs.readFile(path.join(freshDirectory, 'qualification.json')));
    verifyExceptionRuntimeExecutionMetadata(fresh, context);
    assert.deepEqual(report.inputs, fresh.inputs, 'EH execution input inventory changed');
    for (const item of report.inputs) await read(item);
    for (const [index, fixture] of fixtureCases.entries()) {
      const original = report.cases[index], next = fresh.cases[index];
      const directory = path.join(temporary, fixture.id); await fs.mkdir(directory);
      for (const file of fixture.request.files ?? []) {
        assert(!path.isAbsolute(file.path) && !file.path.split('/').includes('..'));
        assert.equal(await fs.readFile(path.join(originalDirectory, fixture.id, file.path), 'utf8'), file.contents,
          'Stored EH fixture input changed');
      }
      const originalProgram = path.join(originalDirectory, fixture.id, 'main.wasm');
      await read(original.program, originalProgram);
      const originalRun = path.join(directory, 'original-run'); await fs.mkdir(originalRun);
      const execution = await inspectAndExecute(fixture, originalProgram, originalRun, context, replay);
      const units = [];
      for (const [unitIndex, unit] of original.units.entries()) {
        const expectedSourceName = ['main.cpp', ...(fixture.request.sources ?? [])][unitIndex];
        const source = await read(unit.source, path.join(originalDirectory, fixture.id, expectedSourceName));
        const expectedSource = unitIndex ? fixture.request.files.find(file => file.path === expectedSourceName).contents : fixture.request.code;
        assert.equal(source.toString('utf8'), expectedSource);
        await read(unit.assembly, path.join(originalDirectory, fixture.id, `unit${unitIndex}.wat`));
        await read(unit.object, path.join(originalDirectory, fixture.id, `unit${unitIndex}.o`));
        units.push(await replayObject(unit, next.units[unitIndex], path.join(directory, 'unit' + unitIndex), context, replay));
      }
      const products = [];
      for (const [label, objects] of [
        ['original', units.map(unit => unit.raw.path)],
        ['canonical-original', units.map(unit => unit.canonical[0].path)],
        ['canonical-fresh', units.map(unit => unit.canonical[1].path)],
      ]) {
        const destination = path.join(directory, label); await fs.mkdir(destination);
        const program = path.join(destination, 'main.wasm');
        replay.commands.push(await run(path.join(context.sdk, 'bin/wasm-ld'), linkArguments(objects, program, context), destination, 'link'));
        products.push(await identify(program));
        if (label !== 'original') await inspectAndExecute(fixture, program, destination, context, replay);
      }
      assert.deepEqual(content(products[0]), content(original.program), 'Original object link did not reproduce the stored program');
      assert.deepEqual(content(products[1]), content(products[2]), 'EH canonical programs differ');
      replay.cases.push({ id: fixture.id, status: 'passed', execution, units, products });
    }
    replay.status = 'passed'; replay.freshQualification = await identify(path.join(freshDirectory, 'qualification.json'));
    const result = { status: 'passed', profile: 'ordinary-private-modern', fullGnuLibrary: true,
      gccSource: context.gccSource, nativeBuild: report.nativeBuild, runtimeBuild: buildIdentity,
      files: report.files, counts: report.counts, qualification: await identify(reportFile),
      nativeFixtures: report.nativeFixtures, nativeCaseIds: report.nativeCaseIds,
      validators: await Promise.all(helperNames.map(name => identify(path.join(here, name)))) };
    const replayFile = path.join(temporary, 'reopen.json');
    await fs.writeFile(replayFile, JSON.stringify({ ...result, replayDetails: replay }, null, 2) + '\n');
    return { ...result, replay: await identify(replayFile) };
  } catch (error) {
    replay.status = 'failed'; replay.error = String(error.stack ?? error);
    await fs.writeFile(path.join(temporary, 'reopen.json'), JSON.stringify(replay, null, 2) + '\n'); throw error;
  }
}
