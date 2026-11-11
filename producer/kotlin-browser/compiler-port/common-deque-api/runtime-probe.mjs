import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { observeMainEntriesInChromium } from '../official-main-entry/runtime-browser.mjs';
import { TARGETS, transformCommonDequeApi } from './transform.mjs';
import { fixtures, verifyResult } from './runtime-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const execute = promisify(execFile), VARIANTS = ['original', 'common'];
// anySupertype is inline and exposes the deque getter in caller bytecode. Both
// overlays recompile these complete, unchanged callers against their own ABI.
const CALLERS = [
  'compiler/fir/providers/src/org/jetbrains/kotlin/fir/types/FirCorrespondingSupertypesCache.kt',
  'compiler/resolution.common/src/org/jetbrains/kotlin/resolve/calls/NewCommonSuperTypeCalculator.kt',
  'core/compiler.common/src/org/jetbrains/kotlin/types/model/TypeSystemContext.kt',
  'core/descriptors/src/org/jetbrains/kotlin/types/checker/NewKotlinTypeChecker.kt',
];
const OVERLAY_CLASSES = [
  'org.jetbrains.kotlin.ir.backend.js.dce.UsefulDeclarationProcessor',
  'org.jetbrains.kotlin.ir.inline.FunctionInlining',
  'org.jetbrains.kotlin.backend.common.linkage.partial.PartiallyLinkedIrTreePatcher',
  'org.jetbrains.kotlin.resolve.calls.inference.components.ConstraintIncorporator',
  'org.jetbrains.kotlin.types.TypeCheckerState', 'org.jetbrains.kotlin.types.AbstractTypeChecker',
  'org.jetbrains.kotlin.types.AbstractNullabilityChecker', 'org.jetbrains.kotlin.types.checker.UtilsKt',
  'org.jetbrains.kotlin.fir.types.FirCorrespondingSupertypesCache',
  'org.jetbrains.kotlin.resolve.calls.NewCommonSuperTypeCalculator',
  'org.jetbrains.kotlin.types.model.TypeSystemContext',
  'org.jetbrains.kotlin.types.model.TypeSystemCommonSuperTypesContext',
  'org.jetbrains.kotlin.types.checker.NewKotlinTypeCheckerKt',
];
const BOOTSTRAP_CLASSES = ['org.jetbrains.kotlin.backend.wasm.WasmBackendContext', 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler'];
const OWN = ['runtime-probe.mjs', 'runtime-fixtures.mjs', 'RuntimeCompilerLauncher.kt', 'transform.mjs'];
const HELPERS = ['../official-main-entry/runtime-browser.mjs', '../closure.lock.json', '../build-flags.json',
  '../../build/bootstrap.mjs', '../../build/bootstrap.lock.json', '../../manifest.json', '../../sources.lock.json', '../../scripts/source.mjs'];
const STDLIB = { bytes: 4111645, sha256: '3c97b68581963cf32c18d8b6d93b467f3accc9eae2689c1655e8ed4b31f52d28' };
const STDLIB_RECEIPT = 'fe7d12a5f7328a72ac397356b1b8f6d72f826f6b3c8e6a3ccdebe1e3a142c655';
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const samePin = (a, b) => assert.deepEqual({ bytes: a.bytes, sha256: a.sha256 }, { bytes: b.bytes, sha256: b.sha256 });
const ownedOutput = root => root === path.resolve(root) && (root.startsWith(path.join(REPO, 'out/common-deque-runtime/')) ||
  /^\/dev\/shm\/kotlin-common-deque-runtime-[a-f0-9]{12}\/v[0-9]+$/.test(root));

async function fileIdentity(filename) {
  await assertNoSymlink(filename);
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat(); assert(stat.isFile()); const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) { hash.update(chunk); bytes += chunk.length; }
    assert.equal(bytes, stat.size); return { bytes, sha256: hash.digest('hex') };
  } finally { await file.close(); }
}
async function regularFiles(root) {
  await assertNoSymlink(root); const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name); assert(!entry.isSymbolicLink());
    if (entry.isDirectory()) result.push(...await regularFiles(filename));
    else { assert(entry.isFile()); result.push(filename); }
  }
  return result.sort();
}
function expectedCases(outputRoot) {
  const cases = fixtures.filter(fixture => !fixture.compileError).flatMap(fixture => VARIANTS.map(variant => ({
    id: fixture.id + '/' + variant, fixtureId: fixture.id, variant, stdin: [...Buffer.from(fixture.stdin ?? '')],
    filename: path.join(outputRoot, 'fixtures', fixture.id, variant, 'binary', fixture.id + '.wasm'),
  })));
  for (const variant of VARIANTS) {
    const prior = cases.find(row => row.fixtureId === 'stdin-recovery' && row.variant === variant);
    cases.push({ ...prior, id: prior.id + '/fresh-repeat' });
  }
  return cases;
}
function compilerCommand(bootstrap, outputRoot, variant, java, temporaryRoot) {
  const overlay = path.join(outputRoot, variant + '.jar');
  return [java, '-Xmx768m', '-Djava.io.tmpdir=' + temporaryRoot, '-cp', overlay + path.delimiter + bootstrap.classPath,
    'org.jetbrains.kotlin.portable.deque.runtime.RuntimeCompilerLauncherKt', overlay,
    bootstrap.artifacts.find(row => row.id === 'compiler').path];
}
function compilerFlags(stdlibFile) {
  return ['-Xwasm-target=wasm-wasi', '-libraries', stdlibFile, '-main', 'call', '-language-version', '2.5', '-api-version', '2.5',
    '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts', '-Xwasm-use-new-exception-proposal'];
}
function overlayCommand(bootstrap, outputRoot, variant, java, flags, temporaryRoot) {
  return [java, '-Xmx768m', '-Djava.io.tmpdir=' + temporaryRoot, '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
    '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', '2.5', '-api-version', '2.5', ...flags,
    '-Xfriend-paths=' + bootstrap.artifacts.find(row => row.id === 'compiler').path, '-classpath', bootstrap.classPath,
    '-d', path.join(outputRoot, variant + '.jar'), ...[...TARGETS, ...CALLERS].map(logical => path.join(outputRoot, 'sources', variant, logical)),
    path.join(HERE, 'RuntimeCompilerLauncher.kt')];
}
function origins(stderr, overlay, compiler) {
  const rows = stderr.split('\n').filter(line => line.startsWith('DEQUE_ORIGIN\t')).map(line => {
    const [, className, filename] = line.split('\t'); return { className, filename };
  });
  assert.deepEqual(rows, [...OVERLAY_CLASSES.map(className => ({ className, filename: overlay })),
    ...BOOTSTRAP_CLASSES.map(className => ({ className, filename: compiler }))]);
  return rows;
}
async function runNodeCases(configFile) {
  const config = JSON.parse(await readRegular(configFile));
  const { runKotlinWasiProgram } = await import(pathToFileURL(config.programModule));
  const results = [];
  for (const test of config.cases) {
    const bytes = new Uint8Array(await readRegular(test.filename, 8 * 1024 * 1024));
    const module = await WebAssembly.compile(bytes);
    const result = await runKotlinWasiProgram({ bytes, stdin: new Uint8Array(test.stdin),
      maxProgramBytes: 8388608, maxStdinBytes: 8388608, maxOutputBytes: 1048576 });
    results.push({ id: test.id, fixtureId: test.fixtureId, variant: test.variant,
      imports: WebAssembly.Module.imports(module), exports: WebAssembly.Module.exports(module), result });
  }
  await writeJson(config.resultFile, { nodeVersion: process.version, v8Version: process.versions.v8, results });
}

