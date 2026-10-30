#!/usr/bin/env node
// Installed GCC header and original SDK Clang header compile the same fixtures.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identity, readNativeTree } from '../clang-browser/cross/package.mjs';
import { cases, disabledCases, diagnosticCases } from './simd-header-fixtures.mjs';
import { simdHeaderApis, simdHeaderReference } from './simd-header-api.mjs';
import { conversionInstructions, verifyConversionInstructions } from './simd-conversions-inspect.mjs';
import { verifyHeaderApiCoverage, headerDiagnosticProfile, simdHeaderWasiRunner } from './simd-header-qualification.mjs';

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
async function input(file) { const bytes = await fs.readFile(file); inputs.set(file, identity(bytes)); return bytes; }
async function inventory(root) { return Object.fromEntries((await readNativeTree(root)).map(file => [file.path, identity(file.bytes)])); }
const toolPaths = { gcc: path.join(compiler, 'cc1'), gccCpp: path.join(compiler, 'cc1plus'),
  clang: path.join(sdk, 'bin/clang'), clangCpp: path.join(sdk, 'bin/clang++'),
  assembler: path.join(work, 'wabt-native/wat2wasm'), objdump: path.join(work, 'wabt-native/wasm-objdump'),
  linker: path.join(sdk, 'bin/wasm-ld'), node: process.execPath, validator: path.join(work, 'wabt-native/wasm-validate') };
