#!/usr/bin/env node
// Qualify real native-host GCC SIMD code generation, assembly, linking and WASI.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases, disabledCases, disabledDiagnostic } from './simd-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  assert(['compiler', 'source', 'work', 'sdk', 'sysroot', 'output', 'cases'].includes(key) && process.argv[i + 1], `Invalid argument ${process.argv[i]}`);
  options[key] = process.argv[i + 1];
}
for (const name of ['compiler', 'source', 'work', 'sdk', 'output']) assert(options[name], `Required --${name}`);
const compiler = path.resolve(options.compiler), source = path.resolve(options.source);
const work = path.resolve(options.work), sdk = path.resolve(options.sdk), output = path.resolve(options.output);
const sysroot = path.resolve(options.sysroot || path.join(work, 'runtime-single-thread/sysroot'));
const library = path.join(sysroot, 'lib/wasm32-wasi');
const builtins = path.join(sdk, 'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a');
const identity = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const identify = async name => identity(await fs.readFile(name));
function run(command, argv, input, cwd = output) {
  const result = spawnSync(command, argv, { input, cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  return { command, argv, status: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error?.message };
}
await fs.mkdir(output);
const revision = run('git', ['-C', source, 'rev-parse', 'HEAD']);
assert.equal(revision.status, 0, revision.stderr);
const lock = JSON.parse(await fs.readFile(path.join(here, 'sources.lock.json')));
assert.equal(revision.stdout.trim(), lock.gcc.commit);
const compilerIdentity = await identify(path.join(compiler, 'cc1'));
const targetSource = {};
for (const name of (await fs.readdir(path.join(source, 'gcc/config/wasm'))).sort())
  targetSource[name] = await identify(path.join(source, 'gcc/config/wasm', name));
const report = {
  kind: 'gcc-wasi-native-simd-qualification', status: 'running',
  gccCommit: lock.gcc.commit, targetSource, compiler: compilerIdentity,
  fixture: await identify(path.join(here, 'simd-fixtures.mjs')),
  testRecipe: await identify(fileURLToPath(import.meta.url)),
  assembler: await identify(path.join(work, 'wabt-native/wat2wasm')),
  linker: await identify(path.join(sdk, 'bin/wasm-ld')), cases: []
};
const runner = path.join(output, 'run-wasi.mjs');
await fs.writeFile(runner, `import { WASI } from 'node:wasi';
import { readFile } from 'node:fs/promises';
const wasi = new WASI({ version: 'preview1', args: ['program'], env: {}, returnOnExit: true });
const module = await WebAssembly.compile(await readFile(process.argv[2]));
const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
process.exitCode = wasi.start(instance);
`);
let fixtures = [...cases, ...disabledCases];
if (options.cases) {
  const ids = options.cases.split(',');
  assert(ids.every(id => fixtures.some(test => test.id === id)), 'Unknown SIMD fixture');
  fixtures = fixtures.filter(test => ids.includes(test.id));
}
const common = ['-quiet', '-std=gnu11', '-fdiagnostics-color=never', '-D__GCC_WASI_SINGLE_THREAD__=1', '-nostdinc',
  '-isystem', path.join(compiler, 'include'), '-isystem', path.join(sysroot, 'include/wasm32-wasi')];
for (const test of fixtures) {
  const entry = { id: test.id, status: 'running', commands: [] };
  report.cases.push(entry);
  const directory = path.join(output, test.id);
  await fs.mkdir(directory);
  try {
    const c = path.join(directory, 'main.c'), wat = path.join(directory, 'main.wat');
    const object = path.join(directory, 'main.o'), program = path.join(directory, 'main.wasm');
    await fs.writeFile(c, test.request.code);
    entry.source = await identify(c);
    function command(executable, argv, input) {
      const result = run(executable, argv, input, directory);
      entry.commands.push(result);
      assert.equal(result.status, 0, `${test.id}: ${result.stderr || result.error}`);
      return result;
    }
    command(path.join(compiler, 'cc1'), [...common, `-O${test.request.optimization}`,
      test.request.simd ? '-msimd128' : '-mno-simd128', c, '-o', wat]);
    const assembly = await fs.readFile(wat, 'utf8');
    command(path.join(work, 'wabt-native/wat2wasm'), ['-r', '--enable-annotations', wat, '-o', object]);
    const dumped = command(path.join(work, 'wabt-native/wasm-objdump'), ['-d', object]);
    await fs.writeFile(path.join(directory, 'object.disassembly.txt'), dumped.stdout);
    const metadata = new WebAssembly.Module(await fs.readFile(object));
    assert.equal(WebAssembly.Module.customSections(metadata, 'linking').length, 1);
    for (const instruction of test.requiredInstructions) {
      assert(assembly.includes(`(${instruction} `), `GCC assembly did not use ${instruction}`);
      assert(dumped.stdout.includes(instruction), `Wasm object did not encode ${instruction}`);
    }
    if (!test.request.simd) {
      assert(!/\b(?:v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\./u.test(assembly), 'Disabled profile emitted SIMD assembly');
      assert(!/\b(?:v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\./u.test(dumped.stdout), 'Disabled profile encoded SIMD instructions');
    }
    command(path.join(sdk, 'bin/wasm-ld'), ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', program,
      path.join(library, 'crt1-command.o'), `-L${library}`, object, '-lm', '-lc', builtins]);
    const module = new WebAssembly.Module(await fs.readFile(program));
    entry.imports = WebAssembly.Module.imports(module); entry.exports = WebAssembly.Module.exports(module);
    assert(entry.imports.every(i => i.module === 'wasi_snapshot_preview1' && i.kind === 'function'));
    assert(entry.exports.some(e => e.name === 'memory' && e.kind === 'memory'));
    assert(entry.exports.some(e => e.name === '_start' && e.kind === 'function'));
    const executed = command(process.execPath, ['--disable-warning=ExperimentalWarning', runner, program], test.stdin);
    assert.equal(executed.stdout, test.stdout);
    assert.equal(executed.stderr, '');
    entry.wasm = await identify(program); entry.stdout = executed.stdout;
    entry.status = 'passed';
  } catch (error) {
    entry.status = 'failed'; entry.error = error.message;
  }
  console.log(`${entry.id}: ${entry.status}${entry.error ? `: ${entry.error.slice(0, 1500)}` : ''}`);
}
const disabledFile = path.join(output, 'simd-disabled.c');
await fs.writeFile(disabledFile, disabledDiagnostic);
report.disabledDiagnostic = run(path.join(compiler, 'cc1'), [...common, '-mno-simd128', disabledFile, '-o', path.join(output, 'disabled.wat')]);
assert.notEqual(report.disabledDiagnostic.status, 0);
assert.match(report.disabledDiagnostic.stderr, /SIMD128 is disabled/);
report.defaultDiagnostic = run(path.join(compiler, 'cc1'), [...common, disabledFile, '-o', path.join(output, 'default.wat')]);
assert.notEqual(report.defaultDiagnostic.status, 0);
assert.match(report.defaultDiagnostic.stderr, /SIMD128 is disabled/);
assert.deepEqual(await identify(path.join(compiler, 'cc1')), compilerIdentity, 'Compiler changed during SIMD tests');
report.status = report.cases.every(test => test.status === 'passed') ? 'passed' : 'failed';
await fs.writeFile(path.join(output, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
process.exitCode = report.status === 'passed' ? 0 : 1;
