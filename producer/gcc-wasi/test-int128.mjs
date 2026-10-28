#!/usr/bin/env node
// Usage: node test-int128.mjs --compiler BUILD/gcc --source GCC_SOURCE
//   --work PRODUCER_WORK --sdk WASI_SDK --sysroot SYSROOT --output NEW_DIRECTORY
//   [--directions gcc-gcc,gcc-clang,clang-gcc,clang-clang] [--cases ID,...]
//   [--optimizations 0,2] [--printscan ARCHIVE] [--gcc-cxx-sysroot SYSROOT]
//   [--clang-sysroot SYSROOT]
// Clang-only oracle: omit --compiler/--source and select --directions clang-clang.
// Sources are never translated. A direction means main compiler / provider
// compiler. Non-interop cases run only same-compiler controls. Every failure,
// command, WAT/IR, object, linked program and actual stdin/stdout is retained.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases } from './int128-fixtures.mjs';
import { inspectVectorAbi } from './inspect-vector-abi.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  assert(['compiler', 'source', 'work', 'sdk', 'sysroot', 'output', 'cases', 'optimizations', 'directions',
    'printscan', 'gcc-cxx-sysroot', 'clang-sysroot'].includes(key) && process.argv[i + 1], `Invalid argument ${process.argv[i]}`);
  assert(!Object.hasOwn(options, key), `Repeated --${key}`); options[key] = process.argv[i + 1];
}
for (const key of ['work', 'sdk', 'output']) assert(options[key], `Required --${key}`);
const directions = (options.directions || 'gcc-gcc,gcc-clang,clang-gcc,clang-clang').split(',');
assert(directions.length === new Set(directions).size);
assert(directions.every(d => ['gcc-gcc', 'gcc-clang', 'clang-gcc', 'clang-clang'].includes(d)), 'Unknown direction');
const usesGcc = directions.some(d => d.split('-').includes('gcc'));
if (usesGcc) for (const key of ['compiler', 'source']) assert(options[key], `Required --${key} for actual GCC qualification`);
const sdk = path.resolve(options.sdk), work = path.resolve(options.work), output = path.resolve(options.output);
const compiler = options.compiler && path.resolve(options.compiler), source = options.source && path.resolve(options.source);
const sysroot = path.resolve(options.sysroot || path.join(sdk, 'share/wasi-sysroot'));
const clangSysroot = path.resolve(options['clang-sysroot'] || path.join(sdk, 'share/wasi-sysroot'));
const gccCxxSysroot = path.resolve(options['gcc-cxx-sysroot'] || sysroot);
const library = path.join(sysroot, 'lib/wasm32-wasi');
let selected = cases;
if (options.cases) {
  const ids = options.cases.split(',');
  assert(ids.length === new Set(ids).size && ids.every(id => cases.some(c => c.id === id)), 'Unknown/duplicate fixture');
  selected = selected.filter(c => ids.includes(c.id));
}
if (options.optimizations) {
  const levels = options.optimizations.split(',');
  assert(levels.every(level => ['0', '2'].includes(level)), 'Only O0/O2 are qualified');
  selected = selected.filter(c => levels.includes(c.request.optimization));
}
assert(selected.length, 'Empty fixture selection');
const tools = {
  ...(usesGcc ? { gcc: path.join(compiler, 'cc1'), gccCpp: path.join(compiler, 'cc1plus') } : {}),
  clang: path.join(sdk, 'bin/clang'), assembler: path.join(work, 'wabt-native/wat2wasm'),
  inspector: path.join(work, 'wabt-native/wasm-objdump'), linker: path.join(sdk, 'bin/wasm-ld'), node: process.execPath,
};
const runtime = Object.fromEntries(['crt1-command.o', 'libc.a', 'libm.a'].map(name => [name, path.join(library, name)]));
runtime.builtins = path.join(sdk, 'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a');
if (selected.some(c => c.printscan)) runtime.printscan = path.resolve(options.printscan || path.join(library, 'libc-printscan-long-double.a'));
const stdcpp = {};
if (selected.some(c => c.stdcpp)) {
  if (usesGcc) {
    const base = path.join(gccCxxSysroot, 'include/c++');
    const versions = (await fs.readdir(base)).filter(name => /^\d+\.\d+\.\d+$/.test(name));
    assert.equal(versions.length, 1, 'Select a GCC C++ sysroot containing exactly one header version');
    stdcpp.gccInclude = path.join(base, versions[0]);
    const targets = (await fs.readdir(stdcpp.gccInclude)).filter(name => name.startsWith('wasm32-'));
    assert.equal(targets.length, 1, 'Expected one GNU C++ target configuration');
    stdcpp.gccTargetInclude = path.join(stdcpp.gccInclude, targets[0]);
    stdcpp.gccBackwardInclude = path.join(stdcpp.gccInclude, 'backward');
    runtime.gnuCpp = path.join(gccCxxSysroot, 'lib/wasm32-wasi/libstdc++.a');
    runtime.gnuAbi = path.join(gccCxxSysroot, 'lib/wasm32-wasi/libsupc++.a');
  }
  if (directions.includes('clang-clang')) {
    runtime.clangCpp = path.join(clangSysroot, 'lib/wasm32-wasi/noeh/libc++.a');
    runtime.clangAbi = path.join(clangSysroot, 'lib/wasm32-wasi/noeh/libc++abi.a');
  }
}
const digest = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const identify = async p => ({ path: p, ...digest(await fs.readFile(p)) });
async function identifyMap(map) {
  const result = {};
  for (const [key, p] of Object.entries(map)) result[key] = await identify(p);
  return result;
}
async function treeIdentity(root) {
  const result = {};
  async function visit(dir) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(p);
      else result[path.relative(root, p)] = await identify(p);
    }
  }
  await visit(root); return result;
}
function run(command, argv, cwd = output, input) {
  const r = spawnSync(command, argv, { cwd, input, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  return { command, argv, status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.message };
}
await fs.mkdir(output); // Preserve every prior success/failure; output must be new.
const recipes = { fixtures: path.join(here, 'int128-fixtures.mjs'), harness: fileURLToPath(import.meta.url), inspector: path.join(here, 'inspect-vector-abi.mjs') };
const headerRoots = { libc: path.join(sysroot, 'include'), clangLibc: path.join(clangSysroot, 'include'), clangResource: path.join(sdk, 'lib/clang/22/include') };
if (usesGcc) headerRoots.gcc = path.join(compiler, 'include');
if (stdcpp.gccInclude) headerRoots.gnuCpp = stdcpp.gccInclude;
const headers = {};
for (const [name, p] of Object.entries(headerRoots)) headers[name] = await treeIdentity(p);
const report = {
  schemaVersion: 1, kind: 'gcc-wasi-int128-qualification', status: 'running',
  compilerHost: 'native', outputTarget: 'wasm32-wasi', directions, selectedCases: selected.map(c => c.id),
  suiteSha256: digest(Buffer.from(JSON.stringify(selected))).sha256,
  coverage: usesGcc ? 'Real GCC compilation; Clang is an independent comparison compiler, never a fallback.' : 'Clang-only reference; this does not qualify GCC.',
  tools: await identifyMap(tools), runtime: await identifyMap(runtime), recipes: await identifyMap(recipes), headers,
  targetSource: source ? await treeIdentity(path.join(source, 'gcc/config/wasm')) : null, cases: [],
};
if (source) {
  const revision = run('git', ['-C', source, 'rev-parse', 'HEAD']); assert.equal(revision.status, 0, revision.stderr);
  report.gccCommit = revision.stdout.trim();
  const lock = JSON.parse(await fs.readFile(path.join(here, 'sources.lock.json')));
  assert.equal(report.gccCommit, lock.gcc.commit);
}
const runner = path.join(output, 'run-wasi.mjs');
await fs.writeFile(runner, `import { WASI } from 'node:wasi';
import { readFile } from 'node:fs/promises';
const wasi = new WASI({ version:'preview1', args:['program'], env:{}, returnOnExit:true });
const module = await WebAssembly.compile(await readFile(process.argv[2]));
const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1:wasi.wasiImport });
process.exitCode = wasi.start(instance);
`);
async function save() { await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
await save();
for (const fixture of selected) for (const direction of directions) {
  const families = direction.split('-');
  if (!fixture.interop && families[0] !== families[1]) continue;
  const id = `${fixture.id}-${direction}`, directory = path.join(output, id);
  await fs.mkdir(directory);
  const entry = { id, fixture: fixture.id, optimization: fixture.request.optimization, direction,
    fixtureSha256: digest(Buffer.from(JSON.stringify(fixture))).sha256,
    status: 'running', features: fixture.features, expectedStdout: fixture.stdout, stdin: fixture.stdin, units: [], commands: [] };
  report.cases.push(entry);
  function command(tool, argv, input) {
    const r = run(tool, argv, directory, input); entry.commands.push(r);
    assert.equal(r.status, 0, `${id}: ${r.stderr || r.error || `exit ${r.status}`}`); return r;
  }
  try {
    const cpp = fixture.request.language === 'cpp', main = cpp ? 'main.cpp' : 'main.c';
    const files = [{ path: main, contents: fixture.request.code }, ...(fixture.request.files || [])];
    for (const file of files) {
      const p = path.resolve(directory, file.path);
      assert(p.startsWith(directory + path.sep), 'Fixture path escapes output');
      await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, file.contents);
    }
    const objects = [];
    for (const [index, unit] of [main, ...(fixture.request.sources || [])].entries()) {
      const family = families[index === 0 ? 0 : 1], input = path.join(directory, unit);
      const object = path.join(directory, `unit${index}.o`), assembly = path.join(directory, `unit${index}.${family === 'gcc' ? 'wat' : 'll'}`);
      const common = [`-O${fixture.request.optimization}`, `-std=${fixture.request.standard}`, fixture.request.simd ? '-msimd128' : '-mno-simd128',
        '-D__GCC_WASI_SINGLE_THREAD__=1', ...(fixture.request.defines || []).map(value => `-D${value}`),
        ...(cpp ? ['-fno-exceptions', '-fno-rtti', '-fuse-cxa-atexit', '-fno-threadsafe-statics'] : [])];
      if (family === 'gcc') {
        command(tools[cpp ? 'gccCpp' : 'gcc'], ['-quiet', ...common, '-fdiagnostics-color=never', '-Werror=attributes', '-Werror=pragmas',
          '-nostdinc', '-isysroot', sysroot,
          ...(fixture.stdcpp ? ['-isystem', stdcpp.gccInclude, '-isystem', stdcpp.gccTargetInclude, '-isystem', stdcpp.gccBackwardInclude] : []),
          '-isystem', path.join(compiler, 'include'), '-isystem', path.join(sysroot, 'include/wasm32-wasi'),
          '-isystem', path.join(sysroot, 'include'), input, '-o', assembly]);
        command(tools.assembler, ['-r', '--enable-annotations', assembly, '-o', object]);
      } else {
        const flags = ['--target=wasm32-wasi', `--sysroot=${clangSysroot}`, ...common, ...(cpp ? ['-x', 'c++'] : [])];
        command(tools.clang, [...flags, '-S', '-emit-llvm', input, '-o', assembly]);
        command(tools.clang, [...flags, '-c', input, '-o', object]);
      }
      const objectBytes = await fs.readFile(object), module = new WebAssembly.Module(objectBytes);
      assert.equal(WebAssembly.Module.customSections(module, 'linking').length, 1, 'Missing relocatable object metadata');
      const disassembly = command(tools.inspector, ['-dx', object]);
      await fs.writeFile(path.join(directory, `unit${index}.disassembly.txt`), disassembly.stdout);
      entry.units.push({ compiler: family, source: await identify(input), assembly: await identify(assembly), object: await identify(object) }); objects.push(object);
    }
    const program = path.join(directory, 'program.wasm');
    const stdlibs = !fixture.stdcpp ? [] : families[0] === 'gcc' ? [runtime.gnuCpp, runtime.gnuAbi] : [runtime.clangCpp, runtime.clangAbi];
    command(tools.linker, ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', program,
      ...Object.keys(fixture.signatures).map(name => `--export=${name}`), runtime['crt1-command.o'], ...objects,
      ...stdlibs, ...(fixture.printscan ? [runtime.printscan] : []), `-L${library}`, '-lm', '-lc', runtime.builtins]);
    const bytes = await fs.readFile(program), module = new WebAssembly.Module(bytes);
    entry.program = await identify(program); entry.imports = WebAssembly.Module.imports(module); entry.exports = WebAssembly.Module.exports(module);
    assert(entry.imports.every(i => i.module === 'wasi_snapshot_preview1' && i.kind === 'function'));
    entry.abi = inspectVectorAbi(bytes);
    assert.equal(entry.abi.memories.length, 1); assert.equal(entry.abi.memories[0].shared, false);
    assert.deepEqual(entry.abi.exports._start, { params: [], results: [] });
    for (const [name, signature] of Object.entries(fixture.signatures)) assert.deepEqual(entry.abi.exports[name], signature, `${name} 128-bit integer ABI`);
    const executed = command(tools.node, ['--disable-warning=ExperimentalWarning', runner, program], fixture.stdin);
    entry.stdout = executed.stdout; entry.stderr = executed.stderr;
    assert.equal(executed.stdout, fixture.stdout, 'Actual WASI stdout differs'); assert.equal(executed.stderr, ''); entry.status = 'passed';
  } catch (error) { entry.status = 'failed'; entry.error = error.message; }
  await save(); console.log(`${id}: ${entry.status}${entry.error ? `: ${entry.error.slice(0, 1200)}` : ''}`);
}
try {
  assert.deepEqual(await identifyMap(tools), report.tools, 'Compiler/tool input changed');
  assert.deepEqual(await identifyMap(runtime), report.runtime, 'Runtime input changed');
  assert.deepEqual(await identifyMap(recipes), report.recipes, 'Fixture/harness/inspector changed');
  if (source) assert.deepEqual(await treeIdentity(path.join(source, 'gcc/config/wasm')), report.targetSource, 'Backend source changed');
  for (const [name, p] of Object.entries(headerRoots)) assert.deepEqual(await treeIdentity(p), report.headers[name], `Header tree changed: ${name}`);
  report.inputsUnchanged = true;
} catch (error) { report.inputsUnchanged = false; report.integrityError = error.message; }
report.counts = { total: report.cases.length, passed: report.cases.filter(c => c.status === 'passed').length, failed: report.cases.filter(c => c.status === 'failed').length };
report.status = report.inputsUnchanged && report.counts.total > 0 && report.counts.failed === 0 ? 'passed' : 'failed';
await save(); console.log(JSON.stringify(report.counts)); process.exitCode = report.status === 'passed' ? 0 : 1;
