import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases } from './libatomic-fixtures.mjs';
import { sharedCases, assertSharedLibatomicResult } from './libatomic-shared-fixtures.mjs';
import { identity, libatomicCompileArgs, libatomicLinkArgs, libatomicWasiRunner, inspectLibatomicProgram,
  assertLibatomicAssemblyReplay, runLibatomicValidationCommand as run } from './libatomic-qualification.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const content = record => ({ bytes: record.bytes, sha256: record.sha256 });
const sourceHash = value => identity(Buffer.from(value));
const recipes = ['test-libatomic.mjs', 'libatomic-fixtures.mjs', 'libatomic-shared-fixtures.mjs',
  'run-libatomic-shared.mjs', 'atomics-native-fixtures.mjs', 'libatomic-qualification.mjs', 'build-libatomic.py', 'prepare-source.py'];

export function verifyLibatomicExecutionMetadata(report, reportFile, expected) {
  assert.equal(report.schemaVersion, 1); assert.equal(report.kind, 'gcc-wasi-native-libatomic-qualification');
  assert.equal(report.status, 'passed'); assert.equal(report.inputsUnchanged, true);
  assert.equal(report.host, 'native'); assert.equal(report.target, 'wasm32-wasi');
  assert.deepEqual(report.gccSource, expected.gccSource);
  assert.equal(report.sourceLock.sha256, expected.sourceLockSha256);
  assert.deepEqual(content(report.nativeBuild), content(expected.nativeBuild));
  assert.deepEqual(content(report.archive), content(expected.archive));
  assert.deepEqual(report.counts, { serial: 28, shared: 16, workers: 32 });
  const output = path.dirname(path.resolve(reportFile));
  assert.equal(report.context.output, output);
  for (const key of ['work', 'sdk', 'sysroot', 'libatomic']) assert.equal(report.context[key], path.resolve(expected[key]));
  const toolPaths = { gcc: path.join(expected.work, 'gcc-native/gcc/cc1'), gccCpp: path.join(expected.work, 'gcc-native/gcc/cc1plus'),
    assembler: path.join(expected.work, 'wabt-native/wat2wasm'), objdump: path.join(expected.work, 'wabt-native/wasm-objdump'),
    validator: path.join(expected.work, 'wabt-native/wasm-validate'), linker: path.join(expected.sdk, 'bin/wasm-ld'), node: report.toolPaths.node };
  assert.deepEqual(report.toolPaths, toolPaths);
  assert.deepEqual(report.cases.map(item => item.id), cases.map(item => item.id));
  assert.deepEqual(report.sharedCases.map(item => item.id), sharedCases.map(item => item.id));
  assert.deepEqual(content(report.wasiRunner), sourceHash(libatomicWasiRunner));
  for (const [fixture, entry] of [...cases.map((fixture, i) => [fixture, report.cases[i]]),
    ...sharedCases.map((fixture, i) => [fixture, report.sharedCases[i]])]) {
    assert.equal(entry.status, 'passed'); assert.deepEqual(entry.fixture, sourceHash(JSON.stringify(fixture)));
    assert.deepEqual(content(entry.source), sourceHash(fixture.request.code));
    const directory = path.join(output, fixture.id), source = path.join(directory, fixture.request.language === 'cpp' ? 'main.cc' : 'main.c');
    const assembly = path.join(directory, 'main.wat'), object = path.join(directory, 'main.o'), program = path.join(directory, 'main.wasm');
    for (const [name, file] of Object.entries({ source, assembly, object, program })) assert.equal(entry[name].path, file);
    const expectedCommands = [
      [fixture.request.language === 'cpp' ? toolPaths.gccCpp : toolPaths.gcc, libatomicCompileArgs(fixture, source, assembly, report.context)],
      [toolPaths.assembler, ['-r', '--enable-annotations', '--enable-threads', assembly, '-o', object]],
      [toolPaths.objdump, ['-x', '-d', object]],
      [toolPaths.linker, libatomicLinkArgs(fixture, object, program, report.context)],
      [toolPaths.validator, ['--enable-threads', program]],
      [toolPaths.objdump, ['-x', '-d', program]],
      fixture.request.sharedMemory
        ? [toolPaths.node, [path.join(here, 'run-libatomic-shared.mjs'), '--program', program, '--fixture', fixture.id, '--output', path.join(directory, 'execution')]]
        : [toolPaths.node, ['--no-warnings', report.wasiRunner.path, program]],
    ];
    assert.equal(entry.commands.length, expectedCommands.length);
    for (const [index, [command, argv]] of expectedCommands.entries()) {
      const actual = entry.commands[index]; assert.equal(actual.command, command); assert.deepEqual(actual.argv, argv);
      assert.equal(actual.cwd, directory); assert.equal(actual.status, 0); assert.equal(actual.signal, null); assert(!actual.error);
      assert.equal(actual.stdin, index === 6 && !fixture.request.sharedMemory ? fixture.stdin : null);
      assert.equal(actual.stderr, '', 'Compiler, linker or runtime diagnostic in qualified case');
    }
    for (const name of fixture.requiredSymbols) assert(entry.helperImports.some(item => item.module === 'env' && item.kind === 'function' && item.name === name));
    if (!fixture.request.sharedMemory) {
      assert.equal(entry.stdin, fixture.stdin); assert.equal(entry.stdout, fixture.stdout); assert.equal(entry.commands[6].stdout, fixture.stdout);
    }
  }
}

