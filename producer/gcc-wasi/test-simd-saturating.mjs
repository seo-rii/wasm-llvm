#!/usr/bin/env node
// Actual GCC target builtins -> relocatable Wasm -> WASI, with a BigInt oracle.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identity, readNativeTree } from '../clang-browser/cross/package.mjs';
import { cases, disabledCases, diagnosticCases } from './simd-saturating-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  assert(['compiler', 'source', 'work', 'sdk', 'sysroot', 'output'].includes(key) && process.argv[i + 1] && !options[key], `Invalid argument ${process.argv[i]}`);
  options[key] = path.resolve(process.argv[i + 1]);
}
for (const key of ['compiler', 'source', 'work', 'sdk', 'sysroot', 'output']) assert(options[key], `Required --${key}`);
const { compiler, source, work, sdk, sysroot, output } = options;
await fs.mkdir(output);
const inputs = new Map();
async function readInput(file) { const bytes = await fs.readFile(file); inputs.set(file, identity(bytes)); return bytes; }
async function inventory(root) { return Object.fromEntries((await readNativeTree(root)).map(file => [file.path, identity(file.bytes)])); }
const toolPaths = { gcc: path.join(compiler, 'cc1'), gccCpp: path.join(compiler, 'cc1plus'),
  assembler: path.join(work, 'wabt-native/wat2wasm'), objdump: path.join(work, 'wabt-native/wasm-objdump'),
  linker: path.join(sdk, 'bin/wasm-ld'), node: process.execPath, validator: path.join(work, 'wabt-native/wasm-validate') };
