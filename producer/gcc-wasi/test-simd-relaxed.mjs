#!/usr/bin/env node
// Real GCC frontend/RTL -> relocatable Wasm -> strict LLD -> actual Node WASI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNativeTree } from '../clang-browser/cross/package.mjs';
import { cases, disabledCases, diagnosticCases, specification } from './simd-relaxed-fixtures.mjs';
import { verifyRelaxedInstructions, assertRelaxedOutput } from './simd-relaxed-inspect.mjs';
import { inspectTargetFeatures } from './inspect-target-features.mjs';
import { identity, relaxedCompilerArgs, relaxedExecutions, relaxedWasiRunner, verifyRelaxedSimdQualification } from './simd-relaxed-qualification.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  assert(['compiler', 'source', 'work', 'sdk', 'sysroot', 'output'].includes(key) && process.argv[i + 1] && !options[key], 'Invalid argument ' + process.argv[i]);
  options[key] = path.resolve(process.argv[i + 1]);
}
for (const key of ['compiler', 'source', 'work', 'sdk', 'sysroot', 'output']) assert(options[key], 'Required --' + key);
const { compiler, source, work, sdk, sysroot, output } = options;
await fs.mkdir(output);
const inputs = new Map();
async function readInput(file) { const bytes = await fs.readFile(file); inputs.set(file, identity(bytes)); return bytes; }
async function inventory(root) { return Object.fromEntries((await readNativeTree(root)).map(file => [file.path, identity(file.bytes)])); }
function run(command, argv, input, timeout = 120000) {
  const result = spawnSync(command, argv, { cwd: output, input, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  return { command, argv, status: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '', ...(result.error ? { error: result.error.message } : {}) };
}
const report = { kind: 'gcc-wasi-native-simd-relaxed-qualification', status: 'running', specification, cases: [], defaultControls: [], diagnostics: [] };
try {
  const toolPaths = { gcc: path.join(compiler, 'cc1'), gccCpp: path.join(compiler, 'cc1plus'),
    assembler: path.join(work, 'wabt-native/wat2wasm'), objdump: path.join(work, 'wabt-native/wasm-objdump'), validator: path.join(work, 'wabt-native/wasm-validate'),
    linker: path.join(sdk, 'bin/wasm-ld'), node: process.execPath };
  const tools = Object.fromEntries(await Promise.all(Object.entries(toolPaths).map(async ([name, file]) => [name, identity(await readInput(file))])));
  const lockBytes = await readInput(path.join(here, 'sources.lock.json'));
  const nativeReceiptBytes = await readInput(path.join(path.dirname(path.dirname(compiler)), 'native-build.json'));
  const nativeReceipt = JSON.parse(nativeReceiptBytes);
  assert.equal(nativeReceipt.sourceLockSha256, identity(lockBytes).sha256);
  assert.equal(nativeReceipt.recipeSha256, identity(await readInput(path.join(here, 'build-native.sh'))).sha256);
  assert.equal(nativeReceipt.tools.cc1.sha256, tools.gcc.sha256); assert.equal(nativeReceipt.tools.cc1plus.sha256, tools.gccCpp.sha256);
  const sourceCheck = run('python3', [path.join(here, 'prepare-source.py'), '--source', source], undefined, 600000);
  report.sourceCheck = sourceCheck;
  assert.equal(sourceCheck.status, 0, 'Locked GCC source verification failed: ' + JSON.stringify(sourceCheck));
  assert.equal(sourceCheck.signal, null); assert(!sourceCheck.error);
  const gccSource = JSON.parse(sourceCheck.stdout); assert.deepEqual(gccSource, nativeReceipt.gccSource);
  await readInput(path.join(here, 'prepare-source.py'));
  const headerRoots = { gcc: path.join(compiler, 'include'), target: path.join(sysroot, 'include') };
  const headers = Object.fromEntries(await Promise.all(Object.entries(headerRoots).map(async ([name, directory]) => [name, await inventory(directory)])));
  const library = path.join(sysroot, 'lib/wasm32-wasi'), builtins = path.join(sdk, 'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a');
  const runtime = Object.fromEntries(await Promise.all([
    ...['crt1-command.o', 'libc.a', 'libm.a'].map(name => [name, path.join(library, name)]), ['libclang_rt.builtins-wasm32.a', builtins]
  ].map(async ([name, file]) => [name, identity(await readInput(file))])));
  const publicHeader = { source: identity(await readInput(path.join(source, 'gcc/config/wasm/wasm_relaxed_simd.h'))), installed: identity(await readInput(path.join(headerRoots.gcc, 'wasm_relaxed_simd.h'))) };
  assert.deepEqual(publicHeader.source, publicHeader.installed);
  Object.assign(report, { sourcePath: source, gccSource, sourceLock: identity(lockBytes), nativeBuild: identity(nativeReceiptBytes),
    sourceRecipe: identity(await readInput(path.join(here, 'prepare-source.py'))), buildRecipe: identity(await readInput(path.join(here, 'build-native.sh'))),
    featureRecipe: identity(await readInput(path.join(here, 'inspect-target-features.mjs'))),
    targetSource: await inventory(path.join(source, 'gcc/config/wasm')), tools, toolPaths, headerRoots, headers, runtime, publicHeader,
    fixtures: identity(await readInput(path.join(here, 'simd-relaxed-fixtures.mjs'))), testRecipe: identity(await readInput(fileURLToPath(import.meta.url))),
    inspectionRecipe: identity(await readInput(path.join(here, 'simd-relaxed-inspect.mjs'))), gateRecipe: identity(await readInput(path.join(here, 'simd-relaxed-qualification.mjs'))),
    executionHost: { node: process.version, platform: process.platform, architecture: process.arch }, executionRecipe: identity(Buffer.from(relaxedWasiRunner)) });
  await readInput(path.join(here, 'inspect-target-features.mjs'));
  const runner = path.join(output, 'run-wasi.mjs'); await fs.writeFile(runner, relaxedWasiRunner);
  for (const { fixture, profile, id } of relaxedExecutions()) {
    const entry = { id, fixture: fixture.id, profile, status: 'running', source: identity(Buffer.from(fixture.request.code)), fixtureValue: identity(Buffer.from(JSON.stringify(fixture))), stdin: fixture.stdin, commands: [] };
    (profile === 'default' ? report.defaultControls : report.cases).push(entry);
    const directory = path.join(output, id); await fs.mkdir(directory);
    const input = path.join(directory, fixture.request.language === 'cpp' ? 'main.cc' : 'main.c'), assembly = path.join(directory, 'main.wat'), object = path.join(directory, 'main.o'), program = path.join(directory, 'main.wasm');
    await fs.writeFile(input, fixture.request.code);
    function command(executable, argv, stdin) { const result = run(executable, argv, stdin); entry.commands.push(result); assert.equal(result.status, 0, result.stderr || result.error); assert.equal(result.signal, null); return result; }
    try {
      command(fixture.request.language === 'cpp' ? toolPaths.gccCpp : toolPaths.gcc, relaxedCompilerArgs(fixture, input, assembly, headerRoots, profile));
      command(toolPaths.assembler, ['-r', '--enable-annotations', ...(fixture.request.relaxedSimd ? ['--enable-relaxed-simd'] : []), assembly, '-o', object]);
      const disassembly = command(toolPaths.objdump, ['-d', object]); entry.decoded = verifyRelaxedInstructions(fixture, disassembly.stdout);
      await fs.writeFile(path.join(directory, 'object.disassembly.txt'), disassembly.stdout);
      const assemblyBytes = await fs.readFile(assembly), objectBytes = await fs.readFile(object);
      entry.assembly = identity(assemblyBytes); entry.object = identity(objectBytes); entry.features = inspectTargetFeatures(objectBytes).features;
      assert.equal(WebAssembly.Module.customSections(new WebAssembly.Module(objectBytes), 'linking').length, 1);
      for (const opcode of fixture.requiredInstructions) assert(assemblyBytes.toString().includes('(' + opcode + ' '), 'GCC assembly did not emit ' + opcode);
      command(toolPaths.linker, ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', program, path.join(library, 'crt1-command.o'), '-L' + library, object, '-lm', '-lc', builtins]);
      const bytes = await fs.readFile(program), module = new WebAssembly.Module(bytes);
      entry.wasm = identity(bytes); entry.imports = WebAssembly.Module.imports(module); entry.exports = WebAssembly.Module.exports(module);
      const execution = command(toolPaths.node, ['--no-warnings', runner, program], fixture.stdin);
      assertRelaxedOutput(fixture, execution.stdout); assert.equal(execution.stderr, ''); entry.stdout = execution.stdout;
      entry.relaxedDisabledValidation = run(toolPaths.validator, [program]);
      assert.equal(entry.relaxedDisabledValidation.status, fixture.request.relaxedSimd ? 1 : 0);
      entry.status = 'passed';
    } catch (error) { entry.status = 'failed'; entry.error = error.stack; }
    console.log(`${id}: ${entry.status}${entry.error ? ': ' + entry.error.slice(0, 1000) : ''}`);
  }
  for (const fixture of diagnosticCases) {
    const directory = path.join(output, fixture.id); await fs.mkdir(directory);
    const input = path.join(directory, fixture.request.language === 'cpp' ? 'main.cc' : 'main.c'), assembly = path.join(directory, 'main.wat');
    await fs.writeFile(input, fixture.request.code);
    const command = run(toolPaths[fixture.request.language === 'cpp' ? 'gccCpp' : 'gcc'], relaxedCompilerArgs(fixture, input, assembly, headerRoots, fixture.profile));
    const bytes = await fs.readFile(assembly).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; });
    const entry = { id: fixture.id, profile: fixture.profile, source: identity(Buffer.from(fixture.request.code)), fixtureValue: identity(Buffer.from(JSON.stringify(fixture))), command,
      partialAssembly: identity(bytes), emittedRelaxed: /\b(?:i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\.relaxed_/.test(bytes.toString()) };
    report.diagnostics.push(entry);
    assert.equal(command.status, 1, fixture.id + ': ' + command.stderr); assert.equal(command.signal, null); assert(!command.error);
    assert.match(command.stderr, new RegExp(fixture.diagnosticPattern)); assert.equal(entry.emittedRelaxed, false);
  }
  for (const [file, expected] of inputs) assert.deepEqual(identity(await fs.readFile(file)), expected, 'Input changed: ' + file);
  for (const [name, directory] of Object.entries(headerRoots)) assert.deepEqual(await inventory(directory), headers[name], 'Header changed: ' + name);
  assert.deepEqual(await inventory(path.join(source, 'gcc/config/wasm')), report.targetSource);
  report.inputsUnchanged = true; report.status = [...report.cases, ...report.defaultControls].every(entry => entry.status === 'passed') ? 'passed' : 'failed';
  if (report.status === 'passed') verifyRelaxedSimdQualification(report, { ...report, cases, disabledCases, diagnosticCases });
} catch (error) { report.status = 'failed'; report.error = error.stack; }
report.inputs = Object.fromEntries(inputs);
await fs.writeFile(path.join(output, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, cases: report.cases.length, defaultControls: report.defaultControls.length, diagnostics: report.diagnostics.length, error: report.error, output }));
process.exitCode = report.status === 'passed' ? 0 : 1;
