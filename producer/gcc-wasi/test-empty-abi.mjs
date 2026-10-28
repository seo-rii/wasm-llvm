#!/usr/bin/env node
// node test-empty-abi.mjs --compiler BUILD/gcc --source GCC_SOURCE --work WORK
//   --sdk WASI_SDK --sysroot SYSROOT --output NEW_DIRECTORY
//   [--directions gcc-gcc,gcc-clang,clang-gcc,clang-clang] [--cases ID,...]
// Clang-only oracle: omit --compiler/--source and use --directions clang-clang.
// This runs real objects and stdin/stdout; matching GCC-only calls cannot prove
// the mixed-compiler ABI. All commands and failed intermediates are retained.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases } from './empty-abi-fixtures.mjs';
import { inspectVectorAbi } from './inspect-vector-abi.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index], key = flag.replace(/^--/, '');
  assert(flag.startsWith('--') && ['compiler', 'source', 'work', 'sdk', 'sysroot', 'output',
    'directions', 'cases', 'optimizations'].includes(key), `Unknown argument ${flag}`);
  assert(!Object.hasOwn(options, key) && process.argv[index + 1], `Missing or duplicate ${flag}`);
  options[key] = process.argv[index + 1];
}
for (const key of ['work', 'sdk', 'output']) assert(options[key], `Required --${key}`);
const directions = (options.directions || 'gcc-gcc,gcc-clang,clang-gcc,clang-clang').split(',');
assert.equal(directions.length, new Set(directions).size, 'Duplicate direction');
assert(directions.every(value => ['gcc-gcc', 'gcc-clang', 'clang-gcc', 'clang-clang'].includes(value)), 'Unknown direction');
const usesGcc = directions.some(value => value.split('-').includes('gcc'));
if (usesGcc) for (const key of ['compiler', 'source']) assert(options[key], `Required --${key}`);
const sdk = path.resolve(options.sdk), work = path.resolve(options.work), output = path.resolve(options.output);
const sysroot = path.resolve(options.sysroot || path.join(sdk, 'share/wasi-sysroot'));
const compiler = options.compiler && path.resolve(options.compiler), source = options.source && path.resolve(options.source);
let selected = cases;
if (options.cases) {
  const ids = options.cases.split(',');
  assert.equal(ids.length, new Set(ids).size, 'Duplicate fixture');
  assert(ids.every(id => cases.some(value => value.id === id)), 'Unknown fixture');
  selected = selected.filter(value => ids.includes(value.id));
}
if (options.optimizations) {
  const levels = options.optimizations.split(',');
  assert(levels.every(level => ['0', '2'].includes(level)), 'Only O0/O2 are qualified');
  selected = selected.filter(value => levels.includes(value.request.optimization));
}
assert(selected.length > 0, 'Empty fixture selection');
const tools = {
  ...(usesGcc ? { gcc: path.join(compiler, 'cc1'), gccCpp: path.join(compiler, 'cc1plus') } : {}),
  clang: path.join(sdk, 'bin/clang'), assembler: path.join(work, 'wabt-native/wat2wasm'),
  inspector: path.join(work, 'wabt-native/wasm-objdump'), linker: path.join(sdk, 'bin/wasm-ld'), node: process.execPath,
};
const library = path.join(sysroot, 'lib/wasm32-wasi');
const runtime = Object.fromEntries(['crt1-command.o', 'libc.a', 'libm.a'].map(name => [name, path.join(library, name)]));
runtime.builtins = path.join(sdk, 'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a');
const recipes = { fixtures: path.join(here, 'empty-abi-fixtures.mjs'), harness: fileURLToPath(import.meta.url),
  inspector: path.join(here, 'inspect-vector-abi.mjs'), sourceLock: path.join(here, 'sources.lock.json') };
