#!/usr/bin/env node
// ABI conformance only; the fixture provider is not a threads/atomics runtime.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases } from './atomic-libcall-fixtures.mjs';

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert(['--work', '--sdk', '--sysroot', '--compiler-dir', '--output'].includes(process.argv[i]), `Unknown argument ${process.argv[i]}`);
  assert(process.argv[i + 1], `Missing value for ${process.argv[i]}`);
  options[process.argv[i].slice(2)] = process.argv[i + 1];
}
const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(options.work || 'out/gcc-wasi-work');
const compiler = path.resolve(options['compiler-dir'] || path.join(work, 'gcc-native/gcc'));
assert(options.sdk || process.env.WASI_SDK_PATH, 'Supply --sdk or WASI_SDK_PATH');
const sdk = path.resolve(options.sdk || process.env.WASI_SDK_PATH);
const sysroot = path.resolve(options.sysroot || path.join(work, 'runtime-single-thread/sysroot'));
const output = path.resolve(options.output || path.join(work, 'atomic-libcall-abi'));
await fs.mkdir(output); // Never overwrite earlier failure evidence.
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identify = async name => ({ path: name, sha256: digest(await fs.readFile(name)) });
const tools = {
  cc1: path.join(compiler, 'cc1'), assembler: path.join(work, 'wabt-native/wat2wasm'),
  linker: path.join(sdk, 'bin/wasm-ld'),
};
const library = path.join(sysroot, 'lib/wasm32-wasi');
const builtins = path.join(sdk, 'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a');
const report = {
  schemaVersion: 1, kind: 'gcc-wasi-atomic-libcall-abi', status: 'running',
  scope: 'Single-threaded test-only providers validate external libcall arguments, not atomic semantics or thread safety.',
  host: 'native', target: 'wasm32-wasi',
  harness: await identify(fileURLToPath(import.meta.url)),
  fixtures: await identify(path.join(here, 'atomic-libcall-fixtures.mjs')),
  tools: Object.fromEntries(await Promise.all(Object.entries(tools).map(async ([key, name]) => [key, await identify(name)]))),
  runtime: await Promise.all(['crt1-command.o', 'libc.a', 'libm.a'].map(name => identify(path.join(library, name)))),
  builtins: await identify(builtins), cases: [],
};
const runner = path.join(output, 'run-wasi.mjs');
await fs.writeFile(runner, `import {WASI} from 'node:wasi'; import {readFile} from 'node:fs/promises';
const wasi = new WASI({version:'preview1', args:['program'], env:{}, returnOnExit:true});
const m = await WebAssembly.compile(await readFile(process.argv[2]));
const i = await WebAssembly.instantiate(m, {wasi_snapshot_preview1:wasi.wasiImport});
process.exitCode = wasi.start(i);
`);
function run(command, argv, cwd, input) {
  const value = spawnSync(command, argv, { cwd, input, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  return { command, argv, status: value.status, signal: value.signal, stdout: value.stdout || '', stderr: value.stderr || '', error: value.error?.message };
}
for (const fixture of cases) {
  const entry = { id: fixture.id, status: 'running', commands: [], objects: [] };
  report.cases.push(entry);
  try {
    const directory = path.join(output, fixture.id);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'main.c'), fixture.request.code);
    for (const file of fixture.request.files) await fs.writeFile(path.join(directory, file.path), file.contents);
    const objects = [];
    for (const [index, source] of ['main.c', ...fixture.request.sources].entries()) {
      const wat = path.join(directory, `unit${index}.wat`), object = path.join(directory, `unit${index}.o`);
      let result = run(tools.cc1, ['-quiet', `-O${fixture.request.optimization}`, '-std=gnu11',
        '-fdiagnostics-color=never', '-D__GCC_WASI_SINGLE_THREAD__=1', '-nostdinc',
        '-isystem', path.join(compiler, 'include'), '-isystem', path.join(sysroot, 'include/wasm32-wasi'),
        path.join(directory, source), '-o', wat], directory);
      entry.commands.push(result); assert.equal(result.status, 0, result.stderr);
      result = run(tools.assembler, ['-r', '--enable-annotations', wat, '-o', object], directory);
      entry.commands.push(result); assert.equal(result.status, 0, result.stderr);
      const bytes = await fs.readFile(object), module = new WebAssembly.Module(bytes);
      assert.equal(WebAssembly.Module.customSections(module, 'linking').length, 1);
      entry.objects.push({ path: path.relative(output, object), sha256: digest(bytes), bytes: bytes.length });
      objects.push(object);
    }
    const program = path.join(directory, 'program.wasm');
    let result = run(tools.linker, ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', program,
      path.join(library, 'crt1-command.o'), `-L${library}`, ...objects, '-lm', '-lc', builtins], directory);
    entry.commands.push(result); assert.equal(result.status, 0, result.stderr);
    const bytes = await fs.readFile(program), module = new WebAssembly.Module(bytes);
    entry.imports = WebAssembly.Module.imports(module); entry.exports = WebAssembly.Module.exports(module);
    assert(entry.imports.every(v => v.module === 'wasi_snapshot_preview1' && v.kind === 'function'));
    assert(entry.exports.some(v => v.name === 'memory' && v.kind === 'memory'));
    result = run(process.execPath, ['--disable-warning=ExperimentalWarning', runner, program], directory, fixture.stdin);
    entry.commands.push(result); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, fixture.stdout);
    entry.program = { path: path.relative(output, program), sha256: digest(bytes), bytes: bytes.length };
    entry.status = 'passed';
  } catch (error) { entry.status = 'failed'; entry.error = error.message; }
  console.log(`${entry.id}: ${entry.status}`);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
report.status = report.cases.every(c => c.status === 'passed') ? 'passed' : 'failed';
report.counts = { total: report.cases.length, passed: report.cases.filter(c => c.status === 'passed').length };
await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.counts));
process.exitCode = report.status === 'passed' ? 0 : 1;