export async function runDequeRuntime(config) {
  const { sourceRoot, cacheRoot, stdlibFile, stdlibReceiptFile, consumerRoot, playwrightFrom, temporaryRoot } = config;
  const outputRoot = path.resolve(config.outputRoot);
  assert(ownedOutput(outputRoot), 'Dedicated repository output or uniquely owned tmpfs runtime output required');
  await assertNoSymlink(outputRoot); await mkdir(outputRoot, { mode: 0o700 });
  assert.equal(temporaryRoot, path.resolve(temporaryRoot)); assert(temporaryRoot.length < 55);
  await assertNoSymlink(temporaryRoot);
  assert.equal((await lstat(temporaryRoot)).mode & 0o777, 0o700);
  const inputs = [], inputNames = new Set(), commands = [], originalSources = [];
  async function pin(filename) {
    filename = path.resolve(filename); const row = { filename, ...await fileIdentity(filename) };
    if (inputNames.has(filename)) assert.deepEqual(inputs.find(item => item.filename === filename), row);
    else { inputNames.add(filename); inputs.push(row); }
    return row;
  }
  async function put(relative, bytes) {
    const filename = path.join(outputRoot, relative); assert(filename.startsWith(outputRoot + path.sep));
    await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename;
  }
  async function run(phase, command, expectedExit = 0) {
    const started = performance.now(); let stdout = '', stderr = '', exitCode = 0, signal = null;
    try { ({ stdout, stderr } = await execute(command[0], command.slice(1), {
      cwd: outputRoot, env: { ...process.env, TMPDIR: temporaryRoot }, timeout: 300000, maxBuffer: 16 * 1024 * 1024,
    })); }
    catch (error) { stdout = String(error.stdout ?? ''); stderr = String(error.stderr ?? ''); exitCode = error.code; signal = error.signal ?? null; }
    await put('logs/' + phase + '.stdout', stdout); await put('logs/' + phase + '.stderr', stderr);
    commands.push({ phase, command, cwd: outputRoot, exitCode, signal, elapsedMs: performance.now() - started,
      stdout: 'logs/' + phase + '.stdout', stderr: 'logs/' + phase + '.stderr' });
    assert.equal(signal, null, 'Terminated ' + phase); assert.equal(exitCode, expectedExit, 'Unexpected exit ' + phase);
    return { stdout, stderr };
  }
  try {
    for (const name of [...OWN, ...HELPERS]) await pin(path.join(HERE, name));
    const closure = JSON.parse(await readRegular(path.join(HERE, '../closure.lock.json')));
    const flags = JSON.parse(await readRegular(path.join(HERE, '../build-flags.json'))).compilerFlags;
    for (const logical of [...TARGETS, ...CALLERS]) {
      const filename = path.join(sourceRoot, logical), originalPin = await pin(filename);
      const original = verifyFile(await readRegular(filename), closure.files.find(row => row.path === logical));
      originalSources.push({ path: logical, ...originalPin, transformed: TARGETS.includes(logical) });
      for (const variant of VARIANTS) {
        const bytes = variant === 'common' && TARGETS.includes(logical) ? transformCommonDequeApi(logical, original) : original;
        await put(path.join('sources', variant, logical), bytes);
      }
    }
    const bootstrap = await verifyBootstrap(cacheRoot);
    for (const item of bootstrap.artifacts) samePin(await pin(item.path), item);
    samePin(await pin(stdlibFile), STDLIB); const stdlibReceiptPin = await pin(stdlibReceiptFile);
    assert.equal(stdlibReceiptPin.sha256, STDLIB_RECEIPT);
    const stdlibReceipt = JSON.parse(await readRegular(stdlibReceiptFile));
    samePin(stdlibReceipt.stdlib, STDLIB); assert.equal(stdlibReceipt.stdlib.sourceCommit, closure.source.commit);
    assert.equal(stdlibReceipt.stdlib.patched, true);
    const java = await realpath('/usr/bin/java'), node = await realpath(process.execPath), javaRoot = path.resolve(java, '../..');
    for (const filename of [java, node, path.join(javaRoot, 'release'), path.join(javaRoot, 'lib/modules'), path.join(javaRoot, 'lib/server/libjvm.so')]) await pin(filename);
    const require = createRequire(path.resolve(playwrightFrom)), consumerRequire = createRequire(path.join(consumerRoot, 'package.json'));
    const { chromium } = require('playwright-core'), ts = consumerRequire('typescript');
    const tsFile = await realpath(consumerRequire.resolve('typescript')), playwrightPackage = await realpath(require.resolve('playwright-core/package.json'));
    await pin(tsFile);
    for (const filename of await regularFiles(path.dirname(playwrightPackage))) await pin(filename);
    const chromiumExecutable = await realpath(chromium.executablePath());
    for (const filename of await regularFiles(path.dirname(chromiumExecutable))) await pin(filename);
    const modules = {};
    for (const name of ['wasi', 'program', 'program.worker']) {
      const filename = path.join(consumerRoot, 'runtimes/wasm-kotlin/src/' + name + '.ts'); await pin(filename);
      const bytes = await readRegular(filename), generated = ts.transpileModule(bytes.toString(), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, reportDiagnostics: true });
      assert.deepEqual(generated.diagnostics, []); modules[name] = generated.outputText;
      await put('consumer/' + name + '.ts', bytes); await put('consumer/' + name + '.js', generated.outputText);
    }
    await put('consumer/package.json', '{"type":"module"}\n');
    for (const variant of VARIANTS) await run(variant + '-overlay', overlayCommand(bootstrap, outputRoot, variant, java, flags, temporaryRoot));
    const compiler = bootstrap.artifacts.find(row => row.id === 'compiler').path, classOrigins = [];
    for (const fixture of fixtures) {
      const sources = [];
      for (const [name, code] of Object.entries(fixture.files)) sources.push(await put('fixtures/' + fixture.id + '/source/' + name, code));
      for (const variant of VARIANTS) {
        const root = path.join(outputRoot, 'fixtures', fixture.id, variant);
        await mkdir(path.join(root, 'klib'), { recursive: true }); await mkdir(path.join(root, 'binary'));
        const command = compilerCommand(bootstrap, outputRoot, variant, java, temporaryRoot), commonFlags = compilerFlags(stdlibFile);
        const source = await run(fixture.id + '-' + variant + '-source', [...command, ...commonFlags, '-Xir-produce-klib-file',
          '-ir-output-dir', path.join(root, 'klib'), '-ir-output-name', fixture.id, ...sources], fixture.compileError ? 1 : 0);
        classOrigins.push({ phase: fixture.id + '-' + variant + '-source', rows: origins(source.stderr, path.join(outputRoot, variant + '.jar'), compiler) });
        if (fixture.compileError) { assert.match(source.stderr, /error:/); continue; }
        const binary = await run(fixture.id + '-' + variant + '-binary', [...command, ...commonFlags, '-Xir-produce-js', '-Xir-dce',
          '-Xinclude=' + path.join(root, 'klib', fixture.id + '.klib'), '-ir-output-dir', path.join(root, 'binary'), '-ir-output-name', fixture.id]);
        classOrigins.push({ phase: fixture.id + '-' + variant + '-binary', rows: origins(binary.stderr, path.join(outputRoot, variant + '.jar'), compiler) });
      }
    }
    const cases = expectedCases(outputRoot), nodeResultFile = path.join(outputRoot, 'node.json');
    const nodeConfig = await put('node-config.json', JSON.stringify({ programModule: path.join(outputRoot, 'consumer/program.js'), resultFile: nodeResultFile, cases }, null, 2) + '\n');
    await run('node-consumer', [node, '--experimental-wasm-exnref', fileURLToPath(import.meta.url), '--node-cases', nodeConfig]);
    const nodeResult = JSON.parse(await readRegular(nodeResultFile));
    const browser = await observeMainEntriesInChromium({ chromium, executablePath: chromiumExecutable, modules, cases, temporaryRoot });
    await put('chromium.json', JSON.stringify(browser, null, 2) + '\n');
    for (const [index, test] of cases.entries()) {
      const fixture = fixtures.find(row => row.id === test.fixtureId), actual = nodeResult.results[index], other = browser.results[index];
      assert.equal(actual.id, test.id); assert.equal(other.id, test.id);
      verifyResult(fixture, actual.result); verifyResult(fixture, other.result); assert.deepEqual(other.result, actual.result);
      assert(actual.imports.every(row => row.module === 'wasi_snapshot_preview1' && ['fd_read', 'fd_write', 'poll_oneoff', 'random_get'].includes(row.name)));
      const reference = nodeResult.results.find(row => row.fixtureId === test.fixtureId && row.variant === 'original');
      assert.deepEqual(actual.result, reference.result); assert.deepEqual(actual.imports, reference.imports); assert.deepEqual(actual.exports, reference.exports);
    }
    for (const item of inputs) samePin(await fileIdentity(item.filename), item);
    const artifacts = [];
    for (const filename of await regularFiles(outputRoot)) artifacts.push({ path: path.relative(outputRoot, filename), ...await fileIdentity(filename) });
    const receipt = { schemaVersion: 1, kind: 'official-compiler-common-deque-runtime', result: 'pass', outputRoot, sourceRoot, cacheRoot,
      stdlibFile, stdlibReceiptFile, consumerRoot, playwrightFrom, temporaryRoot, source: closure.source, inputs, inputsUnchanged: true, artifacts, commands,
      originalSources, classOrigins, java, node, tsFile, typescriptVersion: ts.version, playwrightPackage, chromiumExecutable,
      cases, browser: { ...browser, results: undefined }, nodeVersion: nodeResult.nodeVersion,
      comparison: { originalAndCommonSourceOverlays: true, completeChangedFiles: 6, completeUnchangedInlineCallers: 4,
        nodeCases: cases.length, chromiumCases: cases.length, rawResultsEqual: true, noOutputNormalization: true,
        sourceAndBinaryPhasesUseAuthenticatedOverlays: true },
      limits: ['The remaining compiler implementation is the official bootstrap binary; its exact source commit is unknown.',
        'Class origin checks authenticate selection but do not prove every method or partial-linkage failure path was executed.',
        'This is JVM-hosted Kotlin compilation followed by Wasm execution; the whole browser compiler remains unbuilt.'],
      fullCompilerBuilt: false, browserKotlinCompilation: false, publicLanguageSupport: false };
    const receiptFile = path.join(outputRoot, 'runtime-receipt.json'); await writeJson(receiptFile, receipt);
    await verifyDequeRuntime(receiptFile); return { receiptFile, receipt };
  } catch (error) {
    await writeJson(path.join(outputRoot, 'failure.json'), { result: 'fail', error: String(error), inputs, commands }); throw error;
  }
}

