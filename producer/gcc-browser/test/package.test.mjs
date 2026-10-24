import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { digest, identity } from '../../clang-browser/cross/package.mjs';
import { directoryIdentity } from '../../clang-browser/scripts/build-provenance.mjs';
import { readTarEntries } from '../../../scripts/lib/tar.mjs';
import { packageGcc } from '../package.mjs';

// Structural fixture tests only: these bytes cannot compile any user program.
const producer = fileURLToPath(new URL('../', import.meta.url));
const synthetic = Buffer.from('synthetic fixture; NOT a production GNU header or library\n');
function elf() {
  const bytes = Buffer.alloc(64);
  Buffer.from('7f454c46020101', 'hex').copy(bytes);
  bytes.writeUInt16LE(1, 16); bytes.writeUInt16LE(62, 18);
  return bytes;
}
function archive() {
  const bytes = elf(), header = Buffer.alloc(60, 32);
  header.write('fixture.o/'); header.write(String(bytes.length), 48); header.write('`\n', 58);
  return Buffer.concat([Buffer.from('!<arch>\n'), header, bytes]);
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gcc-package-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const compiler = path.join(root, 'compiler'), sysroot = path.join(root, 'sysroot');
  const write = async (dir, name, bytes) => {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  };
  const gcc = 'usr/lib/gcc/x86_64-linux-gnu/13', cpp = 'usr/include/c++/13';
  const files = [
    'usr/include/stdio.h', 'usr/include/stdlib.h', 'usr/include/features.h',
    'usr/include/limits.h', 'usr/include/stdint.h', `${cpp}/vector`,
    `${cpp}/ext/pb_ds/assoc_container.hpp`, `${cpp}/ext/pb_ds/detail/rb_tree_map_/rb_tree_.hpp`,
    `${cpp}/ext/pb_ds/detail/tree_policy/order_statistics_imp.hpp`,
    'usr/include/x86_64-linux-gnu/c++/13/bits/c++config.h',
    'usr/include/x86_64-linux-gnu/c++/13/bits/stdc++.h', 'usr/share/doc/libc/copyright'
  ].map(name => ({ path: name, bytes: synthetic }));
  for (const name of [`${gcc}/crtbeginT.o`, `${gcc}/crtend.o`,
    ...['crt1.o', 'crti.o', 'crtn.o'].map(name => `usr/lib/x86_64-linux-gnu/${name}`)]) files.push({ path: name, bytes: elf() });
  for (const name of [`${gcc}/libstdc++.a`, `${gcc}/libgcc.a`, `${gcc}/libgcc_eh.a`,
    'usr/lib/x86_64-linux-gnu/libc.a', 'usr/lib/x86_64-linux-gnu/libm.a']) files.push({ path: name, bytes: archive() });
  for (const file of files) await write(sysroot, file.path, file.bytes);
  const provenance = { schemaVersion: 1, target: 'x86_64-linux-gnu', gccVersion: '13', compilerVersion: '13.3.0',
    glibcVersion: '2.39', distribution: 'synthetic packaging fixture',
    sources: [{ url: 'https://example.invalid/gnu-source', sha256: digest('fixture') }],
    licenseFiles: ['usr/share/doc/libc/copyright'] };
  const provenancePath = path.join(root, 'gnu.json');
  await fs.writeFile(provenancePath, JSON.stringify(provenance));
  for (const name of ['stddef.h', 'stdarg.h', 'limits.h', 'syslimits.h', 'stdint.h', 'immintrin.h', 'avxintrin.h', 'avx2intrin.h', 'fmaintrin.h'])
    await write(compiler, `resource-include/${name}`, synthetic);
  await write(compiler, 'licenses/fixture.txt', synthetic);
  const modules = {};
  for (const name of ['cc1', 'cc1plus', 'as', 'ld']) for (const [suffix, extension, bytes] of [
    ['Js', 'mjs', Buffer.from('export default () => { throw new Error("fixture is not a compiler"); };')],
    ['Wasm', 'wasm', Buffer.from('0061736d01000000', 'hex')]
  ]) { await write(compiler, `${name}.${extension}`, bytes); modules[`${name}${suffix}`] = identity(bytes); }
  const receipt = { schemaVersion: 1, kind: 'gcc-build-receipt', gccVersion: '13.3.0',
    host: 'wasm32-emscripten', target: 'x86_64-linux-gnu', modules,
    sourcesLockSha256: digest(await fs.readFile(path.join(producer, 'sources.lock.json'))),
    resourceHeaders: await directoryIdentity(path.join(compiler, 'resource-include')) };
  const receiptPath = path.join(compiler, 'compiler-build.json');
  await fs.writeFile(receiptPath, JSON.stringify(receipt));
  return { compiler, sysroot, provenance: provenancePath, output: path.join(root, 'bundle'), root, receipt, receiptPath };
}

