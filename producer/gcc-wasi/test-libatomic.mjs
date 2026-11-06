#!/usr/bin/env node
// Real GCC -> WABT -> LLD -> Node executions against the production GNU archive.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases } from './libatomic-fixtures.mjs';
import { sharedCases, assertSharedLibatomicResult } from './libatomic-shared-fixtures.mjs';
import { identity, verifyLibatomicBuildMetadata, libatomicCompileArgs, libatomicLinkArgs,
  inspectLibatomicProgram, libatomicWasiRunner } from './libatomic-qualification.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), context = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert(['--work', '--sdk', '--sysroot', '--libatomic', '--output'].includes(process.argv[i]));
  assert(process.argv[i + 1]); context[process.argv[i].slice(2)] = path.resolve(process.argv[i + 1]);
}
for (const name of ['work', 'sdk', 'sysroot', 'libatomic', 'output']) assert(context[name], `Supply --${name}`);
await fs.mkdir(context.output);
const frozen = new Map(), identify = async file => ({ path: file, ...identity(await fs.readFile(file)) });
const freeze = async file => {
  const record = await identify(file); const before = frozen.get(file);
  if (before) assert.deepEqual(record, before, `Input changed: ${file}`); frozen.set(file, record); return record;
};
const tools = { gcc: path.join(context.work, 'gcc-native/gcc/cc1'), gccCpp: path.join(context.work, 'gcc-native/gcc/cc1plus'),
  assembler: path.join(context.work, 'wabt-native/wat2wasm'), objdump: path.join(context.work, 'wabt-native/wasm-objdump'),
  validator: path.join(context.work, 'wabt-native/wasm-validate'), linker: path.join(context.sdk, 'bin/wasm-ld'), node: process.execPath };
const report = { schemaVersion: 1, kind: 'gcc-wasi-native-libatomic-qualification', status: 'running',
  host: 'native', target: 'wasm32-wasi', context, toolPaths: tools, cases: [], sharedCases: [], inputs: [] };
