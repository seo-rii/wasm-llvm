#!/usr/bin/env node
// Native standard-header integration. Shared artifacts execute in the SDK gate.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identity, readNativeTree } from '../clang-browser/cross/package.mjs';
import { standardAtomicCases } from './atomics-standard-fixtures.mjs';
import { libatomicCompileArgs, libatomicLinkArgs, inspectLibatomicProgram, libatomicWasiRunner } from './libatomic-qualification.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), context = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i].replace(/^--/, '');
  assert(['work', 'sdk', 'sysroot', 'libatomic', 'libstdcxx', 'output'].includes(name) && process.argv[i + 1] && !context[name]);
  context[name] = path.resolve(process.argv[i + 1]);
}
for (const key of ['work', 'sdk', 'sysroot', 'libatomic', 'libstdcxx', 'output']) assert(context[key], `Required --${key}`);
await fs.mkdir(context.output);
const inputs = new Map();
async function input(file) { const bytes = await fs.readFile(file); inputs.set(file, identity(bytes)); return bytes; }
const gcc = path.join(context.work, 'gcc-native/gcc'), wabt = path.join(context.work, 'wabt-native');
const tools = { gcc: path.join(gcc, 'cc1'), gccCpp: path.join(gcc, 'cc1plus'), assembler: path.join(wabt, 'wat2wasm'),
  inspector: path.join(wabt, 'wasm-objdump'), validator: path.join(wabt, 'wasm-validate'), linker: path.join(context.sdk, 'bin/wasm-ld'), node: process.execPath };
const native = JSON.parse(await input(path.join(context.work, 'native-build.json')));
const library = JSON.parse(await input(path.join(context.libatomic, 'build.json')));
const gnu = JSON.parse(await input(path.join(context.libstdcxx, 'build.json')));
const lockBytes = await input(path.join(here, 'sources.lock.json'));
assert.equal(native.sourceLockSha256, identity(lockBytes).sha256);
assert.deepEqual(library.gccSource, native.gccSource); assert.deepEqual(gnu.gccSource, native.gccSource);
for (const [name, file] of Object.entries(tools)) {
  const bytes = await input(file);
  if (name === 'gcc' || name === 'gccCpp') assert.equal(identity(bytes).sha256, native.tools[name === 'gcc' ? 'cc1' : 'cc1plus'].sha256);
}
const include = path.join(context.libstdcxx, 'sysroot/include/c++/17.0.0');
const targets = (await fs.readdir(include)).filter(name => name.startsWith('wasm32-'));
assert.equal(targets.length, 1);
const headerRoots = [include, path.join(gcc, 'include'), path.join(context.sysroot, 'include')];
const headers = {};
for (const root of headerRoots) headers[root] = Object.fromEntries((await readNativeTree(root)).map(file => [file.path, identity(file.bytes)]));
for (const file of [fileURLToPath(import.meta.url), path.join(here, 'atomics-standard-fixtures.mjs'), path.join(here, 'libatomic-qualification.mjs'), library.library.path,
  ...['crt1-command.o', 'libc.a', 'libm.a', 'libclang_rt.builtins-wasm32.a'].map(name => path.join(context.sysroot, 'lib/wasm32-wasi', name))]) await input(file);
assert.deepEqual(inputs.get(library.library.path), { bytes: library.library.bytes, sha256: library.library.sha256 });
const runner = path.join(context.output, 'run-wasi.mjs'); await fs.writeFile(runner, libatomicWasiRunner);
const report = { kind: 'gcc-wasi-standard-atomic-headers', status: 'running', sourceLock: identity(lockBytes), gccSource: native.gccSource,
  context, tools, headers, cases: [], scope: 'Four native WASI executions and four shared artifact compilations; shared execution requires the separate SDK browser gate.' };
function command(entry, tool, argv, stdin) {
  const result = spawnSync(tool, argv, { encoding: 'utf8', input: stdin, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  const evidence = { tool, argv, status: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '', stdin: stdin ?? null };
  entry.commands.push(evidence); assert.ifError(result.error); assert.equal(result.signal, null);
  assert.equal(result.status, 0, `${entry.id}: ${evidence.stderr}`); return evidence;
}
try {
  for (const fixture of standardAtomicCases) {
    const directory = path.join(context.output, fixture.id); await fs.mkdir(directory);
    const source = path.join(directory, fixture.request.language === 'cpp' ? 'main.cc' : 'main.c');
    const assembly = path.join(directory, 'main.wat'), object = path.join(directory, 'main.o'), program = path.join(directory, 'main.wasm');
    const entry = { id: fixture.id, status: 'running', commands: [], source: identity(Buffer.from(fixture.request.code)) }; report.cases.push(entry);
    await fs.writeFile(source, fixture.request.code);
    const args = libatomicCompileArgs(fixture, source, assembly, context);
    if (fixture.request.language === 'cpp') args.unshift('-isystem', include, '-isystem', path.join(include, targets[0]));
    command(entry, fixture.request.language === 'cpp' ? tools.gccCpp : tools.gcc, args);
    command(entry, tools.assembler, ['-r', '--enable-annotations', '--enable-threads', assembly, '-o', object]);
    command(entry, tools.linker, libatomicLinkArgs(fixture, object, program, context));
    command(entry, tools.validator, ['--enable-threads', program]);
    const disassembly = command(entry, tools.inspector, ['-x', '-d', program]).stdout;
    await fs.writeFile(path.join(directory, 'disassembly.txt'), disassembly);
    const bytes = await fs.readFile(program);
    entry.program = { path: program, ...identity(bytes) }; entry.inspection = inspectLibatomicProgram(fixture, disassembly, bytes);
    if (!fixture.request.sharedMemory) {
      const run = command(entry, tools.node, ['--no-warnings', runner, program], fixture.stdin);
      assert.equal(run.stdout, fixture.stdout); assert.equal(run.stderr, ''); entry.executed = true;
    } else entry.executed = false;
    entry.status = 'passed';
  }
  for (const [file, expected] of inputs) assert.deepEqual(identity(await fs.readFile(file)), expected, `Input changed: ${file}`);
  for (const root of headerRoots) assert.deepEqual(Object.fromEntries((await readNativeTree(root)).map(file => [file.path, identity(file.bytes)])), headers[root]);
  report.inputsUnchanged = true; report.counts = { compiled: 8, executed: 4, sharedAwaitingBrowserExecution: 4 }; report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
report.inputs = Object.fromEntries(inputs);
await fs.writeFile(path.join(context.output, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, counts: report.counts, error: report.error, output: context.output }));
