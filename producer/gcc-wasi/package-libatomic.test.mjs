import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { identity } from '../clang-browser/cross/package.mjs';
import { packageWasi, verifyLibatomicPackageOptions, verifyLibatomicInstallation } from './package.mjs';

const patches = [{ path: 'patches/0024-libatomic-wasm.patch' }];
const complete = { libatomic: '/qualified/libatomic', libatomicQualification: '/qualified/runtime.json', nativeLinker: '/sdk/bin/wasm-ld' };

test('the GNU port requires both runtime and execution proof with a known linker', () => {
  verifyLibatomicPackageOptions(patches, complete);
  for (const key of Object.keys(complete)) {
    const options = { ...complete }; delete options[key];
    assert.throws(() => verifyLibatomicPackageOptions(patches, options), new RegExp(key));
  }
});

test('old patchless profiles remain unchanged and cannot opt into a missing GNU port', () => {
  verifyLibatomicPackageOptions([], {});
  assert.throws(() => verifyLibatomicPackageOptions([], complete), /locked Wasm runtime port/);
  assert.throws(() => verifyLibatomicPackageOptions([], { libatomic: complete.libatomic }), /libatomicQualification/);
  assert.throws(() => verifyLibatomicPackageOptions([], { libatomicQualification: complete.libatomicQualification }), /libatomic/);
});

function installation() {
  // Installation boundary test only, not an archive build/execution proof.
  const bytes = Buffer.from('!<arch>\narchive-for-installation-contract');
  const files = [{ path: 'lib/wasm32-wasi/libatomic.a', bytes }];
  const licenses = ['COPYING3', 'COPYING.RUNTIME'].map(name => ({ path: name, bytes: Buffer.from(name + '\nfull measured notice\n') }));
  const archive = { path: '/qualified/sysroot/lib/wasm32-wasi/libatomic.a', ...identity(bytes) };
  const validated = { build: { status: 'built-unverified', archive,
    licenses: Object.fromEntries(licenses.map(file => [file.path, { path: '/qualified/licenses/' + file.path, ...identity(file.bytes) }])) },
    execution: { status: 'passed', archive } };
  return { sysroot: [{ path: 'lib/wasm32-wasi/libc.a', bytes: Buffer.from('!<arch>\nlibc') }], files, licenses, validated };
}

test('installation includes exactly the validated archive and two complete licenses', () => {
  const value = installation();
  verifyLibatomicInstallation(value.sysroot, value.files, value.licenses, value.validated);
});

for (const [label, mutate] of [
  ['missing archive', value => { value.files = []; }],
  ['extra unqualified archive', value => { value.files.push({ path: 'lib/wasm32-wasi/libfake.a', bytes: Buffer.from('!<arch>\n') }); }],
  ['duplicate archive inventory', value => { value.files.push(value.files[0]); }],
  ['changed archive bytes', value => { value.files[0].bytes = Buffer.from('!<arch>\nchanged'); }],
  ['missing full license', value => { value.licenses.pop(); }],
  ['shortened license', value => { value.licenses[0].bytes = Buffer.from('notice only'); }],
  ['extra license file', value => { value.licenses.push({ path: 'README', bytes: Buffer.from('unbound') }); }],
  ['different execution archive', value => { value.validated.execution.archive = { path: '/other', ...identity(Buffer.from('different')) }; }],
  ['unverified runtime execution', value => { value.validated.execution.status = 'built-unverified'; }],
]) test(`installation rejects ${label}`, () => {
  const value = installation(); mutate(value);
  assert.throws(() => verifyLibatomicInstallation(value.sysroot, value.files, value.licenses, value.validated));
});

test('installation rejects an existing sysroot archive even when bytes match', () => {
  const value = installation(); value.sysroot.push(value.files[0]);
  assert.throws(() => verifyLibatomicInstallation(value.sysroot, value.files, value.licenses, value.validated), /Duplicate runtime sysroot path/);
});

test('self-consistent identities do not make a non-archive payload installable', () => {
  const value = installation(); value.files[0].bytes = Buffer.from('not a static archive');
  const archive = { path: value.validated.build.archive.path, ...identity(value.files[0].bytes) };
  value.validated.build.archive = archive; value.validated.execution.archive = archive;
  assert.throws(() => verifyLibatomicInstallation(value.sysroot, value.files, value.licenses, value.validated), /actual static archive/);
});

test('output isolation includes the new runtime directory and qualification file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'package-libatomic-isolation-'));
  try {
    const work = path.join(root, 'work'), runtime = path.join(root, 'runtime'), libatomic = path.join(root, 'atomic');
    for (const directory of [work, runtime, libatomic]) await fs.mkdir(directory);
    const proof = path.join(root, 'proof.json'); await fs.writeFile(proof, '{}');
    const options = { work, runtime, libatomic, libatomicQualification: proof, nativeLinker: '/sdk/bin/wasm-ld' };
    await assert.rejects(packageWasi({ ...options, output: path.join(libatomic, 'bundle') }), /Output must not overlap/);
    const alias = path.join(root, 'alias'); await fs.symlink(libatomic, alias, 'dir');
    await assert.rejects(packageWasi({ ...options, output: path.join(alias, 'bundle') }), /Output must not overlap/);
    const output = path.join(root, 'future-bundle'); await fs.mkdir(output);
    const nestedProof = path.join(output, 'qualification.json'); await fs.writeFile(nestedProof, '{}');
    await assert.rejects(packageWasi({ ...options, libatomicQualification: nestedProof, output }), /Output must not overlap/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
