#!/usr/bin/env node
// Compile original GCC permutations and independent Clang references, then run
// both real Wasm programs. Input source and compiler output are never rewritten.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identity, readNativeTree } from '../clang-browser/cross/package.mjs';
import { cases, disabledCases, defaultCases } from './runtime-permutation-fixtures.mjs';
import { permutationInstructions, permutationWatInstructions, verifyRuntimePermutationInstructions } from './runtime-permutation-inspect.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  assert(['compiler', 'source', 'work', 'sdk', 'sysroot', 'output', 'cases'].includes(key) && process.argv[i + 1] && !options[key], `Invalid argument ${process.argv[i]}`);
  options[key] = key === 'cases' ? process.argv[i + 1] : path.resolve(process.argv[i + 1]);
}
for (const key of ['compiler', 'source', 'work', 'sdk', 'sysroot', 'output']) assert(options[key], `Required --${key}`);
const { compiler, source, work, sdk, sysroot, output } = options;
const allFixtures = [...cases, ...disabledCases, ...defaultCases];
assert.equal(new Set(allFixtures.map(fixture => fixture.id)).size, 302);
let fixtures = allFixtures;
if (options.cases) {
  const ids = options.cases.split(',');
  assert.equal(new Set(ids).size, ids.length, 'Duplicate selected case');
  assert(ids.every(id => allFixtures.some(fixture => fixture.id === id)), 'Unknown permutation fixture');
  fixtures = allFixtures.filter(fixture => ids.includes(fixture.id));
}
await fs.mkdir(output);
const inputs = new Map();
async function input(file) { const bytes = await fs.readFile(file); inputs.set(file, identity(bytes)); return bytes; }
async function inventory(root) {
  const result = {};
  for (const file of await readNativeTree(root)) {
    const value = identity(file.bytes); inputs.set(path.join(root, file.path), value); result[file.path] = value;
  }
  return result;
}
async function artifact(file) { return { path: file, ...identity(await fs.readFile(file)) }; }
function run(command, argv, stdin) {
  const result = spawnSync(command, argv, { cwd: output, input: stdin, encoding: 'utf8', timeout: 120000,
    maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  return { command, argv, status: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '',
    ...(result.error ? { error: result.error.message } : {}) };
}
function success(result) {
  assert.equal(result.status, 0, result.stderr || result.error);
  assert.equal(result.signal, null);
  assert(!result.error);
  return result;
}

const toolPaths = { gcc: path.join(compiler, 'cc1'), gccCpp: path.join(compiler, 'cc1plus'),
  clang: path.join(sdk, 'bin/clang'), clangCpp: path.join(sdk, 'bin/clang++'),
  assembler: path.join(work, 'wabt-native/wat2wasm'), objdump: path.join(work, 'wabt-native/wasm-objdump'),
  linker: path.join(sdk, 'bin/wasm-ld'), validator: path.join(work, 'wabt-native/wasm-validate'), node: process.execPath };
const tools = Object.fromEntries(await Promise.all(Object.entries(toolPaths).map(async ([name, file]) => [name, identity(await input(file))])));
const lockBytes = await input(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes);
const nativeBuildPath = path.join(work, 'native-build.json'), nativeBuildBytes = await input(nativeBuildPath), nativeBuild = JSON.parse(nativeBuildBytes);
assert.equal(nativeBuild.host, 'native'); assert.equal(nativeBuild.target, 'wasm32-wasi');
assert.equal(nativeBuild.sourceLockSha256, identity(lockBytes).sha256);
assert.equal(nativeBuild.recipeSha256, identity(await input(path.join(here, 'build-native.sh'))).sha256);
assert.equal(nativeBuild.tools.cc1.sha256, tools.gcc.sha256); assert.equal(nativeBuild.tools.cc1plus.sha256, tools.gccCpp.sha256);
// Without --apply, the shared source tree is verified against the lock; its
// working files are not changed. Temporary Git indices are private to the check.
await input(path.join(here, 'prepare-source.py'));
const sourceCheck = success(run('python3', [path.join(here, 'prepare-source.py'), '--source', source]));
const gccSource = JSON.parse(sourceCheck.stdout); assert.deepEqual(gccSource, nativeBuild.gccSource);
for (const patch of lock.gcc.patches) assert.equal(identity(await input(path.join(here, patch.path))).sha256, patch.sha256);
const nativeQualification = JSON.parse(await input(path.join(work, 'native-qualification.json')));
assert.equal(nativeQualification.status, 'passed'); assert.deepEqual(nativeQualification.gccSource, gccSource);
assert.equal(nativeQualification.buildReceiptSha256, identity(nativeBuildBytes).sha256);
const headerRoots = { gcc: path.join(compiler, 'include'), clang: path.join(sdk, 'lib/clang/22/include'), target: path.join(sysroot, 'include') };
const headers = Object.fromEntries(await Promise.all(Object.entries(headerRoots).map(async ([name, root]) => [name, await inventory(root)])));
const targetSource = await inventory(path.join(source, 'gcc/config/wasm'));
const library = path.join(sysroot, 'lib/wasm32-wasi'), builtins = path.join(sdk, 'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a');
const runtime = Object.fromEntries(await Promise.all([...['crt1-command.o', 'libc.a', 'libm.a'].map(name => [name, path.join(library, name)]),
  ['libclang_rt.builtins-wasm32.a', builtins]].map(async ([name, file]) => [name, identity(await input(file))])));
const recipes = Object.fromEntries(await Promise.all(['runtime-permutation-fixtures.mjs', 'simd-extended-fixtures.mjs',
  'runtime-permutation-inspect.mjs', 'test-runtime-permutation.mjs'].map(async name => [name, identity(await input(path.join(here, name)))])));
await input(path.join(here, '../clang-browser/cross/package.mjs'));
const runnerText = `import { WASI } from 'node:wasi';
import { readFile } from 'node:fs/promises';
const wasi = new WASI({ version: 'preview1', args: ['program'], env: {}, returnOnExit: true });
const module = await WebAssembly.compile(await readFile(process.argv[2]));
const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
process.exitCode = wasi.start(instance);
`;
const runner = path.join(output, 'run-wasi.mjs'); await fs.writeFile(runner, runnerText, { flag: 'wx' }); await input(runner);
const inputFile = path.join(output, 'inputs.json');
await fs.writeFile(inputFile, JSON.stringify({ gccSource, files: Object.fromEntries(inputs) }, null, 2) + '\n', { flag: 'wx' });
const report = { schemaVersion: 1, kind: 'gcc-wasi-native-runtime-permutation-qualification', status: 'running',
  target: 'wasm32-wasi', compilerHost: 'native', executionHost: { node: process.version, platform: process.platform, architecture: process.arch },
  gccCommit: lock.gcc.commit, gccSource, sourceLock: identity(lockBytes), nativeBuild: { path: nativeBuildPath, ...identity(nativeBuildBytes) },
  sourceCheck, targetSource, toolPaths, tools, headerRoots, headers, runtime, recipes, inputSnapshot: await artifact(inputFile),
  selectedCases: fixtures.map(fixture => fixture.id), unselectedCases: allFixtures.filter(fixture => !fixtures.includes(fixture)).map(fixture => fixture.id),
  reference: { runtime: 'Separate scalar byte-selection source compiled with Clang; never substitutes for GCC original builtin source.',
    constants: 'Unchanged original constant-shuffle source compiled with both compilers.',
    expectedBytes: 'Modulo in fixture generation, checked independently against scalar mask-and selection in the Clang source.',
    defaults: 'Both native frontends omit both SIMD flags for defaultCases. The public SDK normalizes omitted simd requests to -mno-simd128.' }, cases: [] };

try {
  for (const fixture of fixtures) {
    const directory = path.join(output, fixture.id); await fs.mkdir(directory);
    const entry = { id: fixture.id, semanticKind: fixture.semanticKind, feature: fixture.feature,
      fixture: identity(Buffer.from(JSON.stringify(fixture))), stdin: fixture.stdin, expectedStdout: fixture.stdout, status: 'running', results: {} };
    report.cases.push(entry);
    try {
      for (const family of ['gcc', 'clang']) {
        const dir = path.join(directory, family); await fs.mkdir(dir);
        const cpp = fixture.request.language === 'cpp', file = path.join(dir, cpp ? 'main.cc' : 'main.c');
        const code = family === 'gcc' ? fixture.request.code : fixture.oracleCode;
        await fs.writeFile(file, code, { flag: 'wx' });
        const assembly = path.join(dir, 'main.wat'), object = path.join(dir, 'main.o'), program = path.join(dir, 'main.wasm');
        const result = { status: 'running', source: await artifact(file), commands: [],
          sourceKind: family === 'gcc' || fixture.semanticKind === 'constant-permutation' ? 'original-source' : 'scalar-byte-selection-oracle' };
        entry.results[family] = result;
        function command(executable, argv, stdin) { const value = run(executable, argv, stdin); result.commands.push(value); return success(value); }
        const flags = fixture.feature === 'default' ? [] : [fixture.feature === 'enabled' ? '-msimd128' : '-mno-simd128'];
        const common = [`-O${fixture.request.optimization}`, `-std=${fixture.request.standard}`, '-fdiagnostics-color=never',
          '-nostdinc', '-isystem', headerRoots[family], '-isystem', path.join(sysroot, 'include/wasm32-wasi'),
          ...(cpp ? ['-fno-exceptions', '-fno-rtti'] : []), ...flags];
        const compiled = command(toolPaths[family + (cpp ? 'Cpp' : '')], family === 'gcc'
          ? ['-quiet', '-D__GCC_WASI_SINGLE_THREAD__=1', '-Wvector-operation-performance', ...common, file, '-o', assembly]
          : ['--target=wasm32-wasi', '--sysroot', sysroot, '-fno-vectorize', '-fno-slp-vectorize', ...common, '-c', file, '-o', object]);
        result.compilerSimdFlags = compiled.argv.filter(flag => /^-m(?:no-)?simd128$/u.test(flag)); assert.deepEqual(result.compilerSimdFlags, flags);
        if (family === 'gcc') {
          const text = await fs.readFile(assembly, 'utf8'); result.assembly = await artifact(assembly);
          result.watOperation = permutationWatInstructions(text, fixture.operationFunction);
          verifyRuntimePermutationInstructions(fixture, result.watOperation);
          result.piecewiseWarning = /vector shuffling operation will be expanded piecewise/u.test(compiled.stderr);
          if (fixture.semanticKind === 'scalar-runtime-permutation') assert(result.piecewiseWarning, 'GCC did not confirm piecewise permutation lowering');
          command(toolPaths.assembler, ['-r', '--enable-annotations', assembly, '-o', object]);
        }
        const disassembly = command(toolPaths.objdump, ['-d', object]).stdout;
        const disassemblyFile = path.join(dir, 'object.disassembly.txt'); await fs.writeFile(disassemblyFile, disassembly, { flag: 'wx' });
        result.disassembly = await artifact(disassemblyFile); result.object = await artifact(object);
        assert.equal(WebAssembly.Module.customSections(new WebAssembly.Module(await fs.readFile(object)), 'linking').length, 1);
        result.operation = permutationInstructions(disassembly, fixture.operationFunction);
        if (family === 'gcc' || fixture.semanticKind === 'constant-permutation') verifyRuntimePermutationInstructions(fixture, result.operation);
        command(toolPaths.linker, ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', program,
          path.join(library, 'crt1-command.o'), '-L' + library, object, '-lm', '-lc', builtins]);
        result.program = await artifact(program);
        const module = new WebAssembly.Module(await fs.readFile(program));
        result.imports = WebAssembly.Module.imports(module); result.exports = WebAssembly.Module.exports(module);
        assert(result.imports.every(item => item.module === 'wasi_snapshot_preview1' && item.kind === 'function'));
        assert(result.exports.some(item => item.name === '_start' && item.kind === 'function'));
        assert(result.exports.some(item => item.name === 'memory' && item.kind === 'memory'));
        const executed = command(toolPaths.node, ['--disable-warning=ExperimentalWarning', runner, program], fixture.stdin);
        assert.equal(executed.stdout, fixture.stdout); assert.equal(executed.stderr, ''); result.stdout = executed.stdout;
        result.disabledSimdValidation = run(toolPaths.validator, ['--disable-simd', program]);
        assert.equal(result.disabledSimdValidation.status, fixture.feature === 'enabled' ? 1 : 0);
        assert.equal(result.disabledSimdValidation.signal, null); assert(!result.disabledSimdValidation.error);
        result.status = 'passed';
      }
      entry.status = 'passed';
    } catch (error) { entry.status = 'failed'; entry.error = error.stack; }
    await fs.writeFile(path.join(output, 'progress.json'), JSON.stringify({ completed: report.cases.length,
      total: fixtures.length, lastCase: entry.id, passed: report.cases.filter(item => item.status === 'passed').length }) + '\n');
    console.log(JSON.stringify({ id: entry.id, status: entry.status, ...(entry.error ? { error: entry.error } : {}) }));
  }
  for (const [file, expected] of inputs) assert.deepEqual(identity(await fs.readFile(file)), expected, 'Changed qualification input: ' + file);
  for (const entry of report.cases) for (const result of Object.values(entry.results)) for (const field of ['source', 'assembly', 'object', 'disassembly', 'program'])
    if (result[field]) assert.deepEqual(await artifact(result[field].path), result[field], 'Changed qualification artifact: ' + result[field].path);
  report.inputsUnchanged = true;
  report.counts = { fixtures: report.cases.length, runtimeFixtures: fixtures.filter(fixture => fixture.semanticKind === 'scalar-runtime-permutation').length,
    constantFixtures: fixtures.filter(fixture => fixture.semanticKind === 'constant-permutation').length,
    gccExecutions: report.cases.filter(entry => entry.results.gcc?.status === 'passed').length,
    clangExecutions: report.cases.filter(entry => entry.results.clang?.status === 'passed').length,
    enabled: fixtures.filter(fixture => fixture.feature === 'enabled').length,
    disabled: fixtures.filter(fixture => fixture.feature === 'disabled').length,
    noFlagDefaults: fixtures.filter(fixture => fixture.feature === 'default').length };
  report.status = report.cases.every(entry => entry.status === 'passed') ? 'passed' : 'failed';
} catch (error) { report.status = 'failed'; report.error = error.stack; }
report.finishedAt = new Date().toISOString();
await fs.writeFile(path.join(output, 'qualification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: report.status, counts: report.counts, error: report.error }));
process.exitCode = report.status === 'passed' ? 0 : 1;
