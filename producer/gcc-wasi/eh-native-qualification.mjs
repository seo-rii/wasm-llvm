import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeEhCases } from './eh-native-fixtures.mjs';
import { identity, runLibatomicValidationCommand as run } from './libatomic-qualification.mjs';
import { assertExceptionAssemblyReplay, canonicalExceptionAssembly } from './eh-assembly-replay.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const content = item => ({ bytes: item.bytes, sha256: item.sha256 });
const helperNames = ['eh-native-qualification.mjs', 'eh-assembly-replay.mjs', 'tls-assembly-replay.mjs', 'libatomic-qualification.mjs'];
export const expectedNativeExceptionCounts = Object.freeze({ compilerFixturePrograms: 14, compilerTranslationUnits: 18,
  abiExecutions: 4, driverCompiles: 18, driverDiagnostics: 3, unwindAbiPartialLinks: 4 });

export function verifyNativeExceptionMetadata(compiler, driver) {
  assert.equal(compiler.kind, 'gcc-wasi-native-eh-compiler');
  assert.equal(compiler.gnuRuntimeExecuted, false, 'Backend evidence must not claim GNU execution');
  assert.equal(driver.kind, 'actual-gcc-EH-driver-controls');
  for (const report of [compiler, driver]) {
    assert.equal(report.status, 'passed'); assert.equal(report.inputsUnchanged, true);
    assert(report.cases.every(item => item.passed === true));
    assert.equal(new Set(report.cases.map(item => item.id)).size, report.cases.length);
  }
  const ids = nativeEhCases.map(item => item.id);
  assert.deepEqual(compiler.nativeCaseIds, ids);
  assert.deepEqual(compiler.counts, { nativeFixturePrograms: 14, translationUnits: 18, abiExecutions: 4 });
  assert.deepEqual(driver.counts, { driverCompiles: 18, expectedDiagnostics: 3, unwindAbiPartialLinks: 4 });
  const abiIds = ['c', 'c++'].flatMap(language => ['0', '2'].map(opt => `unwind-abi-${language}-o${opt}`));
  assert.deepEqual(compiler.cases.map(item => item.id), [...ids, ...abiIds]);
  for (const fixture of nativeEhCases) {
    const item = compiler.cases.find(value => value.id === fixture.id);
    assert.equal(item.kind, 'gnu-fixture-compile');
    assert.equal(item.units.length, 1 + (fixture.request.sources?.length ?? 0));
    for (const unit of item.units) {
      assert.equal(unit.compile.exitCode, 0); assert.equal(unit.assemble.exitCode, 0);
      assert.equal(unit.inspect.exitCode, 0); assert.equal(unit.modernEvidence.legacyTry, false);
    }
    if (fixture.expected.exitCode === 0) assert.equal(item.callerCatchRetained, true);
  }
  for (const item of compiler.cases.filter(item => item.kind === 'unwind-abi')) {
    for (const step of ['compile', 'assemble', 'link', 'execute']) assert.equal(item[step].exitCode, 0);
  }
  const profiles = ['default', 'explicit-off', 'enabled', 'last-on', 'last-off', 'pragma-language-only',
    'attribute-language-only', 'pragma-target-attempt'];
  const driverIds = profiles.flatMap(name => ['0', '2'].map(opt => `${name}-o${opt}`));
  driverIds.push('ehspec-catchall-o0', 'ehspec-catchall-o2', 'debug', 'pic', 'non-call', ...['c', 'cpp'].flatMap(language => ['0', '2'].map(opt => `partial-${language}-o${opt}`)));
  assert.deepEqual(driver.cases.map(item => item.id), driverIds);
  for (const item of driver.cases) {
    if (item.kind === 'expected-rejection') assert.notEqual(item.compile.exitCode, 0);
    else if (item.kind === 'actual-unwind-ABI-link') assert.equal(item.link.exitCode, 0);
    else {
      const enabled = /^(?:enabled|last-on|ehspec-catchall)-/u.test(item.id);
      assert.equal(item.expectedEnabled, enabled); assert.equal(item.hasTryTable, enabled);
      assert.equal(item.hasExceptionFeature, enabled); assert.equal(item.compile.exitCode, 0);
      assert.equal(item.inspect.exitCode, 0); assert(item.wat && item.object && item.preprocessed);
    }
  }
}