const tools = Object.fromEntries(await Promise.all(Object.entries(toolPaths).map(async ([name, file]) => [name, identity(await readInput(file))])));
const lockBytes = await readInput(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes);
const nativeReceipt = JSON.parse(await readInput(path.join(path.dirname(path.dirname(compiler)), 'native-build.json')));
assert.equal(nativeReceipt.sourceLockSha256, identity(lockBytes).sha256);
assert.equal(nativeReceipt.recipeSha256, identity(await readInput(path.join(here, 'build-native.sh'))).sha256);
assert.equal(nativeReceipt.tools.cc1.sha256, tools.gcc.sha256);
assert.equal(nativeReceipt.tools.cc1plus.sha256, tools.gccCpp.sha256);
function run(command, argv, input) {
  const result = spawnSync(command, argv, { cwd: output, input, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  return { command, argv, status: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '', ...(result.error ? { error: result.error.message } : {}) };
}
const sourceCheck = run('python3', [path.join(here, 'prepare-source.py'), '--source', source]);
assert.equal(sourceCheck.status, 0, sourceCheck.stderr);
const gccSource = JSON.parse(sourceCheck.stdout); assert.deepEqual(gccSource, nativeReceipt.gccSource);
const headerRoots = { gcc: path.join(compiler, 'include'), target: path.join(sysroot, 'include') };
const headers = Object.fromEntries(await Promise.all(Object.entries(headerRoots).map(async ([name, root]) => [name, await inventory(root)])));
const library = path.join(sysroot, 'lib/wasm32-wasi'), builtins = path.join(sdk, 'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a');
const runtime = Object.fromEntries(await Promise.all([
  ...['crt1-command.o', 'libc.a', 'libm.a'].map(name => [name, path.join(library, name)]), ['libclang_rt.builtins-wasm32.a', builtins]
].map(async ([name, file]) => [name, identity(await readInput(file))])));
const targetSource = await inventory(path.join(source, 'gcc/config/wasm'));
const report = { kind: 'gcc-wasi-native-simd-saturating-qualification', status: 'running', gccCommit: lock.gcc.commit,
  gccSource, sourceLock: identity(lockBytes), targetSource, compiler: tools.gcc, compilerCpp: tools.gccCpp,
  assembler: tools.assembler, objdump: tools.objdump, linker: tools.linker, node: tools.node, validator: tools.validator,
  toolPaths, headers, runtime, executionHost: { node: process.version, platform: process.platform, architecture: process.arch },
  fixture: identity(await readInput(path.join(here, 'simd-saturating-fixtures.mjs'))), testRecipe: identity(await readInput(fileURLToPath(import.meta.url))), cases: [], diagnostics: [] };
await readInput(path.join(here, 'prepare-source.py'));
const runner = path.join(output, 'run-wasi.mjs');
await fs.writeFile(runner, `import { WASI } from 'node:wasi';\nimport { readFile } from 'node:fs/promises';\nconst wasi = new WASI({version:'preview1',args:['program'],env:{},returnOnExit:true});\nconst module = await WebAssembly.compile(await readFile(process.argv[2]));\nprocess.exitCode = wasi.start(await WebAssembly.instantiate(module,{wasi_snapshot_preview1:wasi.wasiImport}));\n`);
function compilerArgs(fixture, input, assembly, profile = fixture.request.simd ? 'enabled' : 'disabled') {
  return ['-quiet', `-O${fixture.request.optimization}`, `-std=${fixture.request.standard}`, '-fdiagnostics-color=never', '-Werror=attributes', '-Werror=pragmas',
    '-D__GCC_WASI_SINGLE_THREAD__=1', '-nostdinc', '-isystem', headerRoots.gcc, '-isystem', path.join(sysroot, 'include/wasm32-wasi'),
    ...(fixture.request.language === 'cpp' ? ['-fno-exceptions', '-fno-rtti'] : ['-Werror=implicit-function-declaration']),
    ...(profile === 'default' ? [] : [profile === 'disabled' ? '-mno-simd128' : '-msimd128']), input, '-o', assembly];
}
const simdMnemonic = /\b(?:v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\./u;
try {
  for (const fixture of [...cases, ...disabledCases]) {
    const entry = { id: fixture.id, status: 'running', source: identity(Buffer.from(fixture.request.code)), stdin: fixture.stdin, commands: [] }; report.cases.push(entry);
    const directory = path.join(output, fixture.id); await fs.mkdir(directory);
    const input = path.join(directory, fixture.request.language === 'cpp' ? 'main.cc' : 'main.c'), assembly = path.join(directory, 'main.wat');
    const object = path.join(directory, 'main.o'), program = path.join(directory, 'main.wasm');
    await fs.writeFile(input, fixture.request.code);
    function command(executable, argv, stdin) { const result = run(executable, argv, stdin); entry.commands.push(result); assert.equal(result.status, 0, result.stderr || result.error); assert.equal(result.signal, null); return result; }
    try {
      command(fixture.request.language === 'cpp' ? toolPaths.gccCpp : toolPaths.gcc, compilerArgs(fixture, input, assembly));
      command(toolPaths.assembler, ['-r', '--enable-annotations', assembly, '-o', object]);
      const disassembly = command(toolPaths.objdump, ['-d', object]).stdout;
      await fs.writeFile(path.join(directory, 'object.disassembly.txt'), disassembly);
      entry.instructions = disassembly.split('\n').flatMap(line => {
        const match = /^\s*[a-f0-9]+:\s+(?:[a-f0-9]{2}\s+)+\|\s*(\S+)/i.exec(line);
        return match && !match[1].startsWith('local[') ? [match[1]] : [];
      });
      const assemblyBytes = await fs.readFile(assembly), objectBytes = await fs.readFile(object);
      entry.assembly = identity(assemblyBytes); entry.object = identity(objectBytes);
      assert.equal(WebAssembly.Module.customSections(new WebAssembly.Module(objectBytes), 'linking').length, 1);
      for (const opcode of fixture.requiredInstructions) {
        assert(assemblyBytes.toString().includes(`(${opcode} `), `GCC did not emit ${opcode}`);
        assert(entry.instructions.includes(opcode), `Object did not encode ${opcode}`);
      }
      for (const opcode of fixture.forbiddenInstructions) assert(!entry.instructions.includes(opcode), `Unexpected saturation opcode ${opcode}`);
      if (!fixture.request.simd) { assert(!simdMnemonic.test(assemblyBytes.toString())); assert(!entry.instructions.some(opcode => simdMnemonic.test(opcode))); }
      command(toolPaths.linker, ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', program, path.join(library, 'crt1-command.o'), `-L${library}`, object, '-lm', '-lc', builtins]);
      const bytes = await fs.readFile(program), module = new WebAssembly.Module(bytes);
      entry.wasm = identity(bytes); entry.imports = WebAssembly.Module.imports(module); entry.exports = WebAssembly.Module.exports(module);
      assert(entry.imports.every(value => value.module === 'wasi_snapshot_preview1' && value.kind === 'function'));
      assert(entry.exports.some(value => value.name === '_start' && value.kind === 'function'));
      assert(entry.exports.some(value => value.name === 'memory' && value.kind === 'memory'));
      const execution = command(toolPaths.node, ['--disable-warning=ExperimentalWarning', runner, program], fixture.stdin);
      assert.equal(execution.stdout, fixture.stdout); assert.equal(execution.stderr, ''); entry.stdout = execution.stdout;
      entry.simdDisabledValidation = run(toolPaths.validator, ['--disable-simd', program]);
      assert.equal(entry.simdDisabledValidation.status, fixture.request.simd ? 1 : 0);
      entry.status = 'passed';
    } catch (error) { entry.status = 'failed'; entry.error = error.message; }
    console.log(`${entry.id}: ${entry.status}${entry.error ? ': ' + entry.error.slice(0, 1000) : ''}`);
  }
  const requests = [...cases.flatMap(fixture => ['disabled', 'default'].map(profile => ({ fixture, profile }))),
    ...diagnosticCases.map(fixture => ({ fixture, profile: 'enabled-invalid' }))];
  for (const { fixture, profile } of requests) {
    const id = `${fixture.id}-${profile}`, directory = path.join(output, id); await fs.mkdir(directory);
    const input = path.join(directory, fixture.request.language === 'cpp' ? 'main.cc' : 'main.c'), assembly = path.join(directory, 'main.wat');
    await fs.writeFile(input, fixture.request.code);
    const command = run(fixture.request.language === 'cpp' ? toolPaths.gccCpp : toolPaths.gcc, compilerArgs(fixture, input, assembly, profile));
    const emitted = await fs.readFile(assembly, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    const entry = { id, fixture: fixture.id, profile, source: identity(Buffer.from(fixture.request.code)), command, emittedSimd: simdMnemonic.test(emitted) };
    report.diagnostics.push(entry);
    assert.equal(command.status, 1, `${id}: ${command.stderr}`); assert.equal(command.signal, null); assert(!command.error);
    assert.match(command.stderr, profile === 'enabled-invalid' ? new RegExp(fixture.diagnosticPattern) : /SIMD128 is disabled/);
    assert.equal(entry.emittedSimd, false, `${id}: rejected compilation emitted SIMD`);
    if (fixture === cases[0] && profile !== 'enabled-invalid') report[`${profile}Diagnostic`] = command;
  }
  for (const [file, expected] of inputs) assert.deepEqual(identity(await fs.readFile(file)), expected, `Input changed: ${file}`);
  for (const [name, root] of Object.entries(headerRoots)) assert.deepEqual(await inventory(root), headers[name], `Header inputs changed: ${name}`);
  assert.deepEqual(await inventory(path.join(source, 'gcc/config/wasm')), targetSource);
  report.inputsUnchanged = true;
  report.status = report.cases.every(entry => entry.status === 'passed') ? 'passed' : 'failed';
} catch (error) { report.status = 'failed'; report.error = error.stack; }
report.inputs = Object.fromEntries(inputs);
await fs.writeFile(path.join(output, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, cases: report.cases.length, diagnostics: report.diagnostics.length, error: report.error, output }));
process.exitCode = report.status === 'passed' ? 0 : 1;