const digest = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const identify = async location => ({ path: location, ...digest(await fs.readFile(location)) });
async function identifyMap(map) {
  return Object.fromEntries(await Promise.all(Object.entries(map).map(async ([key, location]) => [key, await identify(location)])));
}
async function treeIdentity(directory) {
  const values = {};
  async function visit(location) {
    for (const entry of (await fs.readdir(location, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(location, entry.name);
      if (entry.isDirectory()) await visit(target);
      else values[path.relative(directory, target)] = await identify(target);
    }
  }
  await visit(directory); return values;
}
function run(command, argv, cwd = output, input) {
  const result = spawnSync(command, argv, { cwd, input, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  return { command, argv, status: result.status, signal: result.signal, stdout: result.stdout || '',
    stderr: result.stderr || '', error: result.error?.message };
}
await fs.mkdir(output); // Never overwrite prior success or failure evidence.
const headerRoots = { libc: path.join(sysroot, 'include'), clangResource: path.join(sdk, 'lib/clang/22/include'),
  ...(usesGcc ? { gcc: path.join(compiler, 'include') } : {}) };
const headers = {};
for (const [name, location] of Object.entries(headerRoots)) headers[name] = await treeIdentity(location);
const report = {
  schemaVersion: 1, kind: 'gcc-wasi-empty-record-abi-qualification', status: 'running',
  compilerHost: 'native', outputTarget: 'wasm32-wasi', directions, selectedCases: selected.map(value => value.id),
  suiteSha256: digest(Buffer.from(JSON.stringify(selected))).sha256,
  coverage: usesGcc ? 'Real GCC compilation, with independent Clang object interoperation; no compilation fallback.'
    : 'Clang-only independent oracle; this does not qualify GCC.',
  tools: await identifyMap(tools), runtime: await identifyMap(runtime), recipes: await identifyMap(recipes), headers,
  targetSource: source ? await treeIdentity(path.join(source, 'gcc/config/wasm')) : null, cases: [],
};
if (usesGcc) {
  const buildPath = path.join(work, 'native-build.json');
  recipes.build = buildPath;
  report.recipes.build = await identify(buildPath);
  const build = JSON.parse(await fs.readFile(buildPath));
  const lock = JSON.parse(await fs.readFile(recipes.sourceLock));
  const revision = run('git', ['-C', source, 'rev-parse', 'HEAD']);
  assert.equal(revision.status, 0, revision.stderr);
  assert.equal(revision.stdout.trim(), lock.gcc.commit);
  assert.equal(build.gccCommit, lock.gcc.commit);
  assert.equal(build.sourceLockSha256, report.recipes.sourceLock.sha256, 'Native compiler was built against a different patch lock');
  for (const [name, tool] of [['cc1', 'gcc'], ['cc1plus', 'gccCpp']])
    assert.equal(build.tools[name].sha256, report.tools[tool].sha256, `${name} build identity`);
  report.gccCommit = build.gccCommit;
  report.nativeBuild = build;
}
const runner = path.join(output, 'run-wasi.mjs');
await fs.writeFile(runner, `import {WASI} from 'node:wasi';
import {readFile} from 'node:fs/promises';
const wasi=new WASI({version:'preview1',args:['program'],env:{},returnOnExit:true});
const module=await WebAssembly.compile(await readFile(process.argv[2]));
const instance=await WebAssembly.instantiate(module,{wasi_snapshot_preview1:wasi.wasiImport});
process.exitCode=wasi.start(instance);
`);
async function save() { await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
await save();
for (const fixture of selected) for (const direction of directions) {
  const directory = path.join(output, `${fixture.id}-${direction}`);
  await fs.mkdir(directory);
  const entry = { id: `${fixture.id}-${direction}`, fixture: fixture.id, direction,
    optimization: fixture.request.optimization, expectedClassification: fixture.expectedClassification,
    fixtureSha256: digest(Buffer.from(JSON.stringify(fixture))).sha256, features: fixture.features,
    stdin: fixture.stdin, expectedStdout: fixture.stdout, status: 'running', commands: [], units: [] };
  report.cases.push(entry);
  function command(tool, argv, input) {
    const result = run(tool, argv, directory, input); entry.commands.push(result);
    assert.equal(result.status, 0, `${entry.id}: ${result.stderr || result.error || `exit ${result.status}`}`); return result;
  }
  try {
    const cpp = fixture.request.language === 'cpp', main = cpp ? 'main.cpp' : 'main.c';
    for (const file of [{ path: main, contents: fixture.request.code }, ...fixture.request.files]) {
      const target = path.resolve(directory, file.path);
      assert(target.startsWith(directory + path.sep), 'Fixture path escapes output');
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, file.contents);
    }
    const objects = [];
    for (const [index, unit] of [main, ...fixture.request.sources].entries()) {
      const family = direction.split('-')[index === 0 ? 0 : 1], input = path.join(directory, unit);
      const object = path.join(directory, `unit${index}.o`), assembly = path.join(directory, `unit${index}.${family === 'gcc' ? 'wat' : 'll'}`);
      const common = [`-O${fixture.request.optimization}`, `-std=${fixture.request.standard}`, '-mno-simd128',
        '-D__GCC_WASI_SINGLE_THREAD__=1', ...fixture.request.defines.map(value => `-D${value}`),
        ...(cpp ? ['-fno-exceptions', '-fno-rtti', '-fuse-cxa-atexit', '-fno-threadsafe-statics'] : [])];
      if (family === 'gcc') {
        command(tools[cpp ? 'gccCpp' : 'gcc'], ['-quiet', ...common, '-fdiagnostics-color=never', '-Werror=attributes', '-Werror=pragmas',
          '-nostdinc', '-isysroot', sysroot, '-isystem', path.join(compiler, 'include'),
          '-isystem', path.join(sysroot, 'include/wasm32-wasi'), '-isystem', path.join(sysroot, 'include'), input, '-o', assembly]);
        command(tools.assembler, ['-r', '--enable-annotations', assembly, '-o', object]);
      } else {
        const flags = ['--target=wasm32-wasi', `--sysroot=${sysroot}`, ...common, ...(cpp ? ['-x', 'c++'] : [])];
        command(tools.clang, [...flags, '-S', '-emit-llvm', input, '-o', assembly]);
        command(tools.clang, [...flags, '-c', input, '-o', object]);
      }
      const bytes = await fs.readFile(object), module = new WebAssembly.Module(bytes);
      assert.equal(WebAssembly.Module.customSections(module, 'linking').length, 1, 'Expected relocatable Wasm object');
      const inspection = command(tools.inspector, ['-dx', object]);
      await fs.writeFile(path.join(directory, `unit${index}.disassembly.txt`), inspection.stdout);
      entry.units.push({ compiler: family, source: await identify(input), assembly: await identify(assembly), object: await identify(object) });
      objects.push(object);
    }
    const program = path.join(directory, 'program.wasm');
    command(tools.linker, ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', program,
      ...Object.keys(fixture.signatures).map(name => `--export=${name}`), runtime['crt1-command.o'], ...objects,
      `-L${library}`, '-lm', '-lc', runtime.builtins]);
    const bytes = await fs.readFile(program), module = new WebAssembly.Module(bytes);
    entry.program = await identify(program); entry.imports = WebAssembly.Module.imports(module); entry.exports = WebAssembly.Module.exports(module);
    assert(entry.imports.every(value => value.module === 'wasi_snapshot_preview1' && value.kind === 'function'));
    entry.abi = inspectVectorAbi(bytes);
    assert.equal(entry.abi.memories.length, 1); assert.equal(entry.abi.memories[0].shared, false);
    assert.deepEqual(entry.abi.exports._start, { params: [], results: [] });
    for (const [name, signature] of Object.entries(fixture.signatures))
      assert.deepEqual(entry.abi.exports[name], signature, `${name}: empty-record ABI`);
    const executed = command(tools.node, ['--disable-warning=ExperimentalWarning', runner, program], fixture.stdin);
    entry.stdout = executed.stdout; entry.stderr = executed.stderr;
    assert.equal(executed.stdout, fixture.stdout, 'Actual WASI stdout differs'); assert.equal(executed.stderr, '');
    entry.status = 'passed';
  } catch (error) { entry.status = 'failed'; entry.error = error.message; }
  await save(); console.log(`${entry.id}: ${entry.status}${entry.error ? ': ' + entry.error.slice(0, 1200) : ''}`);
}
try {
  assert.deepEqual(await identifyMap(tools), report.tools, 'Tool input changed');
  assert.deepEqual(await identifyMap(runtime), report.runtime, 'Runtime input changed');
  assert.deepEqual(await identifyMap(recipes), report.recipes, 'Recipe or compiler build receipt changed');
  if (source) assert.deepEqual(await treeIdentity(path.join(source, 'gcc/config/wasm')), report.targetSource, 'Backend source changed');
  for (const [name, location] of Object.entries(headerRoots)) assert.deepEqual(await treeIdentity(location), report.headers[name], `Headers changed: ${name}`);
  report.inputsUnchanged = true;
} catch (error) { report.inputsUnchanged = false; report.integrityError = error.message; }
report.counts = { total: report.cases.length, passed: report.cases.filter(value => value.status === 'passed').length,
  failed: report.cases.filter(value => value.status === 'failed').length };
report.status = report.inputsUnchanged && report.counts.total > 0 && report.counts.failed === 0 ? 'passed' : 'failed';
await save(); console.log(JSON.stringify(report.counts)); process.exitCode = report.status === 'passed' ? 0 : 1;
