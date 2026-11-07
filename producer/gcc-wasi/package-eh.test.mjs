import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { identity } from '../clang-browser/cross/package.mjs';
import { exceptionRuntimePaths, verifyExceptionPackageOptions,
  qualifiedExceptionManifestProfile, verifyExceptionInstallation, packageWasi } from './package.mjs';

const patches = ['0027-exception-handling.patch', '0028-wasm-eh-runtime.patch'].map(name => ({ path: `patches/${name}` }));
const options = { ehRuntime: '/eh', ehQualification: '/native.json', ehRuntimeQualification: '/runtime.json',
  libstdcxx: '/ordinary-gnu', nativeLinker: '/sdk/bin/wasm-ld' };

test('exception-capable packages require both implementation patches and native/full-runtime proofs', () => {
  verifyExceptionPackageOptions([], {});
  verifyExceptionPackageOptions(patches, options);
  for (const name of Object.keys(options)) {
    const incomplete = { ...options }; delete incomplete[name];
    assert.throws(() => verifyExceptionPackageOptions(patches, incomplete), new RegExp(name));
  }
  for (const incomplete of [[], patches.slice(0, 1), patches.slice(1)])
    assert.throws(() => verifyExceptionPackageOptions(incomplete, options), /locked backend and GNU runtime/);
});

function reviewed() {
  // Test admission records only. Actual builds and C++ programs must pass
  // independent source-bound replayers before reaching this package boundary.
  const gccSource = { gccCommit: 'a'.repeat(40), sourceDiffSha256: 'b'.repeat(64) };
  const nativeBuild = { path: '/qualified/native-build.json', ...identity(Buffer.from('native compiler')) };
  const runtimeBuild = { path: '/qualified/build.json', ...identity(Buffer.from('full GNU runtime')) };
  const files = exceptionRuntimePaths.map(name => ({ path: name, bytes: Buffer.from(`!<arch>\n${name}`) }));
  const inventory = files.map(file => ({ path: file.path, ...identity(file.bytes) }));
  const licenses = ['GNU-COPYING3', 'GNU-COPYING.RUNTIME', 'LLVM-libunwind'].map(name => ({ path: name, bytes: Buffer.from(`Full ${name} license fixture\n`) }));
  const nativeFixtures = { path: '/qualified/eh-native-fixtures.mjs', ...identity(Buffer.from('native fixture source')) };
  const nativeCaseIds = ['qualified-backend-case'];
  const native = { status: 'passed', gccSource, nativeBuild, nativeFixtures, nativeCaseIds };
  const validated = { native, build: { status: 'built-unverified', profile: 'ordinary-private-modern',
    fullGnuLibrary: true, defaultHeadersIdentical: true,
    linkFlags: ['--wrap=__main_void', '--wrap=__wasm_call_ctors', '--wrap=__wasm_call_dtors', '--wrap=exit'],
    gccSource, nativeBuild, build: runtimeBuild, files: inventory,
    licenses: licenses.map(file => ({ path: file.path, ...identity(file.bytes) })) },
    execution: { status: 'passed', profile: 'ordinary-private-modern', fullGnuLibrary: true,
      gccSource, nativeBuild, runtimeBuild, files: structuredClone(inventory),
      nativeFixtures: { ...nativeFixtures }, nativeCaseIds: [...nativeCaseIds] } };
  const sysroot = ['libc.a', 'libstdc++.a', 'libsupc++.a'].map(name => ({ path: `lib/wasm32-wasi/${name}`, bytes: Buffer.from(`!<arch>\noriginal ${name}`) }));
  const runtimeLock = { exceptionHandling: { profile: 'ordinary-private-modern',
    unwinder: identity(files[2].bytes), license: identity(licenses[2].bytes) } };
  return { native, validated, files, licenses, sysroot, runtimeLock };
}

test('EH archive admission preserves ordinary providers and the default manifest runtime list', () => {
  const v = reviewed(), original = v.sysroot.map(file => ({ ...file, bytes: Buffer.from(file.bytes) }));
  const profile = qualifiedExceptionManifestProfile(v.native, v.validated);
  assert.deepEqual(profile.capabilities, { exceptions: true });
  assert.equal(Object.hasOwn(profile, 'runtimeLibraries'), false);
  assert.deepEqual(qualifiedExceptionManifestProfile(), { capabilities: {}, limitations: [] });
  verifyExceptionInstallation(v.sysroot, v.files, v.licenses, v.validated, v.runtimeLock);
  assert.deepEqual(v.sysroot, original);
});