async function identify(file) { return { path: path.resolve(file), ...identity(await fs.readFile(file)) }; }
async function read(record, requiredPath) {
  assert(record && Number.isSafeInteger(record.bytes) && /^[0-9a-f]{64}$/u.test(record.sha256));
  if (requiredPath) assert.equal(path.resolve(record.path), path.resolve(requiredPath));
  const data = await fs.readFile(record.path);
  assert.deepEqual(identity(data), content(record), `EH evidence changed: ${record.path}`);
  return data;
}
async function artifactMap(directory) {
  const result = [];
  async function walk(current) {
    for (const name of (await fs.readdir(current)).sort()) {
      const file = path.join(current, name), stat = await fs.lstat(file);
      if (stat.isDirectory()) await walk(file);
      else if (stat.isFile()) result.push(await identify(file));
      else assert(stat.isSymbolicLink() && name === 'as', 'Unexpected EH artifact type');
    }
  }
  await walk(directory); return result;
}
async function reopenStored(aggregate, expected) {
  for (const key of ['work', 'sdk', 'gccSource', 'sourceLockSha256', 'nativeBuild']) assert(expected[key], `Missing EH context ${key}`);
  const work = path.resolve(expected.work), sdk = path.resolve(expected.sdk);
  assert.equal(aggregate.schemaVersion, 1); assert.equal(aggregate.kind, 'gcc-wasi-native-exception-qualification');
  assert.equal(aggregate.status, 'passed'); assert.equal(aggregate.gnuRuntimeExecuted, false);
  assert.deepEqual(aggregate.counts, expectedNativeExceptionCounts);
  assert.deepEqual(aggregate.gccSource, expected.gccSource);
  assert.equal(aggregate.sourceLock.sha256, expected.sourceLockSha256);
  assert.deepEqual(content(aggregate.nativeBuild), content(expected.nativeBuild));
  const lock = JSON.parse(await read(aggregate.sourceLock, path.join(here, 'sources.lock.json')));
  const native = JSON.parse(await read(aggregate.nativeBuild, path.join(work, 'native-build.json')));
  assert.deepEqual(native.gccSource, expected.gccSource); assert.equal(native.sourceLockSha256, expected.sourceLockSha256);
  for (const patch of [...lock.gcc.patches, ...lock.wabt.patches]) {
    assert.equal((await identify(path.join(here, patch.path))).sha256, patch.sha256, 'Pinned EH source patch changed');
  }
  const compiler = JSON.parse(await read(aggregate.compiler)), driver = JSON.parse(await read(aggregate.driver));
  verifyNativeExceptionMetadata(compiler, driver);
  assert.deepEqual(compiler.gccSource, expected.gccSource); assert.deepEqual(content(compiler.nativeBuild), content(expected.nativeBuild));
  await read(aggregate.nativeFixtures, path.join(here, 'eh-native-fixtures.mjs'));
  assert.deepEqual(aggregate.nativeFixtures, compiler.nativeFixture);
  assert.deepEqual(aggregate.nativeCaseIds, nativeEhCases.map(item => item.id));
  const frozen = new Map();
  for (const report of [compiler, driver]) for (const record of report.inputs) {
    await read(record); if (frozen.has(record.path)) assert.deepEqual(frozen.get(record.path), content(record));
    frozen.set(record.path, content(record));
  }
  const required = [...['eh-native-check.py', 'eh-native-driver-check.py', 'eh-native-fixtures.mjs', 'sources.lock.json', 'build-native.sh'].map(name => path.join(here, name)),
    ...['native-build.json', 'native-driver.specs', 'gcc-native/gcc/xgcc', 'gcc-native/gcc/cc1', 'gcc-native/gcc/cc1plus',
      'wabt-native/wat2wasm', 'wabt-native/wasm-objdump', 'gcc/libgcc/unwind-generic.h'].map(name => path.join(work, name)),
    path.join(sdk, 'bin/wasm-ld'), path.join(sdk, 'share/wasi-sysroot/lib/wasm32-wasi/eh/libunwind.a')];
  for (const file of required) assert(frozen.has(file), `EH proof omits input ${file}`);
  assert(frozen.has(path.resolve(expected.node || process.execPath)), 'EH ABI execution omits the actual Node binary');
  for (const name of ['xgcc', 'cc1', 'cc1plus']) {
    assert.equal(frozen.get(path.join(work, 'gcc-native/gcc', name)).sha256, native.tools[name].sha256,
      'EH compiler differs from its native build receipt');
  }
  assert.equal(frozen.get(path.join(work, 'native-driver.specs')).sha256, native.driverSpecsSha256);
  assert.equal(frozen.get(path.join(here, 'build-native.sh')).sha256, native.recipeSha256);
  const assemblerBuild = JSON.parse(await read(aggregate.assemblerBuild, path.join(work, 'wabt-native/provenance.json')));
  assert.equal(assemblerBuild.host, 'native'); assert.equal(assemblerBuild.inputsUnchanged, true);
  assert.equal(assemblerBuild.source.wabtCommit, lock.wabt.commit);
  assert.deepEqual(assemblerBuild.source.patches, lock.wabt.patches);
  assert.equal(assemblerBuild.source.sourceDiffSha256, lock.wabt.sourceDiffSha256);
  for (const [name, record] of Object.entries(assemblerBuild.recipes)) {
    await read({ path: path.join(here, name), ...record }); frozen.set(path.join(here, name), record);
  }
  for (const name of ['wat2wasm', 'wasm-objdump']) {
    assert.deepEqual(frozen.get(path.join(work, 'wabt-native', name)), assemblerBuild.files[name]);
  }
  frozen.set(aggregate.assemblerBuild.path, content(aggregate.assemblerBuild));
  assert.deepEqual(aggregate.helpers.map(item => path.basename(item.path)), helperNames);
  for (const record of aggregate.helpers) { await read(record, path.join(here, path.basename(record.path))); frozen.set(record.path, content(record)); }
  for (const [name, report] of [['compiler', compiler], ['driver', driver]]) {
    const directory = path.dirname(aggregate[name].path);
    assert.deepEqual(await artifactMap(directory), aggregate.artifacts[name], 'Retained EH artifact map changed');
    for (const fixture of name === 'compiler' ? nativeEhCases : []) {
      const caseDirectory = path.join(directory, fixture.id);
      assert.equal(await fs.readFile(path.join(caseDirectory, 'main.cpp'), 'utf8'), fixture.request.code);
      for (const file of fixture.request.files ?? []) assert.equal(await fs.readFile(path.join(caseDirectory, file.path), 'utf8'), file.contents);
    }
  }
  return { compiler, driver, frozen, work, sdk };
}

