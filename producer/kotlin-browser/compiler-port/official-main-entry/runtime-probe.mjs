import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, assertNoSymlink, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { fixtures, verifyRuntimeResult } from './runtime-fixtures.mjs';
import { observeMainEntriesInChromium } from './runtime-browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const execute = promisify(execFile), identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const TARGETS = [
  'compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/utils/JsMainFunctionDetector.kt',
  'compiler/ir/backend.wasm/src/org/jetbrains/kotlin/backend/wasm/lower/generateMainFunctionCalls.kt',
];
const OWN = ['runtime-probe.mjs', 'runtime-fixtures.mjs', 'runtime-browser.mjs', 'RuntimeCompilerLauncher.kt'];
const INPUT_HELPERS = ['../closure.lock.json', '../../build/bootstrap.mjs', '../../build/bootstrap.lock.json',
  '../../manifest.json', '../../sources.lock.json', '../../scripts/source.mjs', '../../stdlib-probe/console-runtime/evidence/receipt.json'];
const ORIGINS = [
  'org.jetbrains.kotlin.ir.backend.js.utils.JsMainFunctionDetector',
  'org.jetbrains.kotlin.ir.backend.js.utils.JsMainFunctionDetectorKt',
  'org.jetbrains.kotlin.backend.wasm.lower.GenerateMainFunctionWrappers',
  'org.jetbrains.kotlin.backend.wasm.lower.GenerateMainFunctionCallsKt',
];
const STDLIB = { bytes: 4111645, sha256: '3c97b68581963cf32c18d8b6d93b467f3accc9eae2689c1655e8ed4b31f52d28' };
const STDLIB_RECEIPT_SHA256 = 'fe7d12a5f7328a72ac397356b1b8f6d72f826f6b3c8e6a3ccdebe1e3a142c655';
const equalPin = (actual, expected) => assert.deepEqual({ bytes: actual.bytes, sha256: actual.sha256 },
  { bytes: expected.bytes, sha256: expected.sha256 });

async function fileIdentity(filename) {
  await assertNoSymlink(filename);
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); assert(stat.isFile());
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { bytes += chunk.length; hash.update(chunk); }
    assert.equal(bytes, stat.size); return { bytes, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}
async function executable(name) {
  for (const directory of process.env.PATH.split(path.delimiter)) {
    try { const filename = path.resolve(directory, name); await access(filename, constants.X_OK); return await realpath(filename); }
    catch (error) { if (!['ENOENT', 'EACCES'].includes(error.code)) throw error; }
  }
  throw new Error('Executable unavailable: ' + name);
}
async function regularFiles(root) {
  await assertNoSymlink(root); const result = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, item.name); assert(!item.isSymbolicLink());
    if (item.isDirectory()) result.push(...await regularFiles(filename));
    else { assert(item.isFile()); result.push(filename); }
  }
  return result.sort();
}

async function runNodeCases(configFile) {
  const config = JSON.parse(await readRegular(configFile, 16 * 1024 * 1024));
  const { runKotlinWasiProgram } = await import(pathToFileURL(config.programModule));
  const results = [];
  for (const test of config.cases) {
    const bytes = new Uint8Array(await readRegular(test.filename, 8 * 1024 * 1024));
    let module = null, validationError = null;
    try { module = await WebAssembly.compile(bytes); } catch (error) { validationError = String(error); }
    const result = await runKotlinWasiProgram({ bytes, stdin: new Uint8Array(test.stdin),
      maxProgramBytes: 8388608, maxStdinBytes: 8388608, maxOutputBytes: 1048576 });
    results.push({ id: test.id, fixtureId: test.fixtureId, variant: test.variant,
      validModule: module !== null, imports: module ? WebAssembly.Module.imports(module) : null,
      exports: module ? WebAssembly.Module.exports(module) : null, validationError, result });
  }
  await writeJson(config.resultFile, { nodeVersion: process.version, v8Version: process.versions.v8, results });
}

