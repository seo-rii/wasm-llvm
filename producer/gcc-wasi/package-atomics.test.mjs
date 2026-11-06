import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { identity } from '../clang-browser/cross/package.mjs';
import { packageWasi, verifyAtomicsPackageOptions, qualifiedAtomicsManifestProfile } from './package.mjs';

const patches = ['0023-atomics.patch', '0024-libatomic-wasm.patch'].map(name => ({ path: `patches/${name}` }));
const options = Object.fromEntries(['atomicsQualification', 'libatomic', 'libatomicQualification', 'nativeLinker']
  .map(name => [name, `/qualified/${name}`]));

test('atomics source cannot be packaged without independent compiler and GNU runtime gates', () => {
  verifyAtomicsPackageOptions(patches, options);
  for (const name of Object.keys(options)) {
    const incomplete = { ...options }; delete incomplete[name];
    assert.throws(() => verifyAtomicsPackageOptions(patches, incomplete), new RegExp(name));
  }
  assert.throws(() => verifyAtomicsPackageOptions(patches.slice(0, 1), options), /locked Wasm runtime port/);
  assert.throws(() => verifyAtomicsPackageOptions([], options), /locked native backend/);
  verifyAtomicsPackageOptions([], {});
});

function reviewed() {
  // Synthetic admission boundary records; actual source/build execution is
  // covered by reopenNativeAtomicsQualification and the GNU runtime replays.
  const gccSource = { gccCommit: 'a'.repeat(40), sourceDiffSha256: 'b'.repeat(64) };
  const nativeBuild = { path: '/qualified/native-build.json', ...identity(Buffer.from('measured native build')) };
  const archive = { path: '/qualified/libatomic.a', ...identity(Buffer.from('measured GNU runtime')) };
  return {
    native: { status: 'passed', gccSource, nativeBuild },
    runtime: { build: { status: 'built-unverified', gccSource, nativeBuild, archive },
      execution: { status: 'passed', gccSource, archive }, runtimeLibrary: '/sysroot/lib/wasm32-wasi/libatomic.a' }
  };
}

test('only matching compiler and runtime evidence advertises atomics and its one provider', () => {
  const value = reviewed(), profile = qualifiedAtomicsManifestProfile(value.native, value.runtime);
  assert.deepEqual(profile.capabilities, { atomics: true, sharedMemory: true });
  assert.deepEqual(profile.runtimeLibraries, ['/sysroot/lib/wasm32-wasi/libatomic.a']);
  assert.equal(Object.hasOwn(profile.capabilities, 'threads'), false);
  assert.deepEqual(qualifiedAtomicsManifestProfile(), { capabilities: {}, runtimeLibraries: [], limitations: [] });
});

for (const [name, mutate] of [
  ['missing compiler proof', value => { value.native = undefined; }],
  ['missing runtime proof', value => { value.runtime = undefined; }],
  ['unverified compiler', value => { value.native.status = 'unverified'; }],
  ['unverified runtime execution', value => { value.runtime.execution.status = 'unverified'; }],
  ['another runtime source', value => { value.runtime.build.gccSource = { ...value.runtime.build.gccSource, sourceDiffSha256: 'c'.repeat(64) }; }],
  ['another executed source', value => { value.runtime.execution.gccSource = { ...value.runtime.execution.gccSource, gccCommit: 'c'.repeat(40) }; }],
  ['another compiler binary receipt', value => { value.runtime.build.nativeBuild = { ...value.runtime.build.nativeBuild, sha256: 'c'.repeat(64) }; }],
  ['another runtime archive', value => { value.runtime.execution.archive = { ...value.runtime.execution.archive, sha256: 'c'.repeat(64) }; }],
  ['another provider path', value => { value.runtime.runtimeLibrary = '/sysroot/lib/libatomic.a'; }]
]) test(`atomics admission rejects ${name}`, () => {
  const value = reviewed(); mutate(value);
  assert.throws(() => qualifiedAtomicsManifestProfile(value.native, value.runtime));
});

test('package output cannot overwrite a native atomics qualification through a parent alias', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'package-atomics-isolation-'));
  try {
    const work = path.join(root, 'work'), runtime = path.join(root, 'runtime');
    const output = path.join(root, 'bundle');
    for (const directory of [work, runtime, output]) await fs.mkdir(directory);
    const proof = path.join(output, 'native-atomics.json'); await fs.writeFile(proof, '{}');
    const alias = path.join(root, 'alias'); await fs.symlink(root, alias, 'dir');
    await assert.rejects(packageWasi({ work, runtime, output: path.join(alias, 'bundle'), atomicsQualification: proof }), /Output must not overlap/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