export async function verifyDequeRuntime(receiptFile) {
  const r = JSON.parse(await readRegular(receiptFile, 32 * 1024 * 1024));
  assert.equal(r.kind, 'official-compiler-common-deque-runtime'); assert.equal(r.result, 'pass');
  assert.equal(r.inputsUnchanged, true); assert.equal(r.fullCompilerBuilt, false);
  assert.equal(r.browserKotlinCompilation, false); assert.equal(r.publicLanguageSupport, false);
  assert.equal(r.outputRoot, path.resolve(r.outputRoot));
  assert(ownedOutput(r.outputRoot));
  assert.equal(receiptFile, path.join(r.outputRoot, 'runtime-receipt.json'));
  assert.deepEqual(r.cases, expectedCases(r.outputRoot));
  assert.deepEqual(r.originalSources.map(row => row.path), [...TARGETS, ...CALLERS]);
  const closure = JSON.parse(await readRegular(path.join(HERE, '../closure.lock.json')));
  assert.deepEqual(r.source, closure.source);
  for (const row of r.originalSources) {
    assert.equal(row.filename, path.join(r.sourceRoot, row.path));
    const bytes = verifyFile(await readRegular(row.filename), closure.files.find(item => item.path === row.path));
    samePin(identity(bytes), row); assert.equal(row.transformed, TARGETS.includes(row.path));
    for (const variant of VARIANTS) assert.deepEqual(await readRegular(path.join(r.outputRoot, 'sources', variant, row.path)),
      variant === 'common' && row.transformed ? transformCommonDequeApi(row.path, bytes) : bytes);
  }
  for (const item of r.inputs) samePin(await fileIdentity(item.filename), item);
  for (const item of r.artifacts) {
    const filename = path.resolve(r.outputRoot, item.path);
    assert(filename.startsWith(r.outputRoot + path.sep) && path.relative(r.outputRoot, filename) === item.path);
    samePin(await fileIdentity(filename), item);
  }
  assert.equal(new Set(r.inputs.map(row => row.filename)).size, r.inputs.length);
  assert.deepEqual(r.artifacts.map(row => row.path), (await regularFiles(r.outputRoot)).filter(filename => filename !== receiptFile)
    .map(filename => path.relative(r.outputRoot, filename)), 'Complete output inventory');
  const bootstrap = await verifyBootstrap(r.cacheRoot), compiler = bootstrap.artifacts.find(row => row.id === 'compiler').path;
  const javaRoot = path.resolve(r.java, '../..');
  const expectedInputs = [...OWN, ...HELPERS].map(name => path.resolve(HERE, name));
  expectedInputs.push(...[...TARGETS, ...CALLERS].map(name => path.join(r.sourceRoot, name)), ...bootstrap.artifacts.map(row => row.path),
    r.stdlibFile, r.stdlibReceiptFile, r.java, r.node, path.join(javaRoot, 'release'), path.join(javaRoot, 'lib/modules'),
    path.join(javaRoot, 'lib/server/libjvm.so'), r.tsFile, ...await regularFiles(path.dirname(r.playwrightPackage)),
    ...await regularFiles(path.dirname(r.chromiumExecutable)),
    ...['wasi', 'program', 'program.worker'].map(name => path.join(r.consumerRoot, 'runtimes/wasm-kotlin/src/' + name + '.ts')));
  assert.deepEqual(r.inputs.map(row => row.filename), [...new Set(expectedInputs)], 'Complete frozen input inventory');
  const flags = JSON.parse(await readRegular(path.join(HERE, '../build-flags.json'))).compilerFlags;
  const expected = VARIANTS.map(variant => ({ phase: variant + '-overlay', command: overlayCommand(bootstrap, r.outputRoot, variant, r.java, flags, r.temporaryRoot), exitCode: 0 }));
  const expectedOrigins = [];
  for (const fixture of fixtures) {
    const sources = [];
    for (const [name, code] of Object.entries(fixture.files)) {
      const filename = path.join(r.outputRoot, 'fixtures', fixture.id, 'source', name);
      assert.deepEqual(await readRegular(filename), Buffer.from(code)); sources.push(filename);
    }
    for (const variant of VARIANTS) {
      const root = path.join(r.outputRoot, 'fixtures', fixture.id, variant), command = compilerCommand(bootstrap, r.outputRoot, variant, r.java, r.temporaryRoot);
      const phase = fixture.id + '-' + variant + '-source';
      expected.push({ phase, command: [...command, ...compilerFlags(r.stdlibFile), '-Xir-produce-klib-file',
        '-ir-output-dir', path.join(root, 'klib'), '-ir-output-name', fixture.id, ...sources], exitCode: fixture.compileError ? 1 : 0 });
      const stderr = (await readRegular(path.join(r.outputRoot, 'logs', phase + '.stderr'))).toString();
      expectedOrigins.push({ phase, rows: origins(stderr, path.join(r.outputRoot, variant + '.jar'), compiler) });
      if (fixture.compileError) { assert.match(stderr, /error:/); continue; }
      const binaryPhase = fixture.id + '-' + variant + '-binary';
      expected.push({ phase: binaryPhase, command: [...command, ...compilerFlags(r.stdlibFile), '-Xir-produce-js', '-Xir-dce',
        '-Xinclude=' + path.join(root, 'klib', fixture.id + '.klib'), '-ir-output-dir', path.join(root, 'binary'), '-ir-output-name', fixture.id], exitCode: 0 });
      expectedOrigins.push({ phase: binaryPhase, rows: origins((await readRegular(path.join(r.outputRoot, 'logs', binaryPhase + '.stderr'))).toString(),
        path.join(r.outputRoot, variant + '.jar'), compiler) });
    }
  }
  expected.push({ phase: 'node-consumer', command: [r.node, '--experimental-wasm-exnref', fileURLToPath(import.meta.url), '--node-cases', path.join(r.outputRoot, 'node-config.json')], exitCode: 0 });
  assert.deepEqual(r.commands.map(({ phase, command, exitCode }) => ({ phase, command, exitCode })), expected);
  assert(r.commands.every(row => row.signal === null && row.cwd === r.outputRoot && row.stdout === 'logs/' + row.phase + '.stdout' && row.stderr === 'logs/' + row.phase + '.stderr'));
  assert.deepEqual(r.classOrigins, expectedOrigins);
  samePin(await fileIdentity(r.stdlibFile), STDLIB); assert.equal((await fileIdentity(r.stdlibReceiptFile)).sha256, STDLIB_RECEIPT);
  const consumerRequire = createRequire(path.join(r.consumerRoot, 'package.json')), ts = consumerRequire('typescript');
  assert.equal(ts.version, r.typescriptVersion); assert.equal(await realpath(consumerRequire.resolve('typescript')), r.tsFile);
  for (const name of ['wasi', 'program', 'program.worker']) {
    const bytes = await readRegular(path.join(r.consumerRoot, 'runtimes/wasm-kotlin/src/' + name + '.ts'));
    assert.deepEqual(await readRegular(path.join(r.outputRoot, 'consumer', name + '.ts')), bytes);
    const generated = ts.transpileModule(bytes.toString(), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, reportDiagnostics: true });
    assert.deepEqual(generated.diagnostics, []);
    assert.deepEqual(await readRegular(path.join(r.outputRoot, 'consumer', name + '.js')), Buffer.from(generated.outputText));
  }
  assert.deepEqual(JSON.parse(await readRegular(path.join(r.outputRoot, 'node-config.json'))), {
    programModule: path.join(r.outputRoot, 'consumer/program.js'), resultFile: path.join(r.outputRoot, 'node.json'), cases: r.cases,
  });
  const nodeResult = JSON.parse(await readRegular(path.join(r.outputRoot, 'node.json'))), browser = JSON.parse(await readRegular(path.join(r.outputRoot, 'chromium.json')));
  assert.equal(nodeResult.results.length, r.cases.length); assert.equal(browser.results.length, r.cases.length);
  assert.equal(browser.freshWorkers, r.cases.length); assert.equal(browser.offlineBeforeWorkers, true); assert.deepEqual(browser.requests, []);
  assert.equal(browser.process.exitCode, 0); assert.equal(browser.process.signal, null);
  const { results: ignoredResults, ...browserMetadata } = browser;
  assert.deepEqual(r.browser, browserMetadata);
  for (const [i, test] of r.cases.entries()) {
    const actual = nodeResult.results[i], other = browser.results[i], fixture = fixtures.find(row => row.id === test.fixtureId);
    assert.equal(actual.id, test.id); assert.equal(other.id, test.id); verifyResult(fixture, actual.result); verifyResult(fixture, other.result);
    assert.deepEqual(actual.result, other.result); const original = nodeResult.results.find(row => row.fixtureId === test.fixtureId && row.variant === 'original');
    assert.deepEqual(actual.result, original.result); assert.deepEqual(actual.imports, original.imports); assert.deepEqual(actual.exports, original.exports);
  }
  assert.deepEqual(r.comparison, { originalAndCommonSourceOverlays: true, completeChangedFiles: 6, completeUnchangedInlineCallers: 4,
    nodeCases: r.cases.length, chromiumCases: r.cases.length, rawResultsEqual: true, noOutputNormalization: true, sourceAndBinaryPhasesUseAuthenticatedOverlays: true });
  return { result: 'pass', sources: r.originalSources.length, nodeCases: r.cases.length, chromiumCases: r.cases.length,
    inputPins: r.inputs.length, artifacts: r.artifacts.length };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === '--node-cases') await runNodeCases(process.argv[3]);
  else if (process.argv[2] === '--verify') console.log(JSON.stringify(await verifyDequeRuntime(path.resolve(process.argv[3]))));
  else {
    const result = await runDequeRuntime(JSON.parse(await readRegular(path.resolve(process.argv[2]))));
    console.log(JSON.stringify({ result: result.receipt.result, receiptFile: result.receiptFile, comparison: result.receipt.comparison }));
  }
}
