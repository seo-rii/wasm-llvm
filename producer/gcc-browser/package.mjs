#!/usr/bin/env node
// Reuse the GNU/Linux file and archive contract from the stacked Clang PR.
// Compiler-host libraries never enter the user's x86-64 target sysroot.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, identity, readNativeTree, validateGnuSysroot, validateProvenance } from '../clang-browser/cross/package.mjs';
import { directoryIdentity } from '../clang-browser/scripts/build-provenance.mjs';
import { deterministicTar } from '../clang-browser/scripts/package-language-sysroots.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const modules = ['cc1', 'cc1plus', 'as', 'ld'];
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

async function canonicalDestination(directory) {
  const suffix = [];
  let ancestor = path.resolve(directory);
  for (;;) {
    try { return path.join(await fs.realpath(ancestor), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
}

export async function packageGcc({ compiler, sysroot, provenance, output }) {
  compiler = await fs.realpath(compiler);
  sysroot = await fs.realpath(sysroot);
  const out = await canonicalDestination(output);
  assert(![compiler, sysroot].some(input => inside(input, out) || inside(out, input)), 'Output must not overlap input trees');
  const profileBytes = await fs.readFile(path.join(here, 'profile.json'));
  const profile = JSON.parse(profileBytes);
  const lockBytes = await fs.readFile(path.join(here, 'sources.lock.json'));
  const producer = JSON.parse(await fs.readFile(path.join(here, 'manifest.json')));
  assert.equal(producer.producerId, 'wasm-llvm/gcc-browser', 'Wrong producer identity');
  assert.equal(producer.sources.lock.sha256, digest(lockBytes), 'Producer source lock pin changed');
  const receiptBytes = await fs.readFile(path.join(compiler, 'compiler-build.json'));
  const receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.schemaVersion, 1, 'Unsupported compiler receipt');
  assert.equal(receipt.kind, 'gcc-build-receipt', 'Expected a GCC build receipt');
  for (const field of ['host', 'target', 'gccVersion']) assert.equal(receipt[field], profile[field], `Wrong compiler ${field}`);
  assert.equal(receipt.sourcesLockSha256, digest(lockBytes), 'Compiler sources differ from the pinned recipe');
  assert.deepEqual(receipt.resourceHeaders, await directoryIdentity(path.join(compiler, 'resource-include')), 'GCC resource headers changed after build');

  const provenanceBytes = await fs.readFile(provenance);
  const gnu = validateProvenance(JSON.parse(provenanceBytes));
  assert.equal(gnu.gccVersion, profile.gccMajor, 'GNU target installation must match GCC major');
  // Patched distro releases are recorded in source.packages. Their compiler's
  // upstream version must agree with the actual Wasm compiler, not just the ABI.
  assert.equal(gnu.compilerVersion, profile.gccVersion, 'GNU target libraries must match the compiler version');
  const files = await readNativeTree(sysroot);
  const layout = validateGnuSysroot(files, gnu);
  const resourceDir = `${layout.gccInstallation}/include`;
  const resources = await readNativeTree(path.join(compiler, 'resource-include'));
  for (const name of ['stddef.h', 'stdarg.h', 'limits.h', 'immintrin.h', 'avxintrin.h', 'avx2intrin.h', 'fmaintrin.h']) {
    assert(resources.some(file => file.path === name && file.bytes.length), `GCC internal headers lack ${name}`);
  }
  const occupied = new Set(files.map(file => file.path));
  const resourceFiles = resources.map(file => ({ ...file, path: `${resourceDir.slice('/sysroot/'.length)}/${file.path}` }));
  for (const file of resourceFiles) assert(!occupied.has(file.path), `GCC resource overlay would replace a target file: ${file.path}`);
  files.push(...resourceFiles);

  const assets = {};
  const payloads = [];
  for (const tool of modules) for (const [suffix, extension] of [['Js', 'mjs'], ['Wasm', 'wasm']]) {
    const key = `${tool}${suffix}`, name = `${tool}.${extension}`;
    const bytes = await fs.readFile(path.join(compiler, name));
    assert.deepEqual(identity(bytes), receipt.modules?.[key], `${name} differs from its compiler receipt`);
    if (extension === 'wasm') {
      assert.equal(bytes.subarray(0, 8).toString('hex'), '0061736d01000000', `${name} is not WebAssembly`);
      assert(WebAssembly.validate(bytes), `${name} is not a valid WebAssembly module`);
    } else {
      assert(bytes.length > 0 && /\bexport\b/.test(bytes.toString()), `${name} is not an ES module loader`);
    }
    assets[key] = { path: name, ...identity(bytes) };
    payloads.push({ path: name, bytes });
  }
  const notices = await readNativeTree(path.join(compiler, 'licenses'));
  assert(notices.length > 0, 'Compiler host dependency notices are required');
  const tar = deterministicTar(files);
  assets.sysroot = { path: 'sysroot.tar', ...identity(tar) };
  payloads.push({ path: assets.sysroot.path, bytes: tar });
  const inventory = files.map(file => ({ path: file.path, ...identity(file.bytes) }));
  const inventoryBytes = Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`);
  const noticeInventory = notices.map(file => ({ path: `licenses/${file.path}`, ...identity(file.bytes) }));
  const manifest = {
    schemaVersion: 1, kind: profile.id, host: profile.host, target: profile.target,
    compiler: { family: 'gcc', version: profile.gccVersion },
    cpuProfiles: profile.cpuProfiles, linkMode: profile.linkMode,
    sysrootPath: '/sysroot', gccInstallation: layout.gccInstallation, resourceDir,
    assets, fileCount: files.length,
    gnu: { gccVersion: gnu.gccVersion, compilerVersion: gnu.compilerVersion,
      glibcVersion: gnu.glibcVersion, distribution: gnu.distribution,
      source: 'gnu-provenance.json', licenses: gnu.licenseFiles },
    provenance: { compilerReceipt: { path: 'compiler-build.json', ...identity(receiptBytes) },
      gnuReceipt: { path: 'gnu-provenance.json', ...identity(provenanceBytes) },
      sources: { path: 'sources.lock.json', ...identity(lockBytes) },
      profile: { path: 'profile.json', ...identity(profileBytes) },
      inventory: { path: 'sysroot-files.json', ...identity(inventoryBytes) },
      resourceHeaders: receipt.resourceHeaders, hostLicenseFiles: noticeInventory },
    unsupported: profile.unsupported,
    qualification: { status: 'unverified', note: 'Packaging and ABI fixture tests do not qualify a compiler. Real Node, Chromium Worker and native Linux evidence must name these exact hashes.' }
  };
  // Reserve a new destination; a consumer cannot observe a manifest until all
  // modules, target files, receipts and license material have been written.
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.mkdir(out);
  payloads.push({ path: 'compiler-build.json', bytes: receiptBytes },
    { path: 'gnu-provenance.json', bytes: provenanceBytes },
    { path: 'sources.lock.json', bytes: lockBytes },
    { path: 'profile.json', bytes: profileBytes },
    { path: 'sysroot-files.json', bytes: inventoryBytes },
    ...notices.map(file => ({ path: `licenses/${file.path}`, bytes: file.bytes })));
  for (const file of payloads) {
    await fs.mkdir(path.dirname(path.join(out, file.path)), { recursive: true });
    await fs.writeFile(path.join(out, file.path), file.bytes, { flag: 'wx' });
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(out, 'gcc-toolchain.v1.json'), manifestBytes, { flag: 'wx' });
  return { manifestSha256: digest(manifestBytes), assets };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    assert(args.length === 8 && args[0] === '--compiler' && args[2] === '--sysroot' && args[4] === '--provenance' && args[6] === '--output',
      'Usage: node producer/gcc-browser/package.mjs --compiler DIR --sysroot DIR --provenance JSON --output NEW_DIR');
    console.log(JSON.stringify(await packageGcc({ compiler: args[1], sysroot: args[3], provenance: args[5], output: args[7] }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
