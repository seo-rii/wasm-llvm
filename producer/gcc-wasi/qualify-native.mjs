#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert(['--work', '--sdk', '--sysroot', '--suite', '--cases', '--output'].includes(process.argv[i]), `Unknown argument ${process.argv[i]}`);
  assert(process.argv[i + 1], `Missing value for ${process.argv[i]}`);
  options[process.argv[i].slice(2)] = process.argv[i + 1];
}
const work = path.resolve(options.work || process.env.GCC_WASI_WORK_DIR || 'out/gcc-wasi-work');
const sdk = path.resolve(options.sdk || process.env.WASI_SDK_PATH || '');
const output = path.resolve(options.output || path.join(work, 'native-programs'));
await fs.mkdir(output);
const lock = JSON.parse(await fs.readFile(path.join(here, 'sources.lock.json')));
const build = JSON.parse(await fs.readFile(path.join(work, 'native-build.json')));
assert.equal(build.gccCommit, lock.gcc.commit);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(build.sourceLockSha256, digest(await fs.readFile(path.join(here, 'sources.lock.json'))));
for (const tool of ['cc1', 'cc1plus'])
  assert.equal(digest(await fs.readFile(path.join(work, 'gcc-native/gcc', tool))), build.tools[tool].sha256);
const sysroot = options.sysroot ? path.resolve(options.sysroot) : path.join(sdk, 'share/wasi-sysroot');
const library = path.join(sysroot, 'lib/wasm32-wasi');
const builtins = path.join(sdk, 'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a');
const smoke = {
  id: 'c-hello', request: { language: 'c', code: '#include <stdio.h>\nint main(void) { int n; if (scanf("%d", &n) != 1) return 2; printf("gcc-wasi %d\\n", n + 7); return 0; }\n' },
  stdin: '35\n', stdout: 'gcc-wasi 42\n'
};
let cases = options.suite ? (await import(pathToFileURL(path.resolve(options.suite)))).cases : [smoke];
if (options.cases) {
  const ids = options.cases.split(',');
  for (const id of ids) assert(cases.some(c => c.id === id), `Unknown case ${id}`);
  cases = cases.filter(c => ids.includes(c.id));
}
const report = {
  schemaVersion: 1, kind: 'gcc-wasi-native-qualification', status: 'running',
  compiler: { family: 'gcc', version: lock.gcc.version, commit: lock.gcc.commit },
  host: 'native', target: 'wasm32-wasi', gccCommit: lock.gcc.commit,
  gccSource: build.gccSource,
  sourceLockSha256: digest(await fs.readFile(path.join(here, 'sources.lock.json'))),
  buildReceiptSha256: digest(await fs.readFile(path.join(work, 'native-build.json'))),
  assembler: lock.wabt, nativeLinker: lock.wasiSdk,
  programs: {}, cases: []
};
function run(command, argv, input, cwd) {
  const result = spawnSync(command, argv, { input, cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  return { command, argv, status: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error?.message };
}
const runner = path.join(output, 'run-wasi.mjs');
await fs.writeFile(runner, 'import {WASI} from "node:wasi"; import {readFile} from "node:fs/promises"; const wasi=new WASI({version:"preview1",args:["program"],env:{},returnOnExit:true}); const m=await WebAssembly.compile(await readFile(process.argv[2])); const i=await WebAssembly.instantiate(m,{wasi_snapshot_preview1:wasi.wasiImport}); process.exitCode=wasi.start(i);\n');
for (const fixture of cases) {
  const entry = { id: fixture.id, status: 'running', commands: [] };
  report.cases.push(entry);
  try {
    const directory = path.join(output, fixture.id);
    await fs.mkdir(directory);
    const cpp = fixture.request.language === 'cpp';
    const main = cpp ? 'main.cpp' : 'main.c';
    await fs.writeFile(path.join(directory, main), fixture.request.code);
    for (const file of fixture.request.files || []) {
      const destination = path.resolve(directory, file.path);
      assert(destination.startsWith(directory + path.sep), 'Fixture path escapes its directory');
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.contents);
    }
    const objects = [];
    for (const [index, source] of [main, ...(fixture.request.sources || [])].entries()) {
      const wat = path.join(directory, `unit${index}.wat`);
      const object = path.join(directory, `unit${index}.o`);
      const argv = ['-quiet', `-O${fixture.request.optimization || '0'}`, `-std=${fixture.request.standard || (cpp ? 'gnu++17' : 'gnu11')}`,
        '-fdiagnostics-color=never', '-Werror=attributes', '-Werror=pragmas', '-D__GCC_WASI_SINGLE_THREAD__=1', '-nostdinc',
        '-isystem', path.join(work, 'gcc-native/gcc/include'), '-isystem', path.join(sysroot, 'include/wasm32-wasi'),
        ...(cpp ? ['-fno-exceptions', '-fno-rtti', '-fuse-cxa-atexit', '-fno-threadsafe-statics'] : []),
        ...(fixture.request.defines || []).map(value => `-D${value}`), path.join(directory, source), '-o', wat];
      let result = run(path.join(work, 'gcc-native/gcc', cpp ? 'cc1plus' : 'cc1'), argv, undefined, directory);
      entry.commands.push(result); assert.equal(result.status, 0, result.stderr);
      result = run(path.join(work, 'wabt-native/wat2wasm'), ['-r', '--enable-annotations', wat, '-o', object], undefined, directory);
      entry.commands.push(result); assert.equal(result.status, 0, result.stderr);
      const m = new WebAssembly.Module(await fs.readFile(object));
      assert.equal(WebAssembly.Module.customSections(m, 'linking').length, 1, 'Missing object linking metadata');
      objects.push(object);
    }
    const program = path.join(output, `${fixture.id}.wasm`);
    let result = run(path.join(sdk, 'bin/wasm-ld'), ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', program,
      path.join(library, 'crt1-command.o'), `-L${library}`, ...objects, '-lm', '-lc', builtins], undefined, directory);
    entry.commands.push(result); assert.equal(result.status, 0, result.stderr);
    const bytes = await fs.readFile(program);
    const module = new WebAssembly.Module(bytes);
    entry.imports = WebAssembly.Module.imports(module); entry.exports = WebAssembly.Module.exports(module);
    assert(entry.imports.every(i => i.module === 'wasi_snapshot_preview1' && i.kind === 'function'));
    assert(entry.exports.some(e => e.name === '_start' && e.kind === 'function'));
    assert(entry.exports.some(e => e.name === 'memory' && e.kind === 'memory'));
    result = run(process.execPath, ['--disable-warning=ExperimentalWarning', runner, program], fixture.stdin);
    entry.commands.push(result); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, fixture.stdout);
    entry.status = 'passed';
    const objectBytes = await fs.readFile(objects[0]);
    report.programs[fixture.id] = { path: `${fixture.id}.wasm`, bytes: bytes.length, sha256: digest(bytes),
      object: { path: path.relative(output, objects[0]), bytes: objectBytes.length, sha256: digest(objectBytes) } };
  } catch (error) {
    entry.status = 'failed'; entry.error = error.message;
  }
  await fs.writeFile(path.join(output, 'provenance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${fixture.id}: ${entry.status}`);
}
report.status = report.cases.every(c => c.status === 'passed') ? 'passed' : 'failed';
await fs.writeFile(path.join(output, 'provenance.json'), JSON.stringify(report, null, 2) + '\n');
if (report.status === 'passed') {
  // Preserve the initial native gate while a browser build consumes it.
  try { await fs.writeFile(path.join(work, 'native-qualification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
else process.exitCode = 1;
