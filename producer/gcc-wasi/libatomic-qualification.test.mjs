import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identity, expectedLibatomicMembers, expectedLibatomicSymbols,
  verifyLibatomicBuildMetadata, assertLibatomicAssemblyReplay, libatomicCompileArgs, reopenLibatomicBuild } from './libatomic-qualification.mjs';
import { cases } from './libatomic-fixtures.mjs';
import { sharedCases, assertSharedLibatomicResult } from './libatomic-shared-fixtures.mjs';

const hash = value => identity(Buffer.from(value));
function contract() {
  // Metadata-only contract fixture, never compiler or runtime evidence.
  const nativeBuild = { path: '/contract-only/native-build.json', ...hash('native') };
  const expected = { gccSource: { sourceDiffSha256: 'source' }, sourceLockSha256: hash('lock').sha256, nativeBuild };
  const definitions = { WORDSIZE: '8' };
  for (const operation of ['LDST', 'CAS', 'EXCHANGE', 'FETCH_ADD', 'FETCH_OP']) {
    for (const size of [1, 2, 4, 8, 16]) definitions[`HAVE_ATOMIC_${operation}_${size}`] = size === 16 ? '0' : '1';
  }
  const report = { schemaVersion: 1, kind: 'gcc-wasi-libatomic-build', status: 'built-unverified',
    target: 'wasm32-wasi', inputsUnchanged: true, gccSource: expected.gccSource,
    sourceLock: hash('lock'), nativeBuild,
    objects: expectedLibatomicMembers.map(member => ({ member })),
    archiveInspection: { publicSymbols: expectedLibatomicSymbols, recursiveCalls: false },
    configurationChecks: { definitions },
    licenses: ['COPYING3', 'COPYING.RUNTIME'].map(name => ({ installed: { path: '/contract-only/' + name } })),
    profile: { implementation: 'pinned-gnu-libatomic', atomics: true, lockFreeSizes: [1, 2, 4, 8],
      lockFreeAlignment: 'natural', lockFree16: false, sizedHelperAlignment: 'natural',
      genericRuntimeUnalignedFallback: true, genericBuiltinMaySpecialize: true,
      locks: { slots: 64, watchBytes: 64, slotBytes: 64, acquisition: 'unique-slots-ascending',
        release: 'descending', sharedBss: true, startup: 'single-shared-initialization' },
      pthread: false, tls: false, sharedRuntimeQualified: false },
  };
  return { report, expected };
}

test('build metadata retains built-unverified and complete actual GNU ABI inventory', () => {
  const { report, expected } = contract(); verifyLibatomicBuildMetadata(report, expected);
  assert.equal(expectedLibatomicMembers.length, 65); assert.equal(expectedLibatomicSymbols.length, 97);
});

for (const [name, mutate] of [
  ['execution promotion', r => { r.status = 'passed'; }],
  ['source mismatch', r => { r.gccSource = {}; }],
  ['compiler mismatch', r => { r.nativeBuild = { ...r.nativeBuild, ...hash('other') }; }],
  ['missing helper object', r => { r.objects.pop(); }],
  ['missing public helper', r => { r.archiveInspection.publicSymbols = r.archiveInspection.publicSymbols.slice(1); }],
  ['native 128 load claim', r => { r.configurationChecks.definitions.HAVE_ATOMIC_LDST_16 = '1'; }],
  ['recursive helper claim', r => { r.archiveInspection.recursiveCalls = true; }],
  ['128 lock-free claim', r => { r.profile.lockFree16 = true; }],
  ['misaligned lock-free claim', r => { r.profile.lockFreeAlignment = 'any'; }],
  ['worker-local locks', r => { r.profile.locks.sharedBss = false; }],
  ['per-worker reset', r => { r.profile.locks.startup = 'reset-each-instance'; }],
  ['unordered locking', r => { r.profile.locks.acquisition = 'address-order'; }],
  ['missing license', r => { r.licenses.pop(); }],
]) test(`build contract rejects ${name}`, () => {
  const { report, expected } = contract(); mutate(report);
  assert.throws(() => verifyLibatomicBuildMetadata(report, expected));
});