test('synthetic ABI packaging preserves GNU provenance and stays unverified', async t => {
  const input = await fixture(t);
  const result = await packageGcc(input);
  const bytes = await fs.readFile(path.join(input.output, 'gcc-toolchain.v1.json'));
  const manifest = JSON.parse(bytes);
  assert.equal(result.manifestSha256, digest(bytes));
  assert.equal(manifest.qualification.status, 'unverified');
  assert.equal(manifest.host, 'wasm32-emscripten');
  assert.equal(manifest.target, 'x86_64-linux-gnu');
  assert.deepEqual(manifest.cpuProfiles, ['x86-64', 'avx2-fma']);
  for (const entry of Object.values(manifest.assets))
    assert.deepEqual(identity(await fs.readFile(path.join(input.output, entry.path))), { bytes: entry.bytes, sha256: entry.sha256 });
  assert((await fs.readFile(path.join(input.output, 'gnu-provenance.json'))).equals(await fs.readFile(input.provenance)));
  const tar = readTarEntries(await fs.readFile(path.join(input.output, 'sysroot.tar')));
  assert(tar.has('usr/lib/gcc/x86_64-linux-gnu/13/include/immintrin.h'));
  assert(![...tar.keys()].some(name => name.endsWith('.wasm') || name.endsWith('.mjs')));
  await assert.rejects(packageGcc(input), /EEXIST/);
});

test('changed host module is rejected before a manifest can appear', async t => {
  const input = await fixture(t);
  await fs.appendFile(path.join(input.compiler, 'cc1plus.mjs'), '\n// changed');
  await assert.rejects(packageGcc(input), /differs from its compiler receipt/);
  await assert.rejects(fs.access(input.output), /ENOENT/);
});

test('target libraries must match the actual GCC version', async t => {
  const input = await fixture(t);
  const provenance = JSON.parse(await fs.readFile(input.provenance));
  provenance.compilerVersion = '13.2.0';
  await fs.writeFile(input.provenance, JSON.stringify(provenance));
  await assert.rejects(packageGcc(input), /must match the compiler version/);
});

for (const name of ['usr/include/limits.h', 'usr/include/stdint.h']) {
  test(`the GCC wrappers require target ${name} before packaging`, async t => {
    const input = await fixture(t);
    await fs.rm(path.join(input.sysroot, name));
    await assert.rejects(packageGcc(input), new RegExp(`GNU sysroot is missing ${name.replaceAll('.', '\\.')}`));
    await assert.rejects(fs.access(input.output), /ENOENT/);
  });
}

test('source pins and resource headers are bound to the build receipt', async t => {
  const input = await fixture(t);
  input.receipt.sourcesLockSha256 = '0'.repeat(64);
  await fs.writeFile(input.receiptPath, JSON.stringify(input.receipt));
  await assert.rejects(packageGcc(input), /sources differ/);
  input.receipt.sourcesLockSha256 = digest(await fs.readFile(path.join(producer, 'sources.lock.json')));
  await fs.writeFile(input.receiptPath, JSON.stringify(input.receipt));
  await fs.appendFile(path.join(input.compiler, 'resource-include/immintrin.h'), 'changed');
  await assert.rejects(packageGcc(input), /headers changed/);
});

test('output aliases cannot overwrite either compiler or target tree', async t => {
  const input = await fixture(t);
  await fs.symlink(input.sysroot, path.join(input.root, 'alias'));
  await assert.rejects(packageGcc({ ...input, output: path.join(input.root, 'alias/out') }), /overlap/);
});