const save = () => fs.writeFile(path.join(context.output, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
function run(command, argv, cwd, input, timeout = 120000) {
  const result = spawnSync(command, argv, { cwd, input, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  return { command, argv, cwd, stdin: input ?? null, timeoutMilliseconds: timeout, status: result.status, signal: result.signal,
    stdout: result.stdout || '', stderr: result.stderr || '', ...(result.error ? { error: result.error.message } : {}) };
}
function passed(result) { assert.equal(result.status, 0, result.stderr || result.stdout || result.error); assert.equal(result.signal, null); assert(!result.error); }

try {
  report.recipes = Object.fromEntries(await Promise.all(['test-libatomic.mjs', 'libatomic-fixtures.mjs', 'libatomic-shared-fixtures.mjs',
    'run-libatomic-shared.mjs', 'atomics-native-fixtures.mjs', 'libatomic-qualification.mjs', 'build-libatomic.py', 'prepare-source.py'].map(async name => [name, await freeze(path.join(here, name))])));
  report.tools = Object.fromEntries(await Promise.all(Object.entries(tools).map(async ([name, file]) => [name, await freeze(file)])));
  report.sourceLock = await freeze(path.join(here, 'sources.lock.json'));
  report.nativeBuild = await freeze(path.join(context.work, 'native-build.json'));
  report.libatomicBuild = await freeze(path.join(context.libatomic, 'build.json'));
  const build = JSON.parse(await fs.readFile(report.libatomicBuild.path, 'utf8'));
  report.gccSource = JSON.parse(await fs.readFile(report.nativeBuild.path, 'utf8')).gccSource;
  verifyLibatomicBuildMetadata(build, { gccSource: report.gccSource, sourceLockSha256: report.sourceLock.sha256, nativeBuild: report.nativeBuild });
  for (const input of build.inputs) {
    const actual = await freeze(input.path); assert.deepEqual(identity(await fs.readFile(actual.path)), { bytes: input.bytes, sha256: input.sha256 });
  }
  report.archive = await freeze(path.join(context.libatomic, 'sysroot/lib/wasm32-wasi/libatomic.a'));
  assert.deepEqual(identity(await fs.readFile(report.archive.path)), { bytes: build.library.bytes, sha256: build.library.sha256 });
  report.sourceCheck = run('python3', [path.join(here, 'prepare-source.py'), '--source', path.join(context.work, 'gcc')], context.output, undefined, 600000);
  passed(report.sourceCheck); assert.deepEqual(JSON.parse(report.sourceCheck.stdout), report.gccSource);
  const wasiRunner = path.join(context.output, 'run-wasi.mjs'); await fs.writeFile(wasiRunner, libatomicWasiRunner);
  report.wasiRunner = await freeze(wasiRunner);
  for (const fixture of [...cases, ...sharedCases]) {
    const directory = path.join(context.output, fixture.id); await fs.mkdir(directory);
    const source = path.join(directory, fixture.request.language === 'cpp' ? 'main.cc' : 'main.c');
    const assembly = path.join(directory, 'main.wat'), object = path.join(directory, 'main.o'), program = path.join(directory, 'main.wasm');
    const entry = { id: fixture.id, fixture: identity(Buffer.from(JSON.stringify(fixture))), status: 'running', commands: [] };
    (fixture.request.sharedMemory ? report.sharedCases : report.cases).push(entry);
    try {
      await fs.writeFile(source, fixture.request.code); entry.source = await identify(source);
      const invoke = (tool, argv, input) => { const result = run(tool, argv, directory, input); entry.commands.push(result); passed(result); return result; };
      invoke(fixture.request.language === 'cpp' ? tools.gccCpp : tools.gcc, libatomicCompileArgs(fixture, source, assembly, context));
      entry.assembly = await identify(assembly);
      invoke(tools.assembler, ['-r', '--enable-annotations', '--enable-threads', assembly, '-o', object]); entry.object = await identify(object);
      const objectDetails = invoke(tools.objdump, ['-x', '-d', object]);
      const imports = WebAssembly.Module.imports(new WebAssembly.Module(await fs.readFile(object)));
      for (const name of fixture.requiredSymbols) assert(imports.some(item => item.kind === 'function' && item.module === 'env' && item.name === name), `Missing actual helper call ${name}`);
      entry.helperImports = imports.filter(item => item.kind === 'function');
      const objectFile = path.join(directory, 'object.disassembly.txt'); await fs.writeFile(objectFile, objectDetails.stdout); entry.objectDisassembly = await identify(objectFile);
      objectDetails.stdoutFile = entry.objectDisassembly; delete objectDetails.stdout;
      invoke(tools.linker, libatomicLinkArgs(fixture, object, program, context)); entry.program = await identify(program);
      invoke(tools.validator, ['--enable-threads', program]);
      const programDetails = invoke(tools.objdump, ['-x', '-d', program]);
      const programFile = path.join(directory, 'program.disassembly.txt'); await fs.writeFile(programFile, programDetails.stdout); entry.programDisassembly = await identify(programFile);
      entry.inspection = inspectLibatomicProgram(fixture, programDetails.stdout, await fs.readFile(program));
      programDetails.stdoutFile = entry.programDisassembly; delete programDetails.stdout;
      if (fixture.request.sharedMemory) {
        const executionDirectory = path.join(directory, 'execution');
        const execution = invoke(tools.node, [path.join(here, 'run-libatomic-shared.mjs'), '--program', program, '--fixture', fixture.id, '--output', executionDirectory]);
        assert.equal(execution.stderr, '');
        entry.execution = await identify(path.join(executionDirectory, 'execution.json'));
        entry.memory = await identify(path.join(executionDirectory, 'memory.bin'));
        const result = JSON.parse(await fs.readFile(entry.execution.path, 'utf8'));
        assert.equal(result.status, 'passed'); assert.equal(result.terminatedWorkers, 2);
        entry.observation = assertSharedLibatomicResult(fixture, { values: result.values, memory: await fs.readFile(entry.memory.path) });
      } else {
        const execution = invoke(tools.node, ['--no-warnings', wasiRunner, program], fixture.stdin);
        assert.equal(execution.stderr, ''); assert.equal(execution.stdout, fixture.stdout);
        entry.stdin = fixture.stdin; entry.stdout = execution.stdout;
      }
      entry.status = 'passed';
    } catch (error) { entry.status = 'failed'; entry.error = String(error?.stack || error); }
    console.log(`${fixture.id}: ${entry.status}`); await save();
    if (entry.status !== 'passed') throw new Error(entry.error);
  }
  report.sourceCheckAfter = run('python3', [path.join(here, 'prepare-source.py'), '--source', path.join(context.work, 'gcc')], context.output, undefined, 600000);
  passed(report.sourceCheckAfter); assert.deepEqual(JSON.parse(report.sourceCheckAfter.stdout), report.gccSource);
  for (const [file, record] of frozen) assert.deepEqual(await identify(file), record, `Qualification input changed: ${file}`);
  report.inputs = [...frozen.values()]; report.inputsUnchanged = true;
  report.counts = { serial: report.cases.length, shared: report.sharedCases.length, workers: report.sharedCases.length * 2 };
  assert.deepEqual(report.counts, { serial: 28, shared: 16, workers: 32 }); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error?.stack || error); process.exitCode = 1; }
await save(); console.log(JSON.stringify({ status: report.status, counts: report.counts, error: report.error }));