export async function runMainRuntime({ outputRoot, sourceRoot, cacheRoot, stdlibFile, stdlibReceiptFile,
  consumerRoot, playwrightFrom, temporaryRoot }) {
  outputRoot = path.resolve(outputRoot); sourceRoot = path.resolve(sourceRoot);
  assert(outputRoot.startsWith(path.join(REPO, 'out/entry-runtime-v')) && outputRoot === path.resolve(outputRoot));
  await assertNoSymlink(outputRoot); await assertNoSymlink(temporaryRoot);
  assert(!temporaryRoot.startsWith('/dev/shm/') && temporaryRoot.length < 55);
  const tmpStat = await lstat(temporaryRoot); assert(tmpStat.isDirectory()); assert.equal(tmpStat.mode & 0o777, 0o700);
  await mkdir(outputRoot, { mode: 0o700 });
  const inputPins = [], inputNames = new Set(), artifacts = [], commands = [];
  async function pin(filename) {
    filename = path.resolve(filename); const row = { filename, ...await fileIdentity(filename) };
    if (inputNames.has(filename)) assert.deepEqual(inputPins.find(pin => pin.filename === filename), row);
    else { inputNames.add(filename); inputPins.push(row); }
    return row;
  }
  async function put(relative, bytes) {
    const filename = path.join(outputRoot, relative);
    assert(filename.startsWith(outputRoot + path.sep)); await assertNoSymlink(filename);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename;
  }
  async function run(phase, command, args) {
    const started = performance.now(); let stdout = '', stderr = '', exitCode = 0, signal = null;
    try { ({ stdout, stderr } = await execute(command, args, { cwd: outputRoot, timeout: 300000, maxBuffer: 16 * 1024 * 1024 })); }
    catch (error) { stdout = String(error.stdout ?? ''); stderr = String(error.stderr ?? ''); exitCode = error.code; signal = error.signal ?? null; }
    const stdoutFile = await put('logs/' + phase + '.stdout', stdout), stderrFile = await put('logs/' + phase + '.stderr', stderr);
    const row = { phase, command: [command, ...args], cwd: outputRoot, exitCode, signal,
      elapsedMs: performance.now() - started, stdout: path.relative(outputRoot, stdoutFile), stderr: path.relative(outputRoot, stderrFile) };
    commands.push(row); assert.equal(signal, null, 'Compiler/execution terminated: ' + phase);
    return { ...row, stdoutText: stdout, stderrText: stderr };
  }
  try {
    for (const name of OWN) await pin(path.join(HERE, name));
    for (const relative of INPUT_HELPERS) await pin(path.join(HERE, relative));
    const closure = JSON.parse(await readRegular(path.join(HERE, '../closure.lock.json')));
    const originals = [];
    for (const logical of TARGETS) {
      const filename = path.join(sourceRoot, logical), pinRow = await pin(filename);
      const bytes = verifyFile(await readRegular(filename), closure.files.find(pin => pin.path === logical));
      const snapshot = await put('official-source/' + path.basename(logical), bytes);
      originals.push({ path: logical, original: pinRow, snapshot: path.relative(outputRoot, snapshot), ...identity(bytes) });
    }
    const bootstrap = await verifyBootstrap(cacheRoot);
    for (const artifact of bootstrap.artifacts) equalPin(await pin(artifact.path), artifact);
    equalPin(await pin(stdlibFile), STDLIB);
    const targetReceiptPin = await pin(stdlibReceiptFile); assert.equal(targetReceiptPin.sha256, STDLIB_RECEIPT_SHA256);
    const targetReceipt = JSON.parse(await readRegular(stdlibReceiptFile)); equalPin(targetReceipt.stdlib, STDLIB);
    assert.equal(targetReceipt.stdlib.patched, true); assert.equal(targetReceipt.stdlib.sourceCommit, closure.source.commit);
    assert.equal(targetReceipt.stdlib.patchSha256, '6994f87ecccf1de6abc06c01f8fe35018be5ebf1595cf9d9f127a8416e01fede');
    const java = await executable('java'), node = await realpath(process.execPath), javaRoot = path.resolve(java, '../..');
    for (const filename of [java, node, path.join(javaRoot, 'release'), path.join(javaRoot, 'lib/modules'), path.join(javaRoot, 'lib/server/libjvm.so')]) await pin(filename);
    const require = createRequire(path.resolve(playwrightFrom)), consumerRequire = createRequire(path.join(consumerRoot, 'package.json'));
    const ts = consumerRequire('typescript'), { chromium } = require('playwright-core');
    const tsFile = await realpath(consumerRequire.resolve('typescript')); await pin(tsFile);
    const playwrightPackage = await realpath(require.resolve('playwright-core/package.json'));
    for (const filename of await regularFiles(path.dirname(playwrightPackage))) await pin(filename);
    const chromiumExecutable = await realpath(chromium.executablePath());
    for (const filename of await regularFiles(path.dirname(chromiumExecutable))) await pin(filename);
    const modules = {}, consumerFiles = [];
    for (const name of ['wasi', 'program', 'program.worker']) {
      const filename = path.join(consumerRoot, 'runtimes/wasm-kotlin/src/' + name + '.ts'); await pin(filename);
      const bytes = await readRegular(filename), transpiled = ts.transpileModule(bytes.toString(), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, reportDiagnostics: true });
      assert.deepEqual(transpiled.diagnostics, []); modules[name] = transpiled.outputText;
      await put('consumer/' + name + '.ts', bytes); await put('consumer/' + name + '.js', transpiled.outputText);
      consumerFiles.push({ filename, ...identity(bytes), generated: identity(Buffer.from(transpiled.outputText)) });
    }
    assert.equal(modules.program.split("from './wasi.js'").length, 2);
    assert.equal(modules['program.worker'].split("from './program.js'").length, 2);
    await put('consumer/package.json', '{"type":"module"}\n');
    const compiler = bootstrap.artifacts.find(row => row.id === 'compiler').path;
    const overlayJar = path.join(outputRoot, 'official-main-overlay.jar');
    const overlayBuild = await run('overlay-build', java, ['-Xmx768m', '-cp', bootstrap.classPath,
      'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17',
      '-language-version', '2.5', '-api-version', '2.5', '-Xfriend-paths=' + compiler,
      '-opt-in=org.jetbrains.kotlin.ir.symbols.UnsafeDuringIrConstructionAPI', '-classpath', bootstrap.classPath,
      '-d', overlayJar, ...originals.map(row => path.join(outputRoot, row.snapshot)), path.join(HERE, 'RuntimeCompilerLauncher.kt')]);
    assert.equal(overlayBuild.exitCode, 0, 'Complete official source overlay failed; no fallback is permitted');
    const baselineCompiler = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler'];
    const overlayCompiler = ['-Xmx768m', '-cp', overlayJar + path.delimiter + bootstrap.classPath,
      'org.jetbrains.kotlin.portable.mainentry.runtime.RuntimeCompilerLauncherKt', overlayJar, compiler];
    const flags = ['-Xwasm-target=wasm-wasi', '-libraries', stdlibFile, '-main', 'call',
      '-language-version', '2.5', '-api-version', '2.5', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts',
      '-Xwasm-use-new-exception-proposal'];
    const cases = [], compiled = [], classOrigins = [];
    for (const fixture of fixtures) {
      const root = path.join(outputRoot, 'fixtures', fixture.id), sources = [];
      for (const [filename, source] of Object.entries(fixture.files)) sources.push(await put('fixtures/' + fixture.id + '/source/' + filename, source));
      await mkdir(path.join(root, 'klib'));
      const source = await run(fixture.id + '-source', java, [...baselineCompiler, ...flags, '-Xir-produce-klib-file',
        '-ir-output-dir', path.join(root, 'klib'), '-ir-output-name', fixture.id, ...sources]);
      if (fixture.compileError) {
        assert.equal(source.exitCode, 1); assert.match(source.stderrText, /error:/);
        compiled.push({ id: fixture.id, sourceExitCode: 1, generatedProgram: false }); continue;
      }
      assert.equal(source.exitCode, 0, fixture.id + ': frontend rejected actual source');
      for (const [variant, command] of [['bootstrap', baselineCompiler], ['pinned-overlay', overlayCompiler]]) {
        const program = path.join(root, variant); await mkdir(program);
        const binary = await run(fixture.id + '-' + variant + '-binary', java, [...command, ...flags, '-Xir-produce-js', '-Xir-dce',
          '-Xinclude=' + path.join(root, 'klib', fixture.id + '.klib'), '-ir-output-dir', program, '-ir-output-name', fixture.id]);
        assert.equal(binary.exitCode, 0, fixture.id + ': official binary generation failed');
        if (variant === 'pinned-overlay') {
          const rows = binary.stderrText.split('\n').filter(line => line.startsWith('OFFICIAL_MAIN_ORIGIN\t')).map(line => {
            const [, className, filename] = line.split('\t'); return { className, filename };
          });
          for (const className of ORIGINS) assert.deepEqual(rows.find(row => row.className === className), { className, filename: overlayJar });
          for (const className of ['org.jetbrains.kotlin.backend.wasm.WasmBackendContext', 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler'])
            assert.deepEqual(rows.find(row => row.className === className), { className, filename: compiler });
          assert.equal(rows.length, 6); classOrigins.push({ fixture: fixture.id, rows });
        }
        const filename = path.join(program, fixture.id + '.wasm'); await readRegular(filename, 8388608);
        cases.push({ id: fixture.id + '/' + variant, fixtureId: fixture.id, variant, filename,
          stdin: [...Buffer.from(fixture.stdin ?? '')] });
      }
      compiled.push({ id: fixture.id, sourceExitCode: 0, generatedProgram: true });
    }
    // Repeat fresh instances/Workers after all errors, with observable global state.
    for (const variant of ['bootstrap', 'pinned-overlay']) {
      for (const fixtureId of ['no-arg', 'stdin-args']) {
        const prior = cases.find(row => row.fixtureId === fixtureId && row.variant === variant);
        cases.push({ ...prior, id: prior.id + '/fresh-repeat' });
      }
    }
    const nodeResultFile = path.join(outputRoot, 'node.json');
    const nodeConfig = await put('node-config.json', JSON.stringify({ programModule: path.join(outputRoot, 'consumer/program.js'),
      resultFile: nodeResultFile, cases: cases.map(({ binary, ...row }) => row) }, null, 2) + '\n');
    const nodeRun = await run('node-consumer', node, ['--experimental-wasm-exnref', fileURLToPath(import.meta.url), '--node-cases', nodeConfig]);
    assert.equal(nodeRun.exitCode, 0);
    const nodeResult = JSON.parse(await readRegular(nodeResultFile, 16 * 1024 * 1024));
    const browser = await observeMainEntriesInChromium({ chromium, executablePath: chromiumExecutable, modules,
      cases, temporaryRoot });
    await put('chromium.json', JSON.stringify(browser, null, 2) + '\n');
    for (const [index, test] of cases.entries()) {
      const fixture = fixtures.find(row => row.id === test.fixtureId), actual = nodeResult.results[index], chromiumActual = browser.results[index];
      assert.equal(actual.id, test.id); assert.equal(chromiumActual.id, test.id);
      verifyRuntimeResult(fixture, actual.result); verifyRuntimeResult(fixture, chromiumActual.result);
      assert.deepEqual(chromiumActual.result, actual.result, 'Raw Node/Chromium consumer results differ: ' + test.id);
      if (actual.imports) assert(actual.imports.every(row => row.module === 'wasi_snapshot_preview1' &&
        ['fd_read', 'fd_write', 'poll_oneoff', 'random_get'].includes(row.name)), 'No argv or new WASI imports');
      if (test.variant === 'pinned-overlay') {
        const baseline = nodeResult.results.find(row => row.fixtureId === test.fixtureId && row.variant === 'bootstrap');
        assert.deepEqual(actual.result, baseline.result, 'Full pinned source/official bootstrap behavior differs: ' + test.id);
        assert.deepEqual(actual.exports, baseline.exports); assert.deepEqual(actual.imports, baseline.imports);
      }
    }
    for (const row of inputPins) equalPin(await fileIdentity(row.filename), row);
    for (const filename of await regularFiles(outputRoot)) artifacts.push({ path: path.relative(outputRoot, filename), ...await fileIdentity(filename) });
    const receipt = { schemaVersion: 1, kind: 'official-kotlin-main-source-overlay-runtime', result: 'pass', outputRoot,
      sourceRoot, cacheRoot, consumerRoot, playwrightFrom,
      source: closure.source, inputPins, inputsUnchanged: true, artifacts, commands, originals, compiled, classOrigins,
      compiler: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts,
        overlay: { filename: overlayJar, ...await fileIdentity(overlayJar) }, exactCompleteSourceOverlay: true },
      stdlib: { filename: stdlibFile, ...STDLIB, sourceBuilt: true, patched: true, buildReceipt: targetReceiptPin,
        patchSha256: targetReceipt.stdlib.patchSha256 }, consumerFiles, typescript: { version: ts.version, filename: tsFile },
      toolchain: { java, node, playwrightPackage, chromiumExecutable },
      node: { version: nodeResult.nodeVersion, v8: nodeResult.v8Version, resultFile: 'node.json' },
      browser: { ...browser, results: undefined }, cases: cases.map(({ binary, filename, ...row }) => ({ ...row, path: path.relative(outputRoot, filename) })),
      comparison: { cases: cases.length, fullSourceFiles: 2, rawNodeEqualsChromium: true, rawOverlayEqualsBootstrap: true,
        rawOutputNormalization: false, noCompilerSourceProjection: true, noCustomSelectorOrWrapper: true,
        noAdditionalWasiImports: true, freshWorkerRecoveryAfterErrors: true },
      scope: 'Complete pinned main detector/wrapper JVM overlay in the real bootstrap compiler pipeline, actual programs through unchanged Node/Chromium consumer',
      limits: ['Other compiler implementation comes from the official bootstrap artifact, whose source commit is unknown.',
        'This does not execute BrowserCompilerPipeline.kt or compile Kotlin source inside a browser.',
        'Suspend fixtures use real immediate continuation resume/exception; arbitrary external schedulers and never-resumed coroutines are not qualified.'],
      fullCompilerBuilt: false, browserKotlinCompilation: false, fullFirToIrWasmExecuted: false, publicLanguageSupport: false };
    const receiptFile = path.join(outputRoot, 'runtime-receipt.json'); await writeJson(receiptFile, receipt);
    await verifyMainRuntime(receiptFile); return { receiptFile, receipt };
  } catch (error) {
    await writeJson(path.join(outputRoot, 'failure.json'), { result: 'fail', message: String(error), inputPins, commands,
      fullCompilerBuilt: false, browserKotlinCompilation: false }); throw error;
  }
}