export async function reopenLibatomicExecutionQualification(report, reportFile, expected) {
  verifyLibatomicExecutionMetadata(report, reportFile, expected);
  const frozen = new Map();
  const verify = async (record, file) => {
    if (file) assert.equal(path.resolve(record.path), path.resolve(file));
    const bytes = await fs.readFile(record.path); assert.deepEqual(identity(bytes), content(record), `Changed libatomic execution input: ${record.path}`);
    frozen.set(record.path, identity(bytes)); return bytes;
  };
  for (const input of report.inputs) await verify(input);
  await verify({ path: reportFile, ...identity(await fs.readFile(reportFile)) });
  for (const name of recipes) await verify(report.recipes[name], path.join(here, name));
  for (const [name, file] of Object.entries(report.toolPaths)) await verify(report.tools[name], file);
  await verify(report.nativeBuild, path.join(expected.work, 'native-build.json'));
  await verify(report.sourceLock, path.join(here, 'sources.lock.json'));
  await verify(report.libatomicBuild, path.join(expected.libatomic, 'build.json'));
  await verify(report.archive, path.join(expected.libatomic, 'sysroot/lib/wasm32-wasi/libatomic.a'));
  await verify(report.wasiRunner, path.join(path.dirname(reportFile), 'run-wasi.mjs'));
  const native = JSON.parse(await fs.readFile(report.nativeBuild.path, 'utf8'));
  assert.deepEqual(native.gccSource, expected.gccSource); assert.equal(native.sourceLockSha256, expected.sourceLockSha256);
  assert.equal(report.tools.gcc.sha256, native.tools.cc1.sha256); assert.equal(report.tools.gccCpp.sha256, native.tools.cc1plus.sha256);
  const replay = await fs.mkdtemp(path.join(os.tmpdir(), 'gcc-libatomic-execution-replay-')); await fs.chmod(replay, 0o700);
  const evidence = { schemaVersion: 1, kind: 'gcc-wasi-native-libatomic-qualification-reopen', status: 'running',
    original: { path: reportFile, ...identity(await fs.readFile(reportFile)) }, cases: [], replayDirectory: replay };
  const save = () => fs.writeFile(path.join(replay, 'reopen.json'), JSON.stringify(evidence, null, 2) + '\n');
  try {
    const sourceCheck = await run('python3', [path.join(here, 'prepare-source.py'), '--source', path.join(expected.work, 'gcc')], replay, 'source-before', 600000);
    assert.deepEqual(JSON.parse(await fs.readFile(sourceCheck.stdout.path, 'utf8')), expected.gccSource); evidence.sourceCheck = sourceCheck;
    for (const [fixture, entry] of [...cases.map((fixture, i) => [fixture, report.cases[i]]),
      ...sharedCases.map((fixture, i) => [fixture, report.sharedCases[i]])]) {
      const directory = path.join(replay, fixture.id); await fs.mkdir(directory);
      for (const key of ['source', 'assembly', 'object', 'program', 'objectDisassembly', 'programDisassembly']) await verify(entry[key]);
      const module = new WebAssembly.Module(await fs.readFile(entry.object.path));
      const imports = WebAssembly.Module.imports(module);
      assert.deepEqual(imports.filter(item => item.kind === 'function'), entry.helperImports);
      for (const name of fixture.requiredSymbols) assert(imports.some(item => item.module === 'env' && item.kind === 'function' && item.name === name));
      if (fixture.request.sharedMemory) {
        const previous = JSON.parse(await verify(entry.execution)); const previousMemory = await verify(entry.memory);
        assert.equal(previous.status, 'passed'); assert.equal(previous.terminatedWorkers, 2);
        assert(previous.overlapMilliseconds > 0); assert.equal(previous.guardsUnchanged, true); assert.equal(previous.fixedMemory, true);
        assert.deepEqual(assertSharedLibatomicResult(fixture, { values: previous.values, memory: previousMemory }), entry.observation);
      }
      const current = { id: fixture.id, commands: [] }; evidence.cases.push(current);
      const invoke = async (command, argv, label, input) => {
        const receipt = await run(command, argv, directory, label, 180000, input); current.commands.push(receipt);
        assert.equal((await fs.readFile(receipt.stderr.path)).length, 0, `Diagnostic during ${fixture.id}: ${label}`); return receipt;
      };
      const original = path.join(directory, 'original'); await fs.mkdir(original);
      const originalObject = path.join(original, 'main.o'), originalProgram = path.join(original, 'main.wasm');
      await invoke(report.toolPaths.assembler, ['-r', '--enable-annotations', '--enable-threads', entry.assembly.path, '-o', originalObject], 'assemble-original');
      assert.deepEqual(identity(await fs.readFile(originalObject)), content(entry.object));
      await invoke(report.toolPaths.linker, libatomicLinkArgs(fixture, originalObject, originalProgram, report.context), 'link-original');
      assert.deepEqual(identity(await fs.readFile(originalProgram)), content(entry.program));
      const assembly = path.join(directory, 'main.wat'), object = path.join(directory, 'main.o'), program = path.join(directory, 'main.wasm');
      await invoke(fixture.request.language === 'cpp' ? report.toolPaths.gccCpp : report.toolPaths.gcc,
        libatomicCompileArgs(fixture, entry.source.path, assembly, report.context), 'compile-fresh');
      const oldAssembly = await fs.readFile(entry.assembly.path), freshAssembly = await fs.readFile(assembly);
      assertLibatomicAssemblyReplay(oldAssembly, freshAssembly); current.assemblyRawEqual = oldAssembly.equals(freshAssembly);
      await invoke(report.toolPaths.assembler, ['-r', '--enable-annotations', '--enable-threads', assembly, '-o', object], 'assemble-fresh');
      await invoke(report.toolPaths.linker, libatomicLinkArgs(fixture, object, program, report.context), 'link-fresh');
      const freshProgram = await fs.readFile(program); assert.deepEqual(identity(freshProgram), content(entry.program));
      await invoke(report.toolPaths.validator, ['--enable-threads', program], 'validate-fresh');
      const inspection = await invoke(report.toolPaths.objdump, ['-x', '-d', program], 'inspect-fresh');
      current.inspection = inspectLibatomicProgram(fixture, await fs.readFile(inspection.stdout.path, 'utf8'), freshProgram);
      if (fixture.request.sharedMemory) {
        const executionDirectory = path.join(directory, 'execution');
        await invoke(report.toolPaths.node, [path.join(here, 'run-libatomic-shared.mjs'), '--program', program,
          '--fixture', fixture.id, '--output', executionDirectory], 'execute-shared');
        const execution = JSON.parse(await fs.readFile(path.join(executionDirectory, 'execution.json'), 'utf8'));
        assert.equal(execution.status, 'passed'); assert.equal(execution.terminatedWorkers, 2);
        current.observation = assertSharedLibatomicResult(fixture, { values: execution.values, memory: await fs.readFile(path.join(executionDirectory, 'memory.bin')) });
      } else {
        const execution = await invoke(report.toolPaths.node, ['--no-warnings', report.wasiRunner.path, program], 'execute-serial', fixture.stdin);
        assert.equal(await fs.readFile(execution.stdout.path, 'utf8'), fixture.stdout);
      }
      current.status = 'passed'; await save();
    }
    const sourceAfter = await run('python3', [path.join(here, 'prepare-source.py'), '--source', path.join(expected.work, 'gcc')], replay, 'source-after', 600000);
    assert.deepEqual(JSON.parse(await fs.readFile(sourceAfter.stdout.path, 'utf8')), expected.gccSource); evidence.sourceCheckAfter = sourceAfter;
    for (const [file, expectedIdentity] of frozen) assert.deepEqual(identity(await fs.readFile(file)), expectedIdentity, `Changed during libatomic execution replay: ${file}`);
    evidence.status = 'passed'; evidence.inputsUnchanged = true; evidence.counts = { serial: 28, shared: 16, workers: 32 }; await save();
    return { qualification: evidence.original, replay: { path: path.join(replay, 'reopen.json'), ...identity(await fs.readFile(path.join(replay, 'reopen.json'))) },
      archive: report.archive, gccSource: report.gccSource, counts: evidence.counts, status: 'passed' };
  } catch (error) {
    evidence.status = 'failed'; evidence.error = String(error?.stack || error); await save();
    error.message += `; execution replay preserved at ${replay}`; throw error;
  }
}
