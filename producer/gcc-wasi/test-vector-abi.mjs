#!/usr/bin/env node
// Native GCC ↔ Clang ABI qualification. Clang compiles only explicitly selected
// comparison translation units; GCC units always use the real cc1/cc1plus path.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases, disabledCases } from './vector-abi-cases.mjs';
import { inspectVectorAbi } from './inspect-vector-abi.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  assert(['compiler', 'source', 'work', 'sdk', 'sysroot', 'output', 'cases', 'optimizations', 'directions'].includes(key), `Unknown argument ${process.argv[i]}`);
  assert(process.argv[i + 1], `Missing value for ${process.argv[i]}`);
  options[key] = process.argv[i + 1];
}
for (const key of ['compiler', 'source', 'work', 'sdk', 'output']) assert(options[key], `Required --${key}`);
const compiler = path.resolve(options.compiler), source = path.resolve(options.source);
const work = path.resolve(options.work), sdk = path.resolve(options.sdk), output = path.resolve(options.output);
const sysroot = path.resolve(options.sysroot || path.join(work, 'runtime-single-thread/sysroot'));
const library = path.join(sysroot, 'lib/wasm32-wasi');
let selected = [...cases, ...disabledCases];
if (options.cases) {
  const names = options.cases.split(',');
  assert(names.every(name => selected.some(fixture => fixture.id === name)), 'Unknown vector ABI fixture');
  selected = selected.filter(fixture => names.includes(fixture.id));
}
const optimizations = (options.optimizations || '0,2').split(',');
assert(optimizations.every(value => ['0', '2'].includes(value)), 'Use O0 and/or O2');
const directions = (options.directions || 'gcc-gcc,gcc-clang,clang-gcc,clang-clang').split(',');
assert(directions.every(value => ['gcc-gcc', 'gcc-clang', 'clang-gcc', 'clang-clang'].includes(value)));
const tools = {
  gcc: path.join(compiler, 'cc1'), gccCpp: path.join(compiler, 'cc1plus'),
  clang: path.join(sdk, 'bin/clang'), assembler: path.join(work, 'wabt-native/wat2wasm'),
  inspector: path.join(work, 'wabt-native/wasm-objdump'), linker: path.join(sdk, 'bin/wasm-ld'), node: process.execPath,
};
const runtime = Object.fromEntries(['crt1-command.o', 'libc.a', 'libm.a'].map(name => [name, path.join(library, name)]));
runtime.builtins = path.join(sdk, 'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a');
const digest = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const identify = async location => ({ path: location, ...digest(await fs.readFile(location)) });
const identifyMap = async locations => Object.fromEntries(await Promise.all(Object.entries(locations).map(async ([key, location]) => [key, await identify(location)])));
async function sourceIdentity() {
  return identifyMap(Object.fromEntries((await fs.readdir(path.join(source, 'gcc/config/wasm'))).sort().map(name => [name, path.join(source, 'gcc/config/wasm', name)])));
}
function run(command, argv, cwd = output, input) {
  const result = spawnSync(command, argv, { cwd, input, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  return { command, argv, status: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error?.message };
}


await fs.mkdir(output); // Never overwrite previous success or failure evidence.
const revision = run('git', ['-C', source, 'rev-parse', 'HEAD']);
assert.equal(revision.status, 0, revision.stderr);
const report = {
  schemaVersion: 1, kind: 'gcc-wasi-vector-abi-interop', status: 'running',
  compilerHost: 'native', outputTarget: 'wasm32-wasi', gccCommit: revision.stdout.trim(),
  comparisonCompilerOnly: 'Clang compiles independent ABI comparison caller/callee units, never a GCC fallback.',
  tools: await identifyMap(tools), runtime: await identifyMap(runtime), targetSource: await sourceIdentity(),
  fixtures: await identify(path.join(here, 'vector-abi-cases.mjs')),
  inspectionRecipe: await identify(path.join(here, 'inspect-vector-abi.mjs')), harness: await identify(fileURLToPath(import.meta.url)), cases: [],
};
assert.equal(report.gccCommit, 'ac20dcd5f8c5ae858f9b2d9cdf4140c0738e5e27');
const runner = path.join(output, 'run-wasi.mjs');
await fs.writeFile(runner, `import { WASI } from 'node:wasi';
import { readFile } from 'node:fs/promises';
const wasi = new WASI({ version: 'preview1', args: ['program'], env: {}, returnOnExit: true });
const module = await WebAssembly.compile(await readFile(process.argv[2]));
const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
process.exitCode = wasi.start(instance);
`);
for (const fixture of selected) for (const optimization of optimizations) for (const direction of directions) {
  if (!fixture.request.simd && direction !== 'gcc-gcc') continue;
  const id = `${fixture.id}-o${optimization}-${direction}`;
  const directory = path.join(output, id);
  await fs.mkdir(directory);
  const entry = { id, fixture: fixture.id, optimization, direction, simd: fixture.request.simd, status: 'running', units: [], commands: [] };
  report.cases.push(entry);
  function command(executable, argv, input) {
    const result = run(executable, argv, directory, input); entry.commands.push(result);
    assert.equal(result.status, 0, `${id}: ${result.stderr || result.error}`); return result;
  }
  try {
    await fs.writeFile(path.join(directory, 'main.c'), fixture.request.code);
    for (const file of fixture.request.files) {
      assert(!path.isAbsolute(file.path) && !file.path.split('/').includes('..'));
      await fs.writeFile(path.join(directory, file.path), file.contents);
    }
    const objects = [], cpp = fixture.request.language === 'cpp';
    for (const [index, unit] of ['main.c', ...fixture.request.sources].entries()) {
      const family = direction.split('-')[index === 0 ? 0 : 1], input = path.join(directory, unit);
      const object = path.join(directory, `unit${index}.o`), assembly = path.join(directory, `unit${index}.wat`);
      const simdFlag = fixture.request.simd ? '-msimd128' : '-mno-simd128';
      if (family === 'gcc') {
        command(tools[cpp ? 'gccCpp' : 'gcc'], ['-quiet', `-O${optimization}`, `-std=${fixture.request.standard}`, simdFlag,
          '-fdiagnostics-color=never', '-D__GCC_WASI_SINGLE_THREAD__=1', '-nostdinc',
          '-isystem', path.join(compiler, 'include'), '-isystem', path.join(sysroot, 'include/wasm32-wasi'),
          ...(cpp ? ['-fno-exceptions', '-fno-rtti', '-fuse-cxa-atexit', '-fno-threadsafe-statics'] : []), input, '-o', assembly]);
        command(tools.assembler, ['-r', '--enable-annotations', assembly, '-o', object]);
      } else {
        command(tools.clang, ['--target=wasm32-wasi', `--sysroot=${sysroot}`, `-O${optimization}`, `-std=${fixture.request.standard}`, simdFlag,
          ...(cpp ? ['-x', 'c++', '-fno-exceptions', '-fno-rtti'] : []), '-D__GCC_WASI_SINGLE_THREAD__=1', '-c', input, '-o', object]);
      }
      const bytes = await fs.readFile(object), module = new WebAssembly.Module(bytes);
      assert.equal(WebAssembly.Module.customSections(module, 'linking').length, 1);
      const dumped = command(tools.inspector, ['-dx', object]);
      await fs.writeFile(path.join(directory, `unit${index}.disassembly.txt`), dumped.stdout);
      if (!fixture.request.simd) assert(!/\b(?:v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)(?:\.|\b)/u.test(dumped.stdout), 'Disabled profile encoded a SIMD value/instruction');
      entry.units.push({ source: await identify(input), compiler: family, object: await identify(object) }); objects.push(object);
    }
    const program = path.join(directory, 'program.wasm');
    command(tools.linker, ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', program,
      ...Object.keys(fixture.signatures).map(name => `--export=${name}`),
      runtime['crt1-command.o'], `-L${library}`, ...objects, '-lm', '-lc', runtime.builtins]);
    const bytes = await fs.readFile(program), module = new WebAssembly.Module(bytes);
    entry.imports = WebAssembly.Module.imports(module); entry.exports = WebAssembly.Module.exports(module);
    assert(entry.imports.every(value => value.module === 'wasi_snapshot_preview1' && value.kind === 'function'));
    assert(entry.exports.some(value => value.name === 'memory' && value.kind === 'memory'));
    entry.abi = inspectVectorAbi(bytes);
    assert.equal(entry.abi.memories.length, 1); assert.equal(entry.abi.memories[0].shared, false);
    assert.deepEqual(entry.abi.exports._start, { params: [], results: [] });
    for (const [symbol, expected] of Object.entries(fixture.signatures)) assert.deepEqual(entry.abi.exports[symbol], expected, `${id}: ${symbol} ABI`);
    const executed = command(tools.node, ['--disable-warning=ExperimentalWarning', runner, program], fixture.stdin);
    assert.equal(executed.stdout, fixture.stdout); assert.equal(executed.stderr, '');
    entry.program = await identify(program); entry.stdout = executed.stdout; entry.status = 'passed';
  } catch (error) { entry.status = 'failed'; entry.error = error.message; }
  console.log(`${id}: ${entry.status}${entry.error ? `: ${entry.error.slice(0, 1200)}` : ''}`);
}
assert.deepEqual(await identifyMap(tools), report.tools, 'Compiler/tool bytes changed during qualification');
assert.deepEqual(await identifyMap(runtime), report.runtime, 'Target runtime changed during qualification');
assert.deepEqual(await sourceIdentity(), report.targetSource, 'GCC backend source changed during qualification');
assert.deepEqual(await identify(path.join(here, 'vector-abi-cases.mjs')), report.fixtures, 'Fixtures changed during qualification');
assert.deepEqual(await identify(fileURLToPath(import.meta.url)), report.harness, 'Harness changed during qualification');
assert.deepEqual(await identify(path.join(here, 'inspect-vector-abi.mjs')), report.inspectionRecipe, 'ABI inspector changed during qualification');
report.inputsUnchanged = true;
report.counts = { total: report.cases.length, passed: report.cases.filter(entry => entry.status === 'passed').length, failed: report.cases.filter(entry => entry.status === 'failed').length };
report.status = report.counts.failed === 0 ? 'passed' : 'failed';
await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.counts));
process.exitCode = report.status === 'passed' ? 0 : 1;