export async function verifyMainRuntime(receiptFile) {
  const receipt = JSON.parse(await readRegular(receiptFile, 32 * 1024 * 1024));
  assert.equal(receipt.kind, 'official-kotlin-main-source-overlay-runtime'); assert.equal(receipt.result, 'pass');
  assert.equal(receipt.inputsUnchanged, true); assert.equal(receipt.compiler.exactCompleteSourceOverlay, true);
  assert.equal(receipt.fullCompilerBuilt, false); assert.equal(receipt.browserKotlinCompilation, false);
  assert.equal(receipt.fullFirToIrWasmExecuted, false); assert.equal(receipt.publicLanguageSupport, false);
  assert.deepEqual(receipt.originals.map(row => row.path), TARGETS);
  assert.equal(receipt.compiled.length, fixtures.length); assert.equal(receipt.classOrigins.length, fixtures.filter(row => !row.compileError).length);
  const expectedCases = fixtures.filter(row => !row.compileError).flatMap(fixture => ['bootstrap', 'pinned-overlay'].map(variant => ({
    id: fixture.id + '/' + variant, fixtureId: fixture.id, variant, stdin: [...Buffer.from(fixture.stdin ?? '')],
    path: 'fixtures/' + fixture.id + '/' + variant + '/' + fixture.id + '.wasm',
  })));
  for (const variant of ['bootstrap', 'pinned-overlay']) for (const fixtureId of ['no-arg', 'stdin-args']) {
    const prior = expectedCases.find(row => row.fixtureId === fixtureId && row.variant === variant);
    expectedCases.push({ ...prior, id: prior.id + '/fresh-repeat' });
  }
  assert.deepEqual(receipt.cases, expectedCases, 'Complete ordered runtime corpus required');
  assert.deepEqual(receipt.comparison, { cases: expectedCases.length, fullSourceFiles: 2, rawNodeEqualsChromium: true,
    rawOverlayEqualsBootstrap: true, rawOutputNormalization: false, noCompilerSourceProjection: true,
    noCustomSelectorOrWrapper: true, noAdditionalWasiImports: true, freshWorkerRecoveryAfterErrors: true });
  assert.equal(receipt.browser.freshWorkers, receipt.cases.length);
  assert.equal(receipt.browser.offlineBeforeWorkers, true); assert.deepEqual(receipt.browser.requests, []);
  assert.equal(receipt.browser.process.exitCode, 0); assert.equal(receipt.browser.process.signal, null);
  const bootstrap = await verifyBootstrap(receipt.cacheRoot);
  assert.deepEqual(receipt.compiler.artifacts, bootstrap.artifacts);
  const javaRoot = path.resolve(receipt.toolchain.java, '../..');
  const expectedInputs = [...OWN, ...INPUT_HELPERS].map(name => path.resolve(HERE, name));
  expectedInputs.push(...TARGETS.map(name => path.join(receipt.sourceRoot, name)), ...bootstrap.artifacts.map(row => row.path),
    receipt.stdlib.filename, receipt.stdlib.buildReceipt.filename, receipt.toolchain.java, receipt.toolchain.node,
    path.join(javaRoot, 'release'), path.join(javaRoot, 'lib/modules'), path.join(javaRoot, 'lib/server/libjvm.so'), receipt.typescript.filename,
    ...await regularFiles(path.dirname(receipt.toolchain.playwrightPackage)), ...await regularFiles(path.dirname(receipt.toolchain.chromiumExecutable)),
    ...['wasi', 'program', 'program.worker'].map(name => path.join(receipt.consumerRoot, 'runtimes/wasm-kotlin/src/' + name + '.ts')));
  assert.equal(new Set(receipt.inputPins.map(row => row.filename)).size, receipt.inputPins.length, 'Duplicate frozen input pin');
  assert.deepEqual(receipt.inputPins.map(row => row.filename), [...new Set(expectedInputs)], 'Complete ordered frozen input inventory required');
  equalPin(receipt.stdlib, STDLIB); assert.equal(receipt.stdlib.buildReceipt.sha256, STDLIB_RECEIPT_SHA256);
  assert.equal(receipt.stdlib.sourceBuilt, true); assert.equal(receipt.stdlib.patched, true);
  equalPin(await fileIdentity(receipt.stdlib.filename), STDLIB);
  equalPin(receipt.inputPins.find(pin => pin.filename === receipt.stdlib.filename), STDLIB);
  assert.deepEqual(receipt.stdlib.buildReceipt, receipt.inputPins.find(pin => pin.filename === receipt.stdlib.buildReceipt.filename));
  assert.equal((await fileIdentity(receipt.stdlib.buildReceipt.filename)).sha256, STDLIB_RECEIPT_SHA256);
  const targetReceipt = JSON.parse(await readRegular(receipt.stdlib.buildReceipt.filename));
  equalPin(targetReceipt.stdlib, STDLIB); assert.equal(targetReceipt.stdlib.sourceCommit, receipt.source.commit);
  assert.equal(receipt.stdlib.patchSha256, targetReceipt.stdlib.patchSha256);
  const expectedFailures = fixtures.filter(row => row.compileError).map(row => row.id + '-source');
  const expectedPhases = ['overlay-build', ...fixtures.flatMap(fixture => [fixture.id + '-source',
    ...(!fixture.compileError ? ['bootstrap', 'pinned-overlay'].map(variant => fixture.id + '-' + variant + '-binary') : [])]), 'node-consumer'];
  assert.deepEqual(receipt.commands.map(row => row.phase), expectedPhases);
  const compilerFile = bootstrap.artifacts.find(row => row.id === 'compiler').path;
  assert.deepEqual(receipt.commands[0].command, [receipt.toolchain.java, '-Xmx768m', '-cp', bootstrap.classPath,
    'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17',
    '-language-version', '2.5', '-api-version', '2.5', '-Xfriend-paths=' + compilerFile,
    '-opt-in=org.jetbrains.kotlin.ir.symbols.UnsafeDuringIrConstructionAPI', '-classpath', bootstrap.classPath,
    '-d', receipt.compiler.overlay.filename, ...TARGETS.map(name => path.join(receipt.outputRoot, 'official-source', path.basename(name))),
    path.join(HERE, 'RuntimeCompilerLauncher.kt')], 'Overlay must compile both complete source snapshots and only the origin launcher');
  const baseCompiler = [receipt.toolchain.java, '-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler'];
  const overlayCompiler = [receipt.toolchain.java, '-Xmx768m', '-cp', receipt.compiler.overlay.filename + path.delimiter + bootstrap.classPath,
    'org.jetbrains.kotlin.portable.mainentry.runtime.RuntimeCompilerLauncherKt', receipt.compiler.overlay.filename, compilerFile];
  const flags = ['-Xwasm-target=wasm-wasi', '-libraries', receipt.stdlib.filename, '-main', 'call', '-language-version', '2.5', '-api-version', '2.5',
    '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts', '-Xwasm-use-new-exception-proposal'];
  assert.deepEqual(receipt.compiled, fixtures.map(fixture => ({ id: fixture.id, sourceExitCode: fixture.compileError ? 1 : 0, generatedProgram: !fixture.compileError })));
  for (const fixture of fixtures) {
    const root = path.join(receipt.outputRoot, 'fixtures', fixture.id), sources = [];
    for (const [name, source] of Object.entries(fixture.files)) {
      const filename = path.join(root, 'source', name); sources.push(filename);
      assert.deepEqual(await readRegular(filename), Buffer.from(source), 'Actual user source must equal the complete fixture catalog');
    }
    assert.deepEqual(receipt.commands.find(row => row.phase === fixture.id + '-source').command, [...baseCompiler, ...flags,
      '-Xir-produce-klib-file', '-ir-output-dir', path.join(root, 'klib'), '-ir-output-name', fixture.id, ...sources]);
    if (!fixture.compileError) for (const [variant, command] of [['bootstrap', baseCompiler], ['pinned-overlay', overlayCompiler]]) {
      assert.deepEqual(receipt.commands.find(row => row.phase === fixture.id + '-' + variant + '-binary').command,
        [...command, ...flags, '-Xir-produce-js', '-Xir-dce', '-Xinclude=' + path.join(root, 'klib', fixture.id + '.klib'),
          '-ir-output-dir', path.join(root, variant), '-ir-output-name', fixture.id]);
    }
  }
  assert.deepEqual(receipt.commands.at(-1).command, [receipt.toolchain.node, '--experimental-wasm-exnref',
    fileURLToPath(import.meta.url), '--node-cases', path.join(receipt.outputRoot, 'node-config.json')]);
  for (const row of receipt.commands) {
    assert.equal(row.exitCode, expectedFailures.includes(row.phase) ? 1 : 0); assert.equal(row.signal, null);
    assert.equal(row.cwd, receipt.outputRoot); assert.equal(row.stdout, 'logs/' + row.phase + '.stdout');
    assert.equal(row.stderr, 'logs/' + row.phase + '.stderr'); assert(Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0);
  }
  const consumerRequire = createRequire(path.join(receipt.consumerRoot, 'package.json')), ts = consumerRequire('typescript');
  assert.equal(receipt.typescript.version, ts.version); assert.equal(receipt.typescript.filename, await realpath(consumerRequire.resolve('typescript')));
  assert.deepEqual(receipt.consumerFiles.map(row => row.filename), ['wasi', 'program', 'program.worker']
    .map(name => path.join(receipt.consumerRoot, 'runtimes/wasm-kotlin/src/' + name + '.ts')));
  for (const [index, name] of ['wasi', 'program', 'program.worker'].entries()) {
    const row = receipt.consumerFiles[index], bytes = await readRegular(row.filename);
    equalPin(identity(bytes), row); equalPin(row, receipt.inputPins.find(pin => pin.filename === row.filename));
    assert.deepEqual(await readRegular(path.join(receipt.outputRoot, 'consumer', name + '.ts')), bytes);
    const generated = ts.transpileModule(bytes.toString(), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, reportDiagnostics: true });
    assert.deepEqual(generated.diagnostics, []); equalPin(identity(Buffer.from(generated.outputText)), row.generated);
    assert.deepEqual(await readRegular(path.join(receipt.outputRoot, 'consumer', name + '.js')), Buffer.from(generated.outputText));
  }
  const nodeConfig = JSON.parse(await readRegular(path.join(receipt.outputRoot, 'node-config.json')));
  assert.deepEqual(nodeConfig, { programModule: path.join(receipt.outputRoot, 'consumer/program.js'), resultFile: path.join(receipt.outputRoot, 'node.json'),
    cases: expectedCases.map(({ path: relative, ...row }) => ({ ...row, filename: path.join(receipt.outputRoot, relative) })) });
  for (const pin of receipt.inputPins) equalPin(await fileIdentity(pin.filename), pin);
  for (const pin of receipt.artifacts) equalPin(await fileIdentity(path.join(receipt.outputRoot, pin.path)), pin);
  assert.deepEqual(receipt.artifacts.map(row => row.path), (await regularFiles(receipt.outputRoot))
    .filter(filename => filename !== path.join(receipt.outputRoot, 'runtime-receipt.json')).map(filename => path.relative(receipt.outputRoot, filename)),
  'Complete produced artifact inventory required');
  const closure = JSON.parse(await readRegular(path.join(HERE, '../closure.lock.json')));
  assert.deepEqual(receipt.source, closure.source);
  for (const row of receipt.originals) {
    assert.equal(row.snapshot, 'official-source/' + path.basename(row.path));
    assert.equal(row.original.filename, path.join(receipt.sourceRoot, row.path));
    assert.deepEqual(row.original, receipt.inputPins.find(pin => pin.filename === row.original.filename));
    const bytes = verifyFile(await readRegular(path.join(receipt.outputRoot, row.snapshot)), closure.files.find(pin => pin.path === row.path));
    assert.deepEqual(bytes, await readRegular(row.original.filename)); equalPin(identity(bytes), row);
  }
  const compiler = receipt.compiler.artifacts.find(row => row.id === 'compiler').path;
  assert.deepEqual(receipt.classOrigins.map(row => row.fixture), fixtures.filter(row => !row.compileError).map(row => row.id));
  for (const origin of receipt.classOrigins) {
    const rows = [...ORIGINS.map(className => ({ className, filename: receipt.compiler.overlay.filename })),
      ...['org.jetbrains.kotlin.backend.wasm.WasmBackendContext', 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler'].map(className => ({ className, filename: compiler }))];
    assert.deepEqual(origin.rows, rows);
    const command = receipt.commands.find(row => row.phase === origin.fixture + '-pinned-overlay-binary');
    assert.deepEqual(command.command.slice(0, 8), [receipt.toolchain.java, '-Xmx768m', '-cp',
      receipt.compiler.overlay.filename + path.delimiter + bootstrap.classPath,
      'org.jetbrains.kotlin.portable.mainentry.runtime.RuntimeCompilerLauncherKt', receipt.compiler.overlay.filename, compiler, '-Xwasm-target=wasm-wasi']);
    const recorded = (await readRegular(path.join(receipt.outputRoot, command.stderr))).toString().split('\n')
      .filter(line => line.startsWith('OFFICIAL_MAIN_ORIGIN\t')).map(line => { const [, className, filename] = line.split('\t'); return { className, filename }; });
    assert.deepEqual(recorded, rows, 'Executed class origins must match the unmodified process output');
  }
  const node = JSON.parse(await readRegular(path.join(receipt.outputRoot, 'node.json'), 16 * 1024 * 1024));
  const browser = JSON.parse(await readRegular(path.join(receipt.outputRoot, 'chromium.json'), 16 * 1024 * 1024));
  const { results: browserResults, ...browserMetadata } = browser; assert.deepEqual(receipt.browser, browserMetadata);
  assert.deepEqual(receipt.node, { version: node.nodeVersion, v8: node.v8Version, resultFile: 'node.json' });
  assert.equal(node.results.length, receipt.cases.length); assert.equal(browser.results.length, receipt.cases.length);
  for (const [index, test] of receipt.cases.entries()) {
    const fixture = fixtures.find(row => row.id === test.fixtureId); assert(fixture);
    assert.equal(node.results[index].id, test.id); assert.equal(browser.results[index].id, test.id);
    assert.equal(node.results[index].fixtureId, test.fixtureId); assert.equal(node.results[index].variant, test.variant);
    const actual = node.results[index];
    assert.equal(actual.validModule, fixture.runtimeError !== 'duplicate-export');
    if (actual.validModule) {
      assert.equal(actual.validationError, null);
      assert(actual.imports.every(row => row.module === 'wasi_snapshot_preview1' && row.kind === 'function' &&
        ['fd_read', 'fd_write', 'poll_oneoff', 'random_get'].includes(row.name)));
      assert.equal(actual.exports.filter(row => row.name === '_start' && row.kind === 'function').length, fixture.runtimeError === 'missing-entry' ? 0 : 1);
    } else { assert.equal(actual.imports, null); assert.equal(actual.exports, null); assert.match(actual.validationError, /Duplicate export/i); }
    verifyRuntimeResult(fixture, node.results[index].result); verifyRuntimeResult(fixture, browser.results[index].result);
    assert.deepEqual(node.results[index].result, browser.results[index].result);
    if (test.variant === 'pinned-overlay') {
      const baseline = node.results.find(row => row.fixtureId === test.fixtureId && row.variant === 'bootstrap');
      assert.deepEqual(node.results[index].result, baseline.result);
      assert.deepEqual(node.results[index].imports, baseline.imports); assert.deepEqual(node.results[index].exports, baseline.exports);
    }
  }
  return { result: 'pass', cases: receipt.cases.length, fullSourceFiles: 2, artifacts: receipt.artifacts.length, inputs: receipt.inputPins.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--node-cases') await runNodeCases(process.argv[3]);
  else if (process.argv[2] === '--verify') console.log(JSON.stringify(await verifyMainRuntime(process.argv[3])));
  else {
    const result = await runMainRuntime(JSON.parse(await readRegular(process.argv[2])));
    console.log(JSON.stringify({ result: 'pass', receiptFile: result.receiptFile, cases: result.receipt.cases.length }));
  }
}
