#!/usr/bin/env node
// Real GCC ↔ Clang WASI object interop; Clang is explicitly a comparison oracle.
// node producer/gcc-wasi/abi-interop.mjs --sdk "$WASI_SDK_PATH" \
//   --compiler-dir /path/to/gcc-build/gcc --output out/fresh-interop-report
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases } from './abi-interop-cases.mjs';

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert(['--work', '--sdk', '--sysroot', '--compiler-dir', '--output', '--cases', '--optimizations', '--directions'].includes(process.argv[i]), `Unknown argument ${process.argv[i]}`);
  assert(process.argv[i + 1], `Missing value for ${process.argv[i]}`);
  options[process.argv[i].slice(2)] = process.argv[i + 1];
}
const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(options.work || 'out/gcc-wasi-work');
const compiler = path.resolve(options['compiler-dir'] || path.join(work, 'gcc-native/gcc'));
assert(options.sdk || process.env.WASI_SDK_PATH, 'Supply --sdk or WASI_SDK_PATH');
const sdk = path.resolve(options.sdk || process.env.WASI_SDK_PATH);
const sysroot = path.resolve(options.sysroot || path.join(work, 'runtime-single-thread/sysroot'));
const output = path.resolve(options.output || path.join(work, 'abi-interop'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = async name => digest(await fs.readFile(name));
let selected = cases;
if (options.cases) {
  const ids = options.cases.split(',');
  for (const id of ids) assert(cases.some(c => c.id === id), `Unknown case ${id}`);
  selected = cases.filter(c => ids.includes(c.id));
}
const optimizations = (options.optimizations || '0,2').split(',');
assert(optimizations.every(v => ['0', '1', '2', '3', 's'].includes(v)));
const directions = (options.directions || 'gcc-gcc,gcc-clang,clang-gcc,clang-clang').split(',');
assert(directions.every(v => ['gcc-gcc', 'gcc-clang', 'clang-gcc', 'clang-clang'].includes(v)));
await fs.mkdir(output); // Preserve previous failure evidence: never reuse a report directory.
const tools = {
  gcc: path.join(compiler, 'cc1'),
  gccCpp: path.join(compiler, 'cc1plus'),
  clang: path.join(sdk, 'bin/clang'),
  assembler: path.join(work, 'wabt-native/wat2wasm'),
  linker: path.join(sdk, 'bin/wasm-ld'),
};
const report = {
  schemaVersion: 1, kind: 'gcc-wasi-basic-c-abi-interop', status: 'running',
  compilerHost: 'native', outputTarget: 'wasm32-wasi',
  gccCommit: JSON.parse(await fs.readFile(path.join(here, 'sources.lock.json'))).gcc.commit,
  comparisonCompilerOnly: 'Clang builds independent interop caller/callee objects; no source compilation fallback.',
  harnessSha256: await hashFile(fileURLToPath(import.meta.url)),
  fixturesSha256: await hashFile(path.join(here, 'abi-interop-cases.mjs')),
  tools: Object.fromEntries(await Promise.all(Object.entries(tools).map(async ([name, location]) => [name, { path: location, sha256: await hashFile(location) }]))),
  runtime: Object.fromEntries(await Promise.all(['crt1-command.o', 'libc.a', 'libm.a'].map(async name => {
    const location = path.join(sysroot, 'lib/wasm32-wasi', name);
    return [name, { path: location, sha256: await hashFile(location) }];
  }))),
  cases: [],
};
const runner = path.join(output, 'run-wasi.mjs');
await fs.writeFile(runner, `import {WASI} from 'node:wasi'; import {readFile} from 'node:fs/promises'; import assert from 'node:assert/strict';
const wasi = new WASI({version:'preview1', args:['program'], env:{}, returnOnExit:true});
const m=await WebAssembly.compile(await readFile(process.argv[2]));
const i=await WebAssembly.instantiate(m,{wasi_snapshot_preview1:wasi.wasiImport});
process.exitCode=wasi.start(i);
for(const [name,args,value] of JSON.parse(process.argv[3] || '[]')) assert.equal(i.exports[name](...args),value,name);
`);
function run(command, argv, cwd, input) {
  const value = spawnSync(command, argv, { cwd, input, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  return { command, argv, status: value.status, signal: value.signal, stdout: value.stdout || '', stderr: value.stderr || '', error: value.error?.message };
}
for (const fixture of selected) for (const optimization of optimizations) for (const direction of directions) {
  const id = `${fixture.id}-o${optimization}-${direction}`;
  const entry = { id, fixture: fixture.id, optimization, direction, status: 'running', commands: [], units: [] };
  report.cases.push(entry);
  try {
    const directory = path.join(output, id);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'main.c'), fixture.request.code);
    for (const file of fixture.request.files) {
      assert(!path.isAbsolute(file.path) && !file.path.split('/').includes('..'));
      await fs.writeFile(path.join(directory, file.path), file.contents);
    }
    const objects = [];
    for (const [index, source] of ['main.c', ...fixture.request.sources].entries()) {
      const family = direction.split('-')[index === 0 ? 0 : 1];
      const cpp = fixture.request.language === 'cpp';
      const object = path.join(directory, `unit${index}.o`);
      const wat = path.join(directory, `unit${index}.wat`);
      const argv = family === 'gcc'
        ? ['-quiet', `-O${optimization}`, `-std=${fixture.request.standard}`, '-fdiagnostics-color=never', '-D__GCC_WASI_SINGLE_THREAD__=1', '-nostdinc', '-isystem', path.join(compiler, 'include'), '-isystem', path.join(sysroot, 'include/wasm32-wasi'), ...(cpp ? ['-fno-exceptions', '-fno-rtti', '-fuse-cxa-atexit', '-fno-threadsafe-statics'] : []), path.join(directory, source), '-o', wat]
        : ['--target=wasm32-wasi', `--sysroot=${sysroot}`, `-O${optimization}`, `-std=${fixture.request.standard}`, ...(cpp ? ['-x', 'c++', '-fno-exceptions', '-fno-rtti'] : []), '-D__GCC_WASI_SINGLE_THREAD__=1', '-c', path.join(directory, source), '-o', object];
      let result = run(tools[family === 'gcc' && cpp ? 'gccCpp' : family], argv, directory);
      entry.commands.push(result); assert.equal(result.status, 0, result.stderr);
      if (family === 'gcc') {
        result = run(tools.assembler, ['-r', '--enable-annotations', wat, '-o', object], directory);
        entry.commands.push(result); assert.equal(result.status, 0, result.stderr);
      }
      const bytes = await fs.readFile(object);
      const module = new WebAssembly.Module(bytes);
      assert.equal(WebAssembly.Module.customSections(module, 'linking').length, 1);
      entry.units.push({ source, compiler: family, object: path.relative(output, object), sha256: digest(bytes), bytes: bytes.length });
      objects.push(object);
    }
    const program = path.join(directory, 'program.wasm');
    const library = path.join(sysroot, 'lib/wasm32-wasi');
    let result = run(tools.linker, ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', program,
      ...(fixture.exports || []).map(name => `--export=${name}`),
      path.join(library, 'crt1-command.o'), `-L${library}`, ...objects, '-lm', '-lc', path.join(sdk, 'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a')], directory);
    entry.commands.push(result); assert.equal(result.status, 0, result.stderr);
    const bytes = await fs.readFile(program);
    const module = new WebAssembly.Module(bytes);
    entry.imports = WebAssembly.Module.imports(module); entry.exports = WebAssembly.Module.exports(module);
    assert(entry.imports.every(v => v.module === 'wasi_snapshot_preview1' && v.kind === 'function'));
    assert(entry.exports.some(v => v.name === 'memory' && v.kind === 'memory'));
    result = run(process.execPath, ['--disable-warning=ExperimentalWarning', runner, program, JSON.stringify(fixture.rawCalls || [])], directory, fixture.stdin);
    entry.commands.push(result); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, fixture.stdout);
    entry.program = { path: path.relative(output, program), sha256: digest(bytes), bytes: bytes.length };
    entry.status = 'passed';
  } catch (error) { entry.status = 'failed'; entry.error = error.message; }
  console.log(`${id}: ${entry.status}`);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
report.status = report.cases.every(entry => entry.status === 'passed') ? 'passed' : 'failed';
report.counts = { total: report.cases.length, passed: report.cases.filter(c => c.status === 'passed').length, failed: report.cases.filter(c => c.status === 'failed').length };
await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.counts));
process.exitCode = report.status === 'passed' ? 0 : 1;