const assembly = `(module
  (import "env" "memcpy" (func $memcpy (@sym) (param i32 i32 i32) (result i32)))
  (import "env" "memcmp" (func $memcmp (@sym) (param i32 i32 i32) (result i32)))
  (memory 1)
  (func $body (result i32) i32.const 7)
)\n`;
test('GNU library replay accepts only complete import declaration ordering', () => {
  const lines = assembly.split('\n'), changed = [...lines]; [changed[1], changed[2]] = [changed[2], changed[1]];
  assertLibatomicAssemblyReplay(assembly, changed.join('\n'));
  for (const invalid of [assembly.replace('i32.const 7', 'i32.const 8'),
    assembly.replace('(param i32 i32 i32)', '(param i32 i32)'),
    assembly.replace(lines[1] + '\n', ''), assembly.replace(lines[1], lines[2]),
    assembly.replace('(@sym)', ''), assembly.replace('(memory 1)', '(memory 2)'),
    assembly.replace(lines[1], lines[1].replace(')))', '))\n  )'))]) {
    assert.throws(() => assertLibatomicAssemblyReplay(assembly, invalid));
  }
});

test('shared result validates both workers and the actual copied memory', () => {
  assert.equal(sharedCases.length, 16);
  for (const fixture of sharedCases) {
    const memory = new Uint8Array(256), view = new DataView(memory.buffer);
    fixture.expected.memory.values.forEach((value, i) => view.setUint32(128 + i * 4, value, true));
    assertSharedLibatomicResult(fixture, { values: [128, 128], memory });
    for (const values of [[-2, -2], [128], [128, 132], [127, 127], [256, 256]]) {
      assert.throws(() => assertSharedLibatomicResult(fixture, { values, memory }));
    }
    view.setUint32(128, fixture.expected.memory.values[0] - 1, true);
    assert.throws(() => assertSharedLibatomicResult(fixture, { values: [128, 128], memory }), /lost updates/);
  }
});

test('shared consumers omit the serial WASI header profile macro', () => {
  const context = { work: '/work', sysroot: '/runtime/sysroot' };
  const args = fixture => libatomicCompileArgs(fixture, '/input.c', '/output.wat', context);
  assert(cases.every(fixture => args(fixture).includes('-D__GCC_WASI_SINGLE_THREAD__=1')));
  assert(sharedCases.every(fixture => !args(fixture).some(arg => arg.includes('__GCC_WASI_SINGLE_THREAD__'))));
});

