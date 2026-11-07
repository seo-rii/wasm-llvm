import assert from 'node:assert/strict';
import test from 'node:test';
import { identity, expectedLibatomicMembers, expectedLibatomicSymbols,
  verifyLibatomicBuildMetadata, assertLibatomicAssemblyReplay, libatomicCompileArgs } from './libatomic-qualification.mjs';
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