export async function writeNativeExceptionQualification(file, proofs, expected) {
  const compiler = JSON.parse(await fs.readFile(proofs.compiler));
  const aggregate = { schemaVersion: 1, kind: 'gcc-wasi-native-exception-qualification', status: 'passed',
    gnuRuntimeExecuted: false, counts: expectedNativeExceptionCounts, gccSource: expected.gccSource,
    sourceLock: await identify(path.join(here, 'sources.lock.json')), nativeBuild: await identify(path.join(expected.work, 'native-build.json')),
    assemblerBuild: await identify(path.join(expected.work, 'wabt-native/provenance.json')),
    nativeFixtures: await identify(path.join(here, 'eh-native-fixtures.mjs')), nativeCaseIds: compiler.nativeCaseIds,
    compiler: await identify(proofs.compiler), driver: await identify(proofs.driver),
    helpers: await Promise.all(helperNames.map(name => identify(path.join(here, name)))),
    artifacts: { compiler: await artifactMap(path.dirname(proofs.compiler)), driver: await artifactMap(path.dirname(proofs.driver)) } };
  await reopenStored(aggregate, expected);
  await fs.writeFile(file, JSON.stringify(aggregate, null, 2) + '\n', { flag: 'wx' });
  return aggregate;
}

export async function reopenNativeExceptionQualification(file, expected) {
  const aggregate = JSON.parse(await fs.readFile(file));
  const { compiler, driver, frozen, work, sdk } = await reopenStored(aggregate, expected);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gcc-eh-replay-')); await fs.chmod(directory, 0o700);
  const replay = { kind: 'gcc-wasi-native-exception-replay', status: 'running', directory, commands: [], comparisons: [] };
  const save = () => fs.writeFile(path.join(directory, 'reopen.json'), JSON.stringify(replay, null, 2) + '\n');
  try {
    const node = expected.node || process.execPath, python = expected.python || 'python3';
    const freshCompilerRoot = path.join(directory, 'compiler'), freshDriverRoot = path.join(directory, 'driver');
    replay.commands.push(await run(python, [path.join(here, 'eh-native-check.py'), '--work', work, '--sdk', sdk,
      '--node', node, '--output', freshCompilerRoot], directory, 'fresh-compiler', 300000));
    replay.commands.push(await run(python, [path.join(here, 'eh-native-driver-check.py'), '--work', work, '--sdk', sdk,
      '--abi-root', freshCompilerRoot, '--output', freshDriverRoot], directory, 'fresh-driver', 300000));
    const freshCompiler = JSON.parse(await fs.readFile(path.join(freshCompilerRoot, 'report.json')));
    const freshDriver = JSON.parse(await fs.readFile(path.join(freshDriverRoot, 'report.json')));
    verifyNativeExceptionMetadata(freshCompiler, freshDriver);
    assert.deepEqual(freshCompiler.inputs, compiler.inputs);
    assert.deepEqual(freshDriver.inputs.filter(item => !item.path.startsWith(freshCompilerRoot + path.sep)),
      driver.inputs.filter(item => !item.path.startsWith(path.dirname(aggregate.compiler.path) + path.sep)));
    const assembler = path.join(work, 'wabt-native/wat2wasm');
    let counter = 0;
    async function compareUnit(old, next) {
      const label = `unit-${counter++}`, root = path.join(directory, label); await fs.mkdir(root);
      const originalText = await read(old.wat), freshText = await read(next.wat);
      assertExceptionAssemblyReplay(originalText, freshText);
      assert.deepEqual(content(old.source ?? old.preprocessed), content(next.source ?? next.preprocessed));
      const raw = path.join(root, 'original-raw.o');
      replay.commands.push(await run(assembler, ['-r', '--enable-annotations', '--enable-exceptions', old.wat.path, '-o', raw], directory, label + '-raw'));
      assert.deepEqual(identity(await fs.readFile(raw)), content(old.object), 'Original EH WAT no longer reproduces its object');
      const canonical = {};
      for (const [origin, text] of [['original', originalText], ['fresh', freshText]]) {
        const wat = path.join(root, origin + '.wat'), object = path.join(root, origin + '.o');
        await fs.writeFile(wat, canonicalExceptionAssembly(text));
        replay.commands.push(await run(assembler, ['-r', '--enable-annotations', '--enable-exceptions', wat, '-o', object], directory, label + '-' + origin));
        canonical[origin] = { wat: await identify(wat), object: await identify(object) };
      }
      assert.deepEqual(content(canonical.original.object), content(canonical.fresh.object), 'Canonical EH object changed');
      replay.comparisons.push({ originalWat: old.wat, freshWat: next.wat, originalObjectReproduced: await identify(raw), canonical });
    }
    for (const old of compiler.cases) {
      const next = freshCompiler.cases.find(item => item.id === old.id);
      if (old.units) for (const [index, unit] of old.units.entries()) await compareUnit(unit, next.units[index]);
      else {
        await compareUnit(old, next);
        const relinkDirectory = path.join(directory, old.id.replaceAll('+', 'p')); await fs.mkdir(relinkDirectory);
        const relink = path.join(relinkDirectory, path.basename(old.program.path));
        const argv = old.link.argv.slice(1).map((arg, index, all) => all[index - 1] === '-o' ? relink : arg);
        replay.commands.push(await run(old.link.argv[0], argv, directory, old.id.replaceAll('+', 'p') + '-relink'));
        assert.deepEqual(identity(await fs.readFile(relink)), content(old.program));
        assert.deepEqual(content(next.program), content(old.program));
        replay.commands.push(await run(old.execute.argv[0], old.execute.argv.slice(1), directory, old.id.replaceAll('+', 'p') + '-original-execute'));
      }
    }
    for (const old of driver.cases) {
      const next = freshDriver.cases.find(item => item.id === old.id);
      if (old.wat) await compareUnit(old, next);
      else if (old.combined) {
        // LLD puts the output basename in the name custom section, including
        // relocatable links. Isolate its directory while preserving that input.
        const partialDirectory = path.join(directory, old.id); await fs.mkdir(partialDirectory);
        const output = path.join(partialDirectory, path.basename(old.combined.path));
        const argv = old.link.argv.slice(1).map((arg, index, all) => all[index - 1] === '-o' ? output : arg);
        replay.commands.push(await run(old.link.argv[0], argv, directory, old.id + '-relink'));
        assert.deepEqual(identity(await fs.readFile(output)), content(old.combined));
        assert.deepEqual(content(next.combined), content(old.combined));
      }
    }
    for (const [file, record] of frozen) await read({ path: file, ...record });
    replay.status = 'passed'; replay.inputsUnchanged = true; replay.counts = expectedNativeExceptionCounts; await save();
    return { status: 'passed', gccSource: aggregate.gccSource, nativeBuild: aggregate.nativeBuild,
      nativeFixtures: aggregate.nativeFixtures, nativeCaseIds: aggregate.nativeCaseIds,
      counts: aggregate.counts, gnuRuntimeExecuted: false, checks: { retainedArtifacts: true, freshCompiler: true,
        originalObjectsReproduced: true, completeImportOrderOnly: true, unwindAbiExecuted: true, inputsUnchanged: true },
      replay: { report: await identify(path.join(directory, 'reopen.json')), directory } };
  } catch (error) {
    replay.status = 'failed'; replay.error = String(error.stack ?? error); await save(); throw error;
  }
}