// On-disk metadata fixtures exercise the actual reopener up to its first replay
// directory allocation. They are path-validation tests, not GNU execution proof.
async function licensePathFixture(directory, alias) {
  const { report, expected } = contract();
  const work = path.join(directory, 'work'), sdk = path.join(directory, 'sdk');
  const sysroot = path.join(directory, 'runtime/sysroot');
  const output = path.join(directory, 'libatomic');
  const source = alias ? path.join(directory, 'physical-source') : path.join(work, 'gcc');
  const record = async file => ({ path: file, ...identity(await fs.readFile(file)) });
  const put = async (file, value) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
    return record(file);
  };
  await fs.mkdir(source, { recursive: true });
  if (alias) {
    await fs.mkdir(work, { recursive: true });
    await fs.symlink(source, path.join(work, 'gcc'), 'dir');
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  report.inputs = [];
  report.recipes = Object.fromEntries(await Promise.all(['build-libatomic.py', 'prepare-source.py']
    .map(async name => [name, await record(path.join(here, name))])));
  report.sourceLock = await record(path.join(here, 'sources.lock.json'));
  report.runtimeLock = await record(path.join(here, 'runtime.lock.json'));
  expected.sourceLockSha256 = report.sourceLock.sha256;
  report.nativeCompiler = Object.fromEntries(await Promise.all(['cc1', 'cc1plus', 'xgcc']
    .map(async name => [name, await put(path.join(work, 'gcc-native/gcc', name), 'fixture ' + name)])));
  report.nativeBuild = await put(path.join(work, 'native-build.json'), JSON.stringify({
    gccSource: expected.gccSource, sourceLockSha256: expected.sourceLockSha256,
    tools: report.nativeCompiler,
  }));
  expected.nativeBuild = report.nativeBuild;
  Object.assign(expected, { work, sdk, sysroot });
  const tools = { assembler: path.join(work, 'wabt-native/wat2wasm'),
    validator: path.join(work, 'wabt-native/wasm-validate'), objdump: path.join(work, 'wabt-native/wasm-objdump'),
    ar: path.join(sdk, 'bin/llvm-ar'), nm: path.join(sdk, 'bin/llvm-nm'),
    ranlib: path.join(sdk, 'bin/llvm-ranlib'), linker: path.join(sdk, 'bin/wasm-ld'),
    make: path.join(directory, 'make'), python: path.join(directory, 'python'), shell: path.join(directory, 'shell') };
  report.tools = Object.fromEntries(await Promise.all(Object.entries(tools)
    .map(async ([name, file]) => [name, await put(file, 'fixture ' + name)])));
  report.runtimeImport = await put(path.join(sysroot, '../runtime-build.json'), JSON.stringify({
    runtimeLock: { bytes: report.runtimeLock.bytes, sha256: report.runtimeLock.sha256 }, files: [],
  }));
  report.runtimeLibraries = Object.fromEntries(await Promise.all(
    ['crt1-command.o', 'libc.a', 'libm.a', 'libclang_rt.builtins-wasm32.a']
      .map(async name => [name, await put(path.join(sysroot, 'lib/wasm32-wasi', name), 'fixture ' + name)])));
  Object.assign(report, { resourceHeaders: [], librarySources: [], configureSupport: [], driver: [], configuration: {} });
  report.library = await put(path.join(output, 'sysroot/lib/wasm32-wasi/libatomic.a'), 'fixture archive');
  report.files = [{ path: 'lib/wasm32-wasi/libatomic.a', bytes: report.library.bytes, sha256: report.library.sha256 }];
  report.licenses = await Promise.all(['COPYING3', 'COPYING.RUNTIME'].map(async name => ({
    source: await put(path.join(source, name), 'fixture license ' + name),
    installed: await put(path.join(output, 'licenses', name), 'fixture license ' + name),
  })));
  return { report, expected, output, record };
}

for (const alias of [false, true]) test(`libatomic license paths admit ${alias ? 'physical source behind a work/gcc alias' : 'direct source directory'}`, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libatomic-license-path-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { report, expected, output } = await licensePathFixture(directory, alias);
  await fs.writeFile(path.join(output, 'build.json'), JSON.stringify(report));
  const stop = new Error('metadata accepted; stop before replay');
  let replayReached = false;
  t.mock.method(fs, 'mkdtemp', async prefix => {
    assert.equal(prefix, path.join(os.tmpdir(), 'gcc-libatomic-replay-'));
    replayReached = true;
    throw stop;
  });
  await assert.rejects(reopenLibatomicBuild(output, expected), error => error === stop);
  assert.equal(replayReached, true);
});

for (const mutation of ['same bytes at another source path', 'lexical alias substituted for recorded physical path', 'changed license bytes']) {
  test(`libatomic license paths still reject ${mutation}`, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libatomic-license-path-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const { report, expected, output, record } = await licensePathFixture(directory, true);
    const license = report.licenses[0];
    if (mutation === 'same bytes at another source path') {
      const replacement = path.join(directory, 'substitute-COPYING3');
      await fs.copyFile(license.source.path, replacement);
      license.source = await record(replacement);
    } else if (mutation === 'lexical alias substituted for recorded physical path') {
      license.source.path = path.join(expected.work, 'gcc/COPYING3');
    } else {
      await fs.appendFile(license.source.path, 'changed');
    }
    await fs.writeFile(path.join(output, 'build.json'), JSON.stringify(report));
    t.mock.method(fs, 'mkdtemp', async () => { assert.fail('Invalid license evidence reached replay'); });
    await assert.rejects(reopenLibatomicBuild(output, expected),
      mutation === 'changed license bytes' ? /Changed libatomic evidence/ : /Unexpected evidence path/);
  });
}
