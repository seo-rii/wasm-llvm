#!/usr/bin/env node
// Qualify both actual wat2wasm hosts, including the fork's table relocations.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = resolve(process.env.GCC_WASI_WORK_DIR ?? `${repository}/out/gcc-wasi-work`);
const linker = process.env.GCC_WASI_WASM_LD;
assert.ok(linker, 'Set GCC_WASI_WASM_LD to the native wasm-ld executable');
const native = resolve(work, 'wabt-native');
const browser = resolve(work, 'wabt-browser');
const nativeOnly = process.argv.includes('--native-only');
const temp = await mkdtemp(resolve(tmpdir(), 'gcc-wasi-wabt-'));
const sources = {
  'answer.wat': `(module
    (func $answer (@sym (name "answer")) (result i32)
      i32.const 42))`,
  'caller.wat': `(module
    (import "env" "__indirect_function_table" (table 0 funcref))
    (import "env" "answer" (func $answer (@sym (name "answer")) (result i32)))
    (func $run (@sym (name "run")) (result i32)
      i32.const 0 (@reloc functable $answer)
      call_indirect (result i32)))`,
};
const makeModule = nativeOnly ? null : (await import(pathToFileURL(resolve(browser, 'as.mjs')).href)).default;
const wasmBinary = nativeOnly ? null : await readFile(resolve(browser, 'as.wasm'));

async function assembleInModule(name, source) {
  const diagnostics = [];
  const module = await makeModule({
    wasmBinary, noInitialRun: true,
    print: (message) => diagnostics.push(String(message)),
    printErr: (message) => diagnostics.push(String(message)),
  });
  assert.equal(typeof module.FS.writeFile, 'function');
  assert.equal(typeof module.callMain, 'function');
  assert.ok(module.HEAPU8 instanceof Uint8Array);
  module.FS.writeFile(`/${name}`, source);
  let status = 0;
  try {
    status = module.callMain(['-r', '--enable-annotations', `/${name}`, '-o', '/output.o']) ?? 0;
  } catch (error) {
    if (typeof error?.status !== 'number') throw error;
    status = error.status;
  }
  assert.equal(status, 0, diagnostics.join('\n'));
  return module.FS.readFile('/output.o');
}

try {
  const outputs = nativeOnly ? { native: [] } : { native: [], browser: [] };
  for (const [name, source] of Object.entries(sources)) {
    const input = resolve(temp, name);
    const nativeObject = resolve(temp, `${name}.native.o`);
    const browserObject = resolve(temp, `${name}.browser.o`);
    await writeFile(input, source);
    execFileSync(resolve(native, 'wat2wasm'), ['-r', '--enable-annotations', input, '-o', nativeObject]);
    outputs.native.push(nativeObject);
    if (!nativeOnly) {
      const bytes = await assembleInModule(name, source);
      await writeFile(browserObject, bytes);
      assert.deepEqual(bytes.slice(0, 8), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      assert.deepEqual(Buffer.from(bytes), await readFile(nativeObject), `${name}: hosts must emit identical objects`);
      outputs.browser.push(browserObject);
    }
  }
  const dump = execFileSync(resolve(native, 'wasm-objdump'), ['-x', (outputs.browser ?? outputs.native)[1]], { encoding: 'utf8' });
  assert.match(dump, /R_WASM_TABLE_INDEX_SLEB/);
  assert.match(dump, /answer/);
  for (const [host, objects] of Object.entries(outputs)) {
    const output = resolve(temp, `${host}.wasm`);
    execFileSync(linker, ['--no-entry', '--export=run', '-o', output, ...objects]);
    execFileSync(resolve(native, 'wasm-validate'), [output]);
    const compiled = await WebAssembly.compile(await readFile(output));
    assert.deepEqual(WebAssembly.Module.imports(compiled), []);
    const instance = await WebAssembly.instantiate(compiled, {});
    assert.equal(instance.exports.run(), 42);
  }
  console.log(JSON.stringify({
    result: 'passed',
    hosts: Object.keys(outputs),
    nativeAndBrowserObjectsIdentical: nativeOnly ? null : true,
    tableRelocation: 'R_WASM_TABLE_INDEX_SLEB',
    linkedResult: 42,
    unresolvedImports: [],
  }, null, 2));
} finally {
  await rm(temp, { recursive: true, force: true });
}