for (const [name, mutate] of [
  ['unverified native compiler', v => { v.native.status = 'unverified'; }],
  ['unverified full runtime', v => { v.validated.build.status = 'partial-reference'; }],
  ['reference-only runtime profile', v => { v.validated.build.profile = 'clang-reference'; }],
  ['unexecuted runtime', v => { v.validated.execution.status = 'unverified'; }],
  ['bootstrap archive', v => { v.validated.build.fullGnuLibrary = false; }],
  ['bootstrap execution', v => { v.validated.execution.fullGnuLibrary = false; }],
  ['different executed profile', v => { v.validated.execution.profile = 'shared-memory'; }],
  ['different public headers', v => { v.validated.build.defaultHeadersIdentical = false; }],
  ['different native fixtures', v => { v.validated.execution.nativeFixtures.sha256 = 'c'.repeat(64); }],
  ['missing native execution case', v => { v.validated.execution.nativeCaseIds.pop(); }],
  ['missing entry wrapper', v => { v.validated.build.linkFlags.pop(); }],
  ['different runtime source', v => { v.validated.build.gccSource = { ...v.native.gccSource, sourceDiffSha256: 'c'.repeat(64) }; }],
  ['different executed source', v => { v.validated.execution.gccSource = { ...v.native.gccSource, gccCommit: 'c'.repeat(40) }; }],
  ['different runtime compiler', v => { v.validated.build.nativeBuild = identity(Buffer.from('other compiler')); }],
  ['different executed compiler', v => { v.validated.execution.nativeBuild = identity(Buffer.from('other compiler')); }],
  ['different executed runtime', v => { v.validated.execution.runtimeBuild = identity(Buffer.from('other runtime')); }],
  ['missing provider', v => { v.files.pop(); }],
  ['duplicate provider', v => { v.files.push(v.files[0]); }],
  ['unqualified provider', v => { v.files.push({ path: 'lib/wasm32-wasi-eh/libc++abi.a', bytes: Buffer.from('!<arch>\n') }); }],
  ['changed archive', v => { v.files[0].bytes = Buffer.from('!<arch>\nother'); }],
  ['changed executed inventory', v => { v.validated.execution.files[0].sha256 = 'c'.repeat(64); }],
  ['existing provider path', v => { v.sysroot.push(v.files[0]); }],
  ['missing full license', v => { v.licenses.pop(); }],
  ['changed full license', v => { v.licenses[0].bytes = Buffer.from('notice only'); }],
  ['missing runtime pin', v => { delete v.runtimeLock.exceptionHandling; }],
  ['different pinned unwinder', v => { v.runtimeLock.exceptionHandling.unwinder.sha256 = 'd'.repeat(64); }],
  ['different pinned unwinder license', v => { v.runtimeLock.exceptionHandling.license.sha256 = 'd'.repeat(64); }],
]) test(`EH admission rejects ${name}`, () => {
  const v = reviewed(); mutate(v);
  assert.throws(() => verifyExceptionInstallation(v.sysroot, v.files, v.licenses, v.validated, v.runtimeLock));
});

test('matching inventories cannot admit text in place of a GNU static archive', () => {
  const v = reviewed(); v.files[0].bytes = Buffer.from('not a static archive');
  const record = { path: v.files[0].path, ...identity(v.files[0].bytes) };
  v.validated.build.files[0] = record; v.validated.execution.files[0] = record;
  assert.throws(() => verifyExceptionInstallation(v.sysroot, v.files, v.licenses, v.validated, v.runtimeLock), /actual static archives/);
});

test('package output cannot overwrite EH runtime or either proof through a symlink', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'package-eh-isolation-'));
  try {
    const work = path.join(root, 'work'), runtime = path.join(root, 'runtime'), ehRuntime = path.join(root, 'eh');
    for (const directory of [work, runtime, ehRuntime]) await fs.mkdir(directory);
    const alias = path.join(root, 'alias'); await fs.symlink(ehRuntime, alias, 'dir');
    await assert.rejects(packageWasi({ work, runtime, ehRuntime, output: path.join(alias, 'bundle') }), /Output must not overlap/);
    const output = path.join(root, 'bundle'); await fs.mkdir(output);
    const proof = path.join(output, 'qualification.json'); await fs.writeFile(proof, '{}');
    for (const field of ['ehQualification', 'ehRuntimeQualification'])
      await assert.rejects(packageWasi({ work, runtime, output, [field]: proof }), /Output must not overlap/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
