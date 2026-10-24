#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { directoryIdentity } from '../clang-browser/scripts/build-provenance.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = { '--compiler': 'compiler', '--work': 'work' }[process.argv[index]];
  assert(key && !options[key] && process.argv[index + 1], 'Expected --compiler DIR --work DIR');
  options[key] = path.resolve(process.argv[index + 1]);
}
assert(options.compiler && options.work, 'Expected --compiler DIR --work DIR');
const lockBytes = await fs.readFile(path.join(here, 'sources.lock.json'));
const lock = JSON.parse(lockBytes);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const modules = {};
for (const tool of ['cc1', 'cc1plus', 'as', 'ld']) {
  for (const [suffix, extension] of [['Js', 'mjs'], ['Wasm', 'wasm']]) {
    const bytes = await fs.readFile(path.join(options.compiler, `${tool}.${extension}`));
    assert(bytes.length > 1000, `Unexpected empty/small ${tool}.${extension}`);
    if (suffix === 'Wasm') assert(bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])), `${tool} is not WebAssembly`);
    modules[`${tool}${suffix}`] = { bytes: bytes.length, sha256: sha256(bytes) };
  }
}
const bootstrap = JSON.parse(await fs.readFile(path.join(options.work, 'gcc-bootstrap.status.json'), 'utf8'));
const receipt = {
  schemaVersion: 1, kind: 'gcc-build-receipt', host: lock.host, target: lock.target,
  gccVersion: lock.sources.gcc.version, binutilsVersion: lock.sources.binutils.version,
  sourcesLockSha256: sha256(lockBytes), modules,
  resourceHeaders: await directoryIdentity(path.join(options.compiler, 'resource-include')),
  licenses: await directoryIdentity(path.join(options.compiler, 'licenses')),
  build: {
    nativeCompiler: execFileSync('g++-13', ['-dumpfullversion'], { encoding: 'utf8' }).trim(),
    nativeGenerators: true, buildTriple: execFileSync('gcc-13', ['-dumpmachine'], { encoding: 'utf8' }).trim(),
    emsdkRevision: lock.emsdk.revision, emscriptenVersion: lock.emsdk.version,
    hostDependencies: ['gmp', 'mpfr', 'mpc'].map((name) => ({ name, ...lock.sources[name], role: 'compiler host only; WebAssembly' })),
    hostPorts: lock.emscriptenPorts,
    targetRuntime: 'separate real GNU/Linux x86-64 sysroot; not linked into compiler host',
    ...bootstrap
  },
  limits: ['no gcc/g++ fork/exec driver', 'no PCH', 'no plugins', 'no LTO', 'one C/C++ translation unit', 'static ELF only']
};
await fs.writeFile(path.join(options.compiler, 'compiler-build.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ gccVersion: receipt.gccVersion, target: receipt.target, modules }));