const tools = Object.fromEntries(await Promise.all(Object.entries(toolPaths).map(async ([name, file]) => [name, identity(await input(file))])));
const lockBytes = await input(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes);
const nativeBuild = JSON.parse(await input(path.join(work, 'native-build.json')));
assert.equal(nativeBuild.sourceLockSha256, identity(lockBytes).sha256);
assert.equal(nativeBuild.recipeSha256, identity(await input(path.join(here, 'build-native.sh'))).sha256);
assert.equal(nativeBuild.tools.cc1.sha256, tools.gcc.sha256); assert.equal(nativeBuild.tools.cc1plus.sha256, tools.gccCpp.sha256);
function run(command, argv, stdin) {
  const result = spawnSync(command, argv, { cwd: output, input: stdin, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  return { command, argv, status: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '', ...(result.error ? { error: result.error.message } : {}) };
}
const sourceCheck = run('python3', [path.join(here, 'prepare-source.py'), '--source', source]);
assert.equal(sourceCheck.status, 0, sourceCheck.stderr);
const gccSource = JSON.parse(sourceCheck.stdout); assert.deepEqual(gccSource, nativeBuild.gccSource);
await input(path.join(here, 'prepare-source.py'));
const headerRoots = { gcc: path.join(compiler, 'include'), clang: path.join(sdk, 'lib/clang/22/include'), target: path.join(sysroot, 'include') };
const headers = Object.fromEntries(await Promise.all(Object.entries(headerRoots).map(async ([name, root]) => [name, await inventory(root)])));
const publicHeader = { source: identity(await input(path.join(source, 'gcc/config/wasm/wasm_simd128.h'))),
  installed: identity(await input(path.join(headerRoots.gcc, 'wasm_simd128.h'))),
  clangReference: identity(await input(path.join(headerRoots.clang, 'wasm_simd128.h'))) };
assert.deepEqual(publicHeader.source, publicHeader.installed);
assert.equal(publicHeader.clangReference.sha256, simdHeaderReference.headerSha256);
const licenses = Object.fromEntries(await Promise.all(['COPYING3', 'COPYING.RUNTIME'].map(async name => [name, identity(await input(path.join(source, name)))])));
const library = path.join(sysroot, 'lib/wasm32-wasi'), builtins = path.join(sdk, 'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a');
const runtime = Object.fromEntries(await Promise.all([...['crt1-command.o', 'libc.a', 'libm.a'].map(name => [name, path.join(library, name)]), ['libclang_rt.builtins-wasm32.a', builtins]].map(async ([name, file]) => [name, identity(await input(file))])));
const targetSource = await inventory(path.join(source, 'gcc/config/wasm'));
const coverage = verifyHeaderApiCoverage(cases, disabledCases);
const report = { kind: 'gcc-wasi-native-simd-header-qualification', status: 'running', gccCommit: lock.gcc.commit,
  gccSource, sourceLock: identity(lockBytes), targetSource, tools, toolPaths, headerRoots, headers, runtime, publicHeader, licenses,
  executionHost: { node: process.version, platform: process.platform, architecture: process.arch },
  fixtures: identity(await input(path.join(here, 'simd-header-fixtures.mjs'))),
  fixtureDependencies: { 'simd-conversions-fixtures.mjs': identity(await input(path.join(here, 'simd-conversions-fixtures.mjs'))) },
  apiContract: identity(await input(path.join(here, 'simd-header-api.mjs'))),
  testRecipe: identity(await input(fileURLToPath(import.meta.url))),
  inspectionRecipe: identity(await input(path.join(here, 'simd-conversions-inspect.mjs'))),
  gateRecipe: identity(await input(path.join(here, 'simd-header-qualification.mjs'))),
  apis: [...simdHeaderApis], coverage, executionRecipe: identity(Buffer.from(simdHeaderWasiRunner)), cases: [], defaultControls: [], diagnostics: [] };
const runner = path.join(output, 'run-wasi.mjs');
await fs.writeFile(runner, simdHeaderWasiRunner);
function compilerArgs(fixture, file, outputFile, profile, family) {
  const common = [`-O${fixture.request.optimization}`, `-std=${fixture.request.standard}`, '-fdiagnostics-color=never', '-Werror=attributes', '-Werror=pragmas', '-nostdinc',
    '-isystem', headerRoots[family], '-isystem', path.join(sysroot, 'include/wasm32-wasi'),
    ...(fixture.request.language === 'cpp' ? ['-fno-exceptions', '-fno-rtti'] : ['-Werror=implicit-function-declaration']),
    ...(profile === 'default' ? [] : [profile === 'disabled' ? '-mno-simd128' : '-msimd128'])];
  return family === 'gcc' ? ['-quiet', '-D__GCC_WASI_SINGLE_THREAD__=1', ...common, file, '-o', outputFile]
    : ['--target=wasm32-wasip1', '--sysroot=' + sysroot, ...common, '-c', file, '-o', outputFile];
}
const simdMnemonic = /\b(?:v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\./u;
try {
  const executions = [...cases, ...disabledCases].map(fixture => ({ fixture, profile: fixture.request.simd ? 'enabled' : 'disabled' }));
  executions.push(...disabledCases.map(fixture => ({ fixture, profile: 'default' })));
  for (const { fixture, profile } of executions) {
    const id = fixture.id + (profile === 'default' ? '-default' : ''), directory = path.join(output, id);
    await fs.mkdir(directory); const file = path.join(directory, fixture.request.language === 'cpp' ? 'main.cc' : 'main.c');
    await fs.writeFile(file, fixture.request.code);
    const entry = { id, fixture: fixture.id, profile, status: 'running', source: identity(Buffer.from(fixture.request.code)), fixtureValue: identity(Buffer.from(JSON.stringify(fixture))), apis: fixture.apis, stdin: fixture.stdin, results: {} };
    (profile === 'default' ? report.defaultControls : report.cases).push(entry);
    try {
      for (const family of (profile === 'default' ? ['gcc'] : ['gcc', 'clang'])) {
        const directoryFamily = path.join(directory, family); await fs.mkdir(directoryFamily);
        const assembly = path.join(directoryFamily, 'main.wat'), object = path.join(directoryFamily, 'main.o'), program = path.join(directoryFamily, 'main.wasm');
        const result = { commands: [] }; entry.results[family] = result;
        function command(executable, argv, stdin) { const value = run(executable, argv, stdin); result.commands.push(value); assert.equal(value.status, 0, value.stderr || value.error); assert.equal(value.signal, null); assert(!value.error); return value; }
        command(toolPaths[family + (fixture.request.language === 'cpp' ? 'Cpp' : '')], compilerArgs(fixture, file, family === 'gcc' ? assembly : object, profile, family));
        if (family === 'gcc') { result.assembly = identity(await fs.readFile(assembly)); command(toolPaths.assembler, ['-r', '--enable-annotations', assembly, '-o', object]); }
        const disassembly = command(toolPaths.objdump, ['-d', object]).stdout;
        await fs.writeFile(path.join(directoryFamily, 'object.disassembly.txt'), disassembly);
        result.instructions = disassembly.split('\n').flatMap(line => {
          const match = /^\s*[a-f0-9]+:\s+(?:[a-f0-9]{2}\s+)+\|\s*(\S+)/i.exec(line);
          return match && !match[1].startsWith('local[') ? [match[1]] : [];
        });
        const objectBytes = await fs.readFile(object); result.object = identity(objectBytes);
        assert.equal(WebAssembly.Module.customSections(new WebAssembly.Module(objectBytes), 'linking').length, 1);
        if (fixture.request.simd && family === 'gcc') {
          result.convertFunction = conversionInstructions(disassembly); verifyConversionInstructions(fixture, result.convertFunction);
          const text = await fs.readFile(assembly, 'utf8');
          for (const opcode of fixture.requiredInstructions) assert(text.includes(`(${opcode} `), `GCC assembly omitted ${opcode}`);
        }
        if (!fixture.request.simd) assert(!result.instructions.some(opcode => simdMnemonic.test(opcode)));
        command(toolPaths.linker, ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', program, path.join(library, 'crt1-command.o'), `-L${library}`, object, '-lm', '-lc', builtins]);
        const bytes = await fs.readFile(program), module = new WebAssembly.Module(bytes);
        result.wasm = identity(bytes); result.imports = WebAssembly.Module.imports(module); result.exports = WebAssembly.Module.exports(module);
        assert(result.imports.every(value => value.module === 'wasi_snapshot_preview1' && value.kind === 'function'));
        assert(result.exports.some(value => value.name === '_start' && value.kind === 'function'));
        assert(result.exports.some(value => value.name === 'memory' && value.kind === 'memory'));
        const execution = command(toolPaths.node, ['--disable-warning=ExperimentalWarning', runner, program], fixture.stdin);
        assert.equal(execution.stdout, fixture.stdout); assert.equal(execution.stderr, ''); result.stdout = execution.stdout;
        result.simdDisabledValidation = run(toolPaths.validator, ['--disable-simd', program]);
        assert.equal(result.simdDisabledValidation.status, fixture.request.simd ? 1 : 0);
        result.status = 'passed';
      }
      entry.status = 'passed';
    } catch (error) { entry.status = 'failed'; entry.error = error.stack; }
    console.log(`${entry.id}: ${entry.status}${entry.error ? ': ' + entry.error.slice(0, 1200) : ''}`);
  }
  for (const fixture of diagnosticCases) {
    const profile = headerDiagnosticProfile(fixture), directory = path.join(output, fixture.id); await fs.mkdir(directory);
    const file = path.join(directory, fixture.request.language === 'cpp' ? 'main.cc' : 'main.c'), assembly = path.join(directory, 'main.wat');
    await fs.writeFile(file, fixture.request.code);
    const command = run(fixture.request.language === 'cpp' ? toolPaths.gccCpp : toolPaths.gcc, compilerArgs(fixture, file, assembly, profile, 'gcc'));
    const emitted = await fs.readFile(assembly, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    const entry = { id: fixture.id, profile, source: identity(Buffer.from(fixture.request.code)), fixtureValue: identity(Buffer.from(JSON.stringify(fixture))), command, emittedSimd: simdMnemonic.test(emitted), partialAssembly: identity(Buffer.from(emitted)) };
    report.diagnostics.push(entry);
    assert.equal(command.status, 1, command.stderr); assert.equal(command.signal, null); assert(!command.error);
    assert.match(command.stderr, new RegExp(fixture.diagnosticPattern)); assert.equal(entry.emittedSimd, false);
  }
  for (const [file, expected] of inputs) assert.deepEqual(identity(await fs.readFile(file)), expected, `Input changed: ${file}`);
  for (const [name, root] of Object.entries(headerRoots)) assert.deepEqual(await inventory(root), headers[name], `Header inputs changed: ${name}`);
  assert.deepEqual(await inventory(path.join(source, 'gcc/config/wasm')), targetSource);
  report.inputsUnchanged = true; report.status = [...report.cases, ...report.defaultControls].every(entry => entry.status === 'passed') ? 'passed' : 'failed';
} catch (error) { report.status = 'failed'; report.error = error.stack; }
report.inputs = Object.fromEntries(inputs);
await fs.writeFile(path.join(output, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, cases: report.cases.length, defaultControls: report.defaultControls.length, diagnostics: report.diagnostics.length, error: report.error, output }));
process.exitCode = report.status === 'passed' ? 0 : 1;
