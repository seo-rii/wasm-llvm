/** Complete tower-map source execution with explicit opaque and genuine JVM payloads. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { defaultCache, verifyBootstrap } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { normalizeImports } from '../klib-signature-index/transform.mjs';
import { TARGET, transformTowerModeMap } from './transform.mjs';
import { observeTowerInChromium } from './runtime-browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const execute = promisify(execFile);
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const equalIdentity = (actual, expected) => assert.deepEqual({ bytes: actual.bytes, sha256: actual.sha256 }, { bytes: expected.bytes, sha256: expected.sha256 });
const observerNames = ['runtime-probe.mjs', 'runtime-browser.mjs', 'RuntimeObservationProbe.kt', 'RuntimeOpaqueContext.kt',
  'RuntimeOpaqueScope.kt', 'RuntimePayloadProbe.kt', 'RuntimeJvmProbe.kt', 'RuntimeWasmProbe.kt', 'RuntimeActualJvmProbe.kt'];
const helperNames = ['transform.mjs', 'sources.lock.json', '../closure.lock.json', '../build-flags.json',
  '../klib-signature-index/transform.mjs', '../../scripts/source.mjs', '../../build/bootstrap.mjs',
  '../../build/bootstrap.lock.json', '../../manifest.json', '../../sources.lock.json'];
const observationFiles = ['original-observations.txt', 'common-observations.txt', 'node-wasm-observations.txt',
  'chromium-observations.txt', 'genuine-original-observations.txt', 'genuine-common-observations.txt'];
const coverage = 'coverage|states=768|transitions=4608|history=4608\n';
const expectedPhases = ['original-boundary-jvm-build', 'original-boundary-jvm-observe',
  'genuine-original-jvm-build', 'genuine-original-jvm-observe', 'common-boundary-jvm-build', 'common-boundary-jvm-observe',
  'genuine-common-jvm-build', 'genuine-common-jvm-observe', 'common-wasm-klib-build', 'common-wasm-module-build',
  'actual-node-wasm-observe', 'actual-offline-chromium-observe'];

function owner(filename) {
  assert(path.resolve(filename).startsWith(path.join(REPO, 'out') + path.sep), 'Observer output must stay in its repository out/');
}
async function fileIdentity(filename) {
  await assertNoSymlink(filename);
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    assert(info.isFile(), 'Expected regular input: ' + filename);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { bytes += chunk.length; hash.update(chunk); }
    assert.equal(bytes, info.size);
    return { bytes, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}
async function executable(name) {
  for (const directory of process.env.PATH.split(path.delimiter)) {
    const filename = path.resolve(directory, name);
    try { await access(filename, constants.X_OK); return await realpath(filename); } catch (error) { if (!['ENOENT', 'EACCES'].includes(error.code)) throw error; }
  }
  throw new Error('Required executable unavailable: ' + name);
}
async function regularFiles(root) {
  await assertNoSymlink(root);
  const result = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, item.name);
    assert(!item.isSymbolicLink(), 'No symlink input trees: ' + filename);
    if (item.isDirectory()) result.push(...await regularFiles(filename));
    else { assert(item.isFile()); result.push(filename); }
  }
  return result.sort();
}

export async function runTowerRuntime({ sourceRoot, baselineRoot, outputRoot, playwrightFrom, temporaryRoot, cacheRoot = defaultCache }) {
  sourceRoot = path.resolve(sourceRoot); baselineRoot = path.resolve(baselineRoot); outputRoot = path.resolve(outputRoot);
  temporaryRoot = path.resolve(temporaryRoot); owner(outputRoot);
  await assertNoSymlink(outputRoot); await assertNoSymlink(temporaryRoot);
  assert(!temporaryRoot.startsWith('/dev/shm/') && temporaryRoot.length < 55, 'Chromium requires a short actual disk temporary path');
  assert((await lstat(temporaryRoot)).isDirectory());
  await mkdir(path.dirname(outputRoot), { recursive: true, mode: 0o700 });
  await mkdir(outputRoot, { mode: 0o700 });
  const inputPins = [], artifacts = [], commands = [];
  const inputNames = new Set();
  async function pin(filename) {
    filename = path.resolve(filename);
    const row = { filename, ...await fileIdentity(filename) };
    if (inputNames.has(filename)) assert.deepEqual(inputPins.find(item => item.filename === filename), row);
    else { inputNames.add(filename); inputPins.push(row); }
    return row;
  }
  async function readPinned(filename) { const row = await pin(filename); const bytes = await readRegular(filename, 128 * 1024 * 1024); equalIdentity(identity(bytes), row); return bytes; }
  async function put(relative, bytes) {
    const filename = path.join(outputRoot, relative); owner(filename);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    artifacts.push({ path: relative, ...await fileIdentity(filename) });
    return filename;
  }
  async function run(phase, command, args) {
    const started = performance.now();
    try {
      const result = await execute(command, args, { cwd: outputRoot, timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
      await put('logs/' + phase + '.stdout', result.stdout);
      await put('logs/' + phase + '.stderr', result.stderr);
      commands.push({ phase, command: [command, ...args], exitCode: 0, elapsedMs: performance.now() - started });
      return result.stdout;
    } catch (error) {
      commands.push({ phase, command: [command, ...args], exitCode: error.code, elapsedMs: performance.now() - started });
      await put('logs/' + phase + '.stderr', String(error.stderr ?? ''));
      await writeJson(path.join(outputRoot, 'failure.json'), { result: 'fail', phase, inputPins, artifacts, commands, fullCompilerBuilt: false });
      throw new Error(phase + ' failed; inspect the completed stderr artifact');
    }
  }
  // Pin the exact helpers executed, locks, source input and bootstrap before compiling.
  for (const name of observerNames) await pin(path.join(HERE, name));
  for (const relative of helperNames) await pin(path.join(HERE, relative));
  const profile = JSON.parse(await readPinned(path.join(HERE, 'sources.lock.json')));
  const closureBytes = await readPinned(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
  assert.equal(profile.primaryClosureSha256, sha256(closureBytes));
  assert.deepEqual(profile.source, closure.source);
  const original = await readPinned(path.join(sourceRoot, TARGET));
  verifyFile(original, closure.files.find(row => row.path === TARGET));
  equalIdentity(identity(original), profile.incoming);
  const common = transformTowerModeMap(TARGET, original);
  equalIdentity(identity(common), profile.outgoing);
  assert.deepEqual(transformTowerModeMap(TARGET, common, { reverse: true }), original);
  const baselineBytes = await readPinned(path.join(baselineRoot, 'compiler-build-receipt.json')), baseline = JSON.parse(baselineBytes);
  assert.deepEqual(baseline.source, closure.source);
  const baselineRow = baseline.compileSources.find(row => row.path === TARGET); assert(baselineRow);
  const assembled = await readPinned(path.join(baselineRoot, 'sources', TARGET));
  equalIdentity(identity(assembled), baselineRow);
  assert.deepEqual(normalizeImports(assembled, profile.recordedPropertyImports), original);
  const originalFile = await put('original/FirRegularTowerDataContexts.kt', original);
  const commonFile = await put('common/FirRegularTowerDataContexts.kt', common);
  const flags = JSON.parse(await readPinned(path.join(HERE, '../build-flags.json')));
  const bootstrap = await verifyBootstrap(cacheRoot);
  for (const artifact of bootstrap.artifacts) equalIdentity((await pin(artifact.path)), artifact);
  const java = await executable('java'), node = await realpath(process.execPath);
  const javaRoot = path.resolve(java, '../..');
  for (const filename of [java, node, path.join(javaRoot, 'release'), path.join(javaRoot, 'lib/modules'), path.join(javaRoot, 'lib/server/libjvm.so')]) await pin(filename);
  const require = createRequire(path.resolve(playwrightFrom));
  const playwrightPackage = await realpath(require.resolve('playwright-core/package.json'));
  const { chromium } = require('playwright-core');
  for (const filename of await regularFiles(path.dirname(playwrightPackage))) await pin(filename);
  const chromiumExecutable = await realpath(chromium.executablePath());
  for (const filename of await regularFiles(path.dirname(chromiumExecutable))) await pin(filename);
  const stdlib = bootstrap.artifacts.find(row => row.id === 'stdlib-jvm').path;
  const compiler = bootstrap.artifacts.find(row => row.id === 'compiler').path;
  const jvm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
    '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', flags.languageVersion,
    '-api-version', flags.apiVersion, ...flags.compilerFlags];
  const observer = path.join(HERE, 'RuntimeObservationProbe.kt');
  const payloads = ['RuntimeOpaqueContext.kt', 'RuntimeOpaqueScope.kt', 'RuntimePayloadProbe.kt'].map(name => path.join(HERE, name));
  const observed = {};
  for (const [variant, target] of [['original', originalFile], ['common', commonFile]]) {
    const sources = [target, observer, ...payloads];
    const commonFlags = variant === 'common' ? ['-Xmulti-platform', '-Xcommon-sources=' + sources.join(',')] : [];
    const jar = path.join(outputRoot, variant, 'probe.jar');
    await run(variant + '-boundary-jvm-build', java, [...jvm, '-classpath', stdlib, ...commonFlags, '-d', jar, ...sources, path.join(HERE, 'RuntimeJvmProbe.kt')]);
    observed[variant] = await run(variant + '-boundary-jvm-observe', java, ['-ea', '-cp', jar + path.delimiter + stdlib,
      'org.jetbrains.kotlin.portable.towermap.probe.RuntimeJvmProbeKt']);
    await put(variant + '-observations.txt', observed[variant]);
    const genuineJar = path.join(outputRoot, variant, 'genuine.jar');
    await run('genuine-' + variant + '-jvm-build', java, [...jvm, '-Xfriend-paths=' + compiler, '-classpath', bootstrap.classPath,
      '-d', genuineJar, target, observer, path.join(HERE, 'RuntimeActualJvmProbe.kt')]);
    observed['genuine-' + variant] = await run('genuine-' + variant + '-jvm-observe', java, ['-ea', '-cp', genuineJar + path.delimiter + bootstrap.classPath,
      'org.jetbrains.kotlin.portable.towermap.probe.RuntimeActualJvmProbeKt', genuineJar, compiler]);
    await put('genuine-' + variant + '-observations.txt', observed['genuine-' + variant]);
    assert.equal(observed[variant], observed.original);
    assert.equal(observed['genuine-' + variant], observed.original, 'Genuine JVM and opaque payload identities differ');
  }
  await mkdir(path.join(outputRoot, 'klib')); await mkdir(path.join(outputRoot, 'wasm'));
  const wasmSources = [commonFile, observer, ...payloads];
  const wasm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler',
    '-Xwasm-target=wasm-js', '-libraries', bootstrap.wasmJsStdlib,
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
  await run('common-wasm-klib-build', java, [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + wasmSources.join(','), '-Xir-produce-klib-file',
    '-ir-output-dir', path.join(outputRoot, 'klib'), '-ir-output-name', 'tower-mode', ...wasmSources, path.join(HERE, 'RuntimeWasmProbe.kt')]);
  await run('common-wasm-module-build', java, [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/tower-mode.klib'),
    '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'tower-mode', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
  observed.node = await run('actual-node-wasm-observe', node, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const module=await import(process.argv[1]);process.stdout.write(module.towerModeObservation());', pathToFileURL(path.join(outputRoot, 'wasm/tower-mode.mjs')).href]);
  assert.equal(observed.node, observed.original);
  await put('node-wasm-observations.txt', observed.node);
  const browser = await observeTowerInChromium({ chromium, executablePath: chromiumExecutable, outputRoot, expected: observed.original, temporaryRoot });
  await put('chromium-observations.txt', browser.actual);
  delete browser.actual;
  commands.push({ phase: 'actual-offline-chromium-observe', ...browser.process });
  for (const row of inputPins) equalIdentity(await fileIdentity(row.filename), row);
  for (const relative of ['original/probe.jar', 'common/probe.jar', 'original/genuine.jar', 'common/genuine.jar', 'klib/tower-mode.klib',
    ...(await readdir(path.join(outputRoot, 'wasm'))).map(name => 'wasm/' + name)]) artifacts.push({ path: relative, ...await fileIdentity(path.join(outputRoot, relative)) });
  assert(observed.original.endsWith(coverage));
  const receipt = { schemaVersion: 1, kind: 'fir-private-tower-mode-map-runtime', result: 'pass', source: closure.source,
    outputRoot, sourceRoot, baselineRoot, cacheRoot, inputsUnchanged: true, inputPins, artifacts, commands, browser,
    completeTargets: { original: { path: 'original/FirRegularTowerDataContexts.kt', ...identity(original) },
      common: { path: 'common/FirRegularTowerDataContexts.kt', ...identity(common) }, methodBodiesRewritten: false, targetFileTruncated: false },
    bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null, artifacts: bootstrap.artifacts },
    toolchain: { java, node, playwrightPackage, chromiumExecutable },
    comparison: { files: observationFiles, rawOutputNormalization: false, allRawBytesEqual: true,
      observations: observed.original.trimEnd().split('\n').length, states: 768, transitions: 4608, historySteps: 4608, ...identity(Buffer.from(observed.original)) },
    genuineJvm: { variants: ['original', 'common'], objects: ['FirTowerDataContext', 'FirLocalScope', 'FirSession'],
      payloadClassesSupplied: false, compiledTargetOriginAsserted: true, compilerObjectOriginsAsserted: true,
      realLocalScopeEmbeddedInContext: true, sessionUse: 'Minimal genuine session subclass only constructs real local scopes; no resolution invoked.' },
    limits: ['Boundary JVM/Node/Chromium runs use two explicitly opaque identity carriers, not FIR implementations.',
      'The complete target file executes unchanged apart from the private map transformation; no target methods are projected or replaced.',
      'Genuine JVM runs use compiler-artifact FIR objects and compare the same complete target source and observer.',
      'Runtime demonstrates persistence and identity; private structural map sharing is protected separately by exact source inversion.',
      'No FIR resolution, full compiler pipeline, or public Kotlin language support is established.'],
    fullFirToIrExecuted: false, fullCompilerBuilt: false, publicLanguageSupport: false };
  const receiptFile = path.join(outputRoot, 'runtime-receipt.json');
  await writeJson(receiptFile, receipt);
  await verifyTowerRuntime(receiptFile);
  return { receiptFile, receipt };
}

/** Reopen completed evidence without running Java, Node Wasm or a browser. */
export async function verifyTowerRuntime(receiptFile) {
  receiptFile = path.resolve(receiptFile);
  const receipt = JSON.parse(await readRegular(receiptFile, 32 * 1024 * 1024));
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.kind, 'fir-private-tower-mode-map-runtime');
  assert.equal(receipt.result, 'pass');
  assert.equal(receipt.inputsUnchanged, true);
  assert.equal(receipt.fullCompilerBuilt, false);
  assert.equal(receipt.fullFirToIrExecuted, false);
  assert.equal(receipt.publicLanguageSupport, false);
  const root = path.dirname(receiptFile);
  assert.equal(receipt.outputRoot, root);
  owner(root);
  const inputs = new Set(), artifacts = new Set();
  for (const pin of receipt.inputPins) {
    assert.equal(path.resolve(pin.filename), pin.filename);
    assert(!inputs.has(pin.filename)); inputs.add(pin.filename);
    equalIdentity(await fileIdentity(pin.filename), pin);
  }
  for (const name of [...observerNames, ...helperNames]) assert(inputs.has(path.join(HERE, name)), 'Missing executed source/helper pin: ' + name);
  for (const filename of [path.join(receipt.sourceRoot, TARGET), path.join(receipt.baselineRoot, 'compiler-build-receipt.json'),
    path.join(receipt.baselineRoot, 'sources', TARGET)]) assert(inputs.has(filename), 'Missing source/baseline input pin');
  for (const pin of receipt.artifacts) {
    assert.equal(path.posix.normalize(pin.path), pin.path);
    assert(!path.isAbsolute(pin.path) && !pin.path.startsWith('../') && !artifacts.has(pin.path));
    artifacts.add(pin.path);
    equalIdentity(await fileIdentity(path.join(root, pin.path)), pin);
  }
  assert.deepEqual((await regularFiles(root)).filter(filename => filename !== receiptFile).map(filename => path.relative(root, filename)).sort(), [...artifacts].sort());
  assert.deepEqual(receipt.commands.map(row => row.phase), expectedPhases);
  for (const command of receipt.commands) {
    assert.equal(command.exitCode, 0, 'Runtime phase did not succeed: ' + command.phase);
    assert(Array.isArray(command.command) && command.command.length > 1);
    assert(inputs.has(command.command[0]), 'Invoked executable was not pinned');
  }
  for (const filename of Object.values(receipt.toolchain)) assert(inputs.has(filename));
  for (const pin of receipt.bootstrap.artifacts) {
    assert(inputs.has(pin.path));
    equalIdentity(receipt.inputPins.find(row => row.filename === pin.path), pin);
  }
  assert.equal(receipt.bootstrap.compilerSourceCommit, null);
  const original = await readRegular(path.join(root, receipt.completeTargets.original.path));
  const common = await readRegular(path.join(root, receipt.completeTargets.common.path));
  equalIdentity(identity(original), receipt.completeTargets.original);
  equalIdentity(identity(common), receipt.completeTargets.common);
  assert.deepEqual(transformTowerModeMap(TARGET, original), common);
  assert.deepEqual(transformTowerModeMap(TARGET, common, { reverse: true }), original);
  assert.equal(receipt.completeTargets.methodBodiesRewritten, false);
  assert.equal(receipt.completeTargets.targetFileTruncated, false);
  const closure = JSON.parse(await readRegular(path.join(HERE, '../closure.lock.json'), 32 * 1024 * 1024));
  assert.deepEqual(receipt.source, closure.source);
  verifyFile(original, closure.files.find(row => row.path === TARGET));
  const sourceLock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json'), 32 * 1024 * 1024));
  equalIdentity(identity(original), sourceLock.incoming);
  equalIdentity(identity(common), sourceLock.outgoing);
  assert.deepEqual(await readRegular(path.join(receipt.sourceRoot, TARGET)), original);
  const baseline = JSON.parse(await readRegular(path.join(receipt.baselineRoot, 'compiler-build-receipt.json'), 128 * 1024 * 1024));
  assert.deepEqual(baseline.source, receipt.source);
  const assembled = await readRegular(path.join(receipt.baselineRoot, 'sources', TARGET));
  equalIdentity(identity(assembled), baseline.compileSources.find(row => row.path === TARGET));
  assert.deepEqual(normalizeImports(assembled, sourceLock.recordedPropertyImports), original);
  assert.deepEqual(receipt.comparison.files, observationFiles);
  const reference = await readRegular(path.join(root, observationFiles[0]), 32 * 1024 * 1024);
  for (const name of observationFiles) {
    assert(artifacts.has(name));
    assert.deepEqual(await readRegular(path.join(root, name), 32 * 1024 * 1024), reference, 'Raw observation bytes differ: ' + name);
  }
  equalIdentity(identity(reference), receipt.comparison);
  assert.equal(receipt.comparison.rawOutputNormalization, false);
  assert.equal(receipt.comparison.allRawBytesEqual, true);
  assert.equal(receipt.comparison.states, 768);
  assert.equal(receipt.comparison.transitions, 4608);
  assert.equal(receipt.comparison.historySteps, 4608);
  assert(reference.toString().endsWith(coverage));
  assert.equal(reference.toString().trimEnd().split('\n').length, 19970);
  assert.equal(receipt.comparison.observations, 19970);
  assert.deepEqual(receipt.genuineJvm.variants, ['original', 'common']);
  assert.equal(receipt.genuineJvm.payloadClassesSupplied, false);
  for (const key of ['compiledTargetOriginAsserted', 'compilerObjectOriginsAsserted', 'realLocalScopeEmbeddedInContext']) assert.equal(receipt.genuineJvm[key], true);
  assert.equal(receipt.browser.engine, 'Chromium');
  assert.equal(receipt.browser.moduleWorker, true);
  assert.equal(receipt.browser.offlineAfterInitialization, true);
  assert.equal(receipt.browser.executablePath, receipt.toolchain.chromiumExecutable);
  assert.equal(receipt.browser.process.exitCode, 0);
  assert.equal(receipt.browser.process.signal, null);
  assert.deepEqual(receipt.commands.at(-1).command, receipt.browser.process.command);
  assert.deepEqual(receipt.browser.externalRequests, []);
  assert.deepEqual(receipt.browser.offlineRequests, []);
  assert(receipt.browser.assetRequests.includes('tower-mode.wasm'));
  return { result: 'pass', receipt, receiptFile, inputsVerified: inputs.size, artifactsVerified: artifacts.size,
    comparison: receipt.comparison, fullCompilerBuilt: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--verify') {
    assert.equal(process.argv.length, 4);
    const result = await verifyTowerRuntime(process.argv[3]);
    console.log(JSON.stringify({ result: result.result, inputsVerified: result.inputsVerified, artifactsVerified: result.artifactsVerified, comparison: result.comparison }));
  } else {
    const [sourceRoot, baselineRoot, outputRoot, playwrightFrom, temporaryRoot] = process.argv.slice(2);
    assert.equal(process.argv.length, 7, 'Usage: runtime-probe.mjs SOURCE_ROOT BASELINE_ROOT FRESH_OUTPUT_ROOT PLAYWRIGHT_PACKAGE_JSON SHORT_DISK_TMPDIR');
    const result = await runTowerRuntime({ sourceRoot, baselineRoot, outputRoot, playwrightFrom, temporaryRoot });
    console.log(JSON.stringify({ result: result.receipt.result, receiptFile: result.receiptFile, comparison: result.receipt.comparison, genuineJvm: result.receipt.genuineJvm, fullCompilerBuilt: false }));
  }
}
