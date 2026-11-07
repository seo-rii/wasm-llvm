import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { identity } from '../clang-browser/cross/package.mjs';
import { packageWasi, verifyTlsPackageOptions, qualifiedTlsManifestProfile, verifyTlsInstallation, tlsRuntimePaths, tlsRuntimeHeaderPath } from './package.mjs';

const patches = ['0025-tls.patch', '0026-wasm-tls-runtime.patch'].map(name => ({ path: `patches/${name}` }));
const options = Object.fromEntries(['tlsRuntime', 'tlsLibc', 'tlsQualification', 'tlsRuntimeQualification', 'libstdcxx', 'nativeLinker']
  .map(name => [name, `/qualified/${name}`]));
test('TLS packaging requires both source ports and independently qualified runtime/compiler inputs', () => {
  verifyTlsPackageOptions(patches, options); verifyTlsPackageOptions([], {});
  for (const name of Object.keys(options)) {
    const incomplete = { ...options }; delete incomplete[name];
    assert.throws(() => verifyTlsPackageOptions(patches, incomplete), new RegExp(name));
  }
  for (const incomplete of [[], patches.slice(0, 1), patches.slice(1)])
    assert.throws(() => verifyTlsPackageOptions(incomplete, options), /locked backend and GNU runtime/);
});

function reviewed() {
  // Admission/installation records only; actual compiler/runtime programs
  // must pass the independent replayers before reaching these boundaries.
  const gccSource = { gccCommit: 'a'.repeat(40), sourceDiffSha256: 'b'.repeat(64) };
  const nativeBuild = { path: '/qualified/native-build.json', ...identity(Buffer.from('measured native build')) };
  const runtimeBuild = { path: '/qualified/build.json', ...identity(Buffer.from('measured runtime build')) };
  const files = tlsRuntimePaths.map((name, index) => ({ path: name, bytes: Buffer.from(name === tlsRuntimeHeaderPath
    ? '#ifdef __cplusplus\nextern "C" { extern thread_local int errno; }\n#else\nextern _Thread_local int errno;\n#endif\n'
    : `!<arch>\nqualified archive ${index}`) }));
  const inventory = files.map(file => ({ path: file.path, ...identity(file.bytes) }));
  const licenses = ['GNU-COPYING3', 'GNU-COPYING.RUNTIME', 'wasi-libc-LICENSE'].map(name => ({ path: name, bytes: Buffer.from(`${name}\nfull notice\n`) }));
  const native = { status: 'passed', gccSource, nativeBuild };
  const validated = { native, build: { status: 'built-unverified', gccSource, nativeBuild, build: runtimeBuild,
    files: inventory, licenses: licenses.map(file => ({ path: file.path, ...identity(file.bytes) })) },
    execution: { status: 'passed', gccSource, nativeBuild, runtimeBuild, files: structuredClone(inventory) } };
  const sysroot = [{ path: 'lib/wasm32-wasi/libc.a', bytes: Buffer.from('!<arch>\noriginal ordinary libc') }];
  return { native, validated, files, licenses, sysroot };
}

test('TLS capability does not add providers to ordinary runtimeLibraries or claim threads', () => {
  const value = reviewed(), profile = qualifiedTlsManifestProfile(value.native, value.validated);
  assert.deepEqual(profile.capabilities, { tls: true });
  assert.equal(Object.hasOwn(profile, 'runtimeLibraries'), false);
  assert.deepEqual(qualifiedTlsManifestProfile(), { capabilities: {}, limitations: [] });
  const original = value.sysroot.map(file => ({ ...file, bytes: Buffer.from(file.bytes) }));
  verifyTlsInstallation(value.sysroot, value.files, value.licenses, value.validated);
  assert.deepEqual(value.sysroot, original, 'Admission must not replace the ordinary sysroot');
});

for (const [name, mutate] of [
  ['unverified compiler', v => { v.native.status = 'unverified'; }],
  ['unverified runtime execution', v => { v.validated.execution.status = 'unverified'; }],
  ['different runtime source', v => { v.validated.build.gccSource = { ...v.native.gccSource, sourceDiffSha256: 'c'.repeat(64) }; }],
  ['different executed source', v => { v.validated.execution.gccSource = { ...v.native.gccSource, gccCommit: 'c'.repeat(40) }; }],
  ['different native compiler build', v => { v.validated.build.nativeBuild = identity(Buffer.from('other compiler')); }],
  ['different executed compiler build', v => { v.validated.execution.nativeBuild = identity(Buffer.from('other compiler')); }],
  ['different runtime build', v => { v.validated.execution.runtimeBuild = identity(Buffer.from('other runtime')); }],
  ['missing provider', v => { v.files.pop(); }],
  ['missing archive', v => { v.files.shift(); }],
  ['changed TLS header', v => { v.files.find(file => file.path === tlsRuntimeHeaderPath).bytes = Buffer.from('extern int errno;\n'); }],
  ['existing TLS header path', v => { v.sysroot.push(v.files.find(file => file.path === tlsRuntimeHeaderPath)); }],
  ['duplicated provider', v => { v.files.push(v.files[0]); }],
  ['unqualified provider', v => { v.files.push({ path: 'lib/wasm32-wasi/libfake.a', bytes: Buffer.from('!<arch>\n') }); }],
  ['changed runtime bytes', v => { v.files[0].bytes = Buffer.from('!<arch>\nchanged'); }],
  ['changed executed inventory', v => { v.validated.execution.files[0].sha256 = 'c'.repeat(64); }],
  ['existing sysroot path', v => { v.sysroot.push(v.files[0]); }],
  ['missing full license', v => { v.licenses.pop(); }],
  ['changed full license', v => { v.licenses[0].bytes = Buffer.from('notice only'); }],
]) test(`TLS admission rejects ${name}`, () => {
  const v = reviewed(); mutate(v);
  assert.throws(() => verifyTlsInstallation(v.sysroot, v.files, v.licenses, v.validated));
});

test('matching hashes cannot admit a non-archive TLS provider', () => {
  const v = reviewed(); v.files[0].bytes = Buffer.from('not an archive');
  const record = { path: v.files[0].path, ...identity(v.files[0].bytes) };
  v.validated.build.files[0] = record; v.validated.execution.files[0] = record;
  assert.throws(() => verifyTlsInstallation(v.sysroot, v.files, v.licenses, v.validated), /actual static archives/);
});

test('package output cannot overwrite TLS build inputs or either qualification through an alias', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'package-tls-isolation-'));
  try {
    const work = path.join(root, 'work'), runtime = path.join(root, 'runtime'), tlsRuntime = path.join(root, 'tls');
    for (const directory of [work, runtime, tlsRuntime]) await fs.mkdir(directory);
    const alias = path.join(root, 'alias'); await fs.symlink(tlsRuntime, alias, 'dir');
    for (const field of ['tlsRuntime', 'tlsLibc'])
      await assert.rejects(packageWasi({ work, runtime, [field]: tlsRuntime, output: path.join(alias, 'bundle') }), /Output must not overlap/);
    const output = path.join(root, 'bundle'); await fs.mkdir(output);
    const proof = path.join(output, 'qualification.json'); await fs.writeFile(proof, '{}');
    for (const field of ['tlsQualification', 'tlsRuntimeQualification'])
      await assert.rejects(packageWasi({ work, runtime, output, [field]: proof }), /Output must not overlap/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
