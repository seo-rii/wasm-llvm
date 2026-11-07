/** Genuine JVM source agreement plus bounded common JVM / Node Wasm / Chromium observations. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { balancedSpan } from '../fir-navigation/transform.mjs';
import { normalizeImports } from '../klib-signature-index/transform.mjs';
import { TARGETS, CONVERTER, HOST, LINES, transformPsiViews } from './transform.mjs';
import { projectPsiViews, genuineConverterKernel, commentHelpers } from './runtime-projection.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const execute = promisify(execFile);
const IR_ENTRY = 'compiler/ir/ir.tree/src/org/jetbrains/kotlin/ir/IrFileEntry.kt';
const ADDITIONAL_IR = 'compiler/ir/ir.tree/src/org/jetbrains/kotlin/ir/util/AdditionalIrUtils.kt';
const TREE_UTILS = 'compiler/frontend.common/src/org/jetbrains/kotlin/util/LightTreeUtils.kt';
const relocate = text => text.replaceAll(/\bcom\.intellij\.(?!platform\.syntax\b)/g, 'org.jetbrains.kotlin.com.intellij.');
const owner = filename => assert(path.resolve(filename).startsWith(path.join(REPO, 'out/fir-psi-next') + path.sep), 'Fresh observer output must stay in its assigned worktree');
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const observerNames = ['runtime-probe.mjs', 'runtime-projection.mjs', 'RuntimePayloadProbe.kt.in',
  'RuntimeObservationProbe.kt', 'RuntimeActualJvmProbe.kt', 'RuntimeJvmProbe.kt', 'RuntimeWasmProbe.kt'];

async function browserObservation(outputRoot, expected, playwrightFrom) {
  const { chromium } = createRequire(path.resolve(playwrightFrom))('playwright-core');
  const assets = new Map();
  for (const name of await readdir(path.join(outputRoot, 'wasm')))
    assets.set(name, await readRegular(path.join(outputRoot, 'wasm', name)));
  const origin = 'https://kotlin-psi-observer.invalid';
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const externalRequests = [], assetRequests = [], offlineRequests = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin && url.pathname === '/')
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>PSI view boundary</title>' });
      const name = url.pathname.slice(1);
      if (url.origin === origin && assets.has(name)) {
        assetRequests.push(name);
        return route.fulfill({ contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: assets.get(name) });
      }
      externalRequests.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage(); await page.goto(origin);
    await page.evaluate(async url => {
      const source = 'import * as module from ' + JSON.stringify(url) + '; ' +
        'onmessage=()=>{try{postMessage({value:module.psiViewsObservation()})}catch(error){postMessage({error:String(error)})}};postMessage({ready:true});';
      const blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const worker = new Worker(blob, { type: 'module' }); window.psiObserver = worker;
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { worker.terminate(); reject(new Error('Worker initialization deadline')); }, 30000);
          worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
          worker.onmessage = ({ data }) => { clearTimeout(timer); data.ready ? resolve() : reject(new Error(data.error)); };
        });
      } finally { URL.revokeObjectURL(blob); }
    }, origin + '/psi-views.mjs');
    await context.setOffline(true);
    context.on('request', request => offlineRequests.push(request.url()));
    const actual = await page.evaluate(() => new Promise((resolve, reject) => {
      const worker = window.psiObserver;
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('Worker observation deadline')); }, 30000);
      worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); data.error ? reject(new Error(data.error)) : resolve(data.value); };
      worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
      worker.postMessage({ observe: true });
    }));
    assert.equal(actual, expected, 'Original JVM/offline Chromium boundary observations differ');
    assert.deepEqual(externalRequests, []); assert.deepEqual(offlineRequests, []);
    return { engine: 'Chromium', version: browser.version(), moduleWorker: true, offlineAfterInitialization: true,
      assetRequests, externalRequests, offlineRequests, observations: actual.trimEnd().split('\n').length, ...identity(Buffer.from(actual)) };
  } finally { await browser.close(); }
}

export async function runPsiViewsRuntime({ sourceRoot, baselineRoot, outputRoot, playwrightFrom, prepareOnly = false }) {
  sourceRoot = path.resolve(sourceRoot); baselineRoot = path.resolve(baselineRoot); outputRoot = path.resolve(outputRoot);
  owner(outputRoot);
  await mkdir(path.dirname(outputRoot), { recursive: true });
  await mkdir(outputRoot, { mode: 0o700 }); // Existing output is intentionally never overwritten.
  const inputPins = [], artifacts = [], commands = [], projections = [];
  async function pinned(filename, expected) {
    const bytes = await readRegular(filename, 96 * 1024 * 1024);
    if (expected?.gitBlob) verifyFile(bytes, expected);
    else if (expected) assert.deepEqual(identity(bytes), { bytes: expected.bytes, sha256: expected.sha256 }, 'Pinned observer input differs: ' + filename);
    const pin = { filename, ...identity(bytes) };
    const old = inputPins.find(item => item.filename === filename);
    if (old) assert.deepEqual(old, pin); else inputPins.push(pin);
    return bytes;
  }
  async function put(relative, bytes) {
    const filename = path.join(outputRoot, relative); owner(filename);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    artifacts.push({ path: relative, ...identity(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)) });
    return filename;
  }
  async function run(phase, command, args) {
    const started = performance.now();
    try {
      const result = await execute(command, args, { cwd: outputRoot, timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
      commands.push({ phase, command: [command, ...args], exitCode: 0, elapsedMs: performance.now() - started });
      if (result.stderr) await put('logs/' + phase + '.stderr', result.stderr);
      return result.stdout;
    } catch (error) {
      commands.push({ phase, command: [command, ...args], exitCode: error.code, elapsedMs: performance.now() - started });
      await put('logs/' + phase + '.stderr', String(error.stderr ?? ''));
      await writeJson(path.join(outputRoot, 'failure.json'), { phase, commands, inputPins,
        stderrFile: 'logs/' + phase + '.stderr', fullCompilerBuilt: false });
      throw new Error(phase + ' failed; inspect the completed phase stderr file');
    }
  }
  const closure = JSON.parse(await pinned(path.join(REPO, 'producer/kotlin-browser/compiler-port/closure.lock.json')));
  const profile = JSON.parse(await pinned(path.join(HERE, 'sources.lock.json')));
  const selection = JSON.parse(await pinned(path.join(HERE, 'selection.lock.json'), profile.selection));
  const baselineBytes = await pinned(path.join(baselineRoot, 'compiler-build-receipt.json'));
  assert.deepEqual(identity(baselineBytes), selection.actualBuildReceipt);
  const baseline = JSON.parse(baselineBytes);
  assert.equal(baseline.source.commit, closure.source.commit);
  const argsBytes = await pinned(path.join(baselineRoot, 'compiler-klib.args'));
  assert.deepEqual(identity(argsBytes), selection.actualArguments);
  const phase = baseline.commands.find(item => item.phase === 'official-compiler-source-to-wasmjs-klib');
  assert.equal(sha256(argsBytes), phase.argumentFileSha256);
  const args = argsBytes.toString().trimEnd().split('\n').map(line => JSON.parse(line));
  const selected = args.slice(-baseline.compileSources.length).map((filename, index) => ({ filename, ...baseline.compileSources[index] }));
  assert.equal(selected.length, 3571);
  assert.deepEqual(selected.map(({ filename, ...row }) => ({ ...row, ownerRelative: path.relative(baselineRoot, filename), compile: true })),
    selection.rows.map(({ path, bytes, sha256, ownerRelative, compile }) => ({ path, bytes, sha256, ownerRelative, compile })));
  const find = suffix => {
    const rows = selected.filter(row => row.filename.endsWith(suffix));
    assert.equal(rows.length, 1, 'Expected one selected helper: ' + suffix);
    return rows[0];
  };
  const selectedText = async suffix => {
    const row = find(suffix); return (await pinned(row.filename, row)).toString();
  };
  const original = new Map(), current = new Map(), after = new Map(), originalFiles = [];
  for (const logical of TARGETS) {
    const pin = closure.files.find(row => row.path === logical); assert(pin);
    const bytes = await pinned(path.join(sourceRoot, logical), pin);
    original.set(logical, bytes.toString());
    originalFiles.push(await put('actual-original/' + logical, relocate(bytes.toString())));
    const before = Buffer.from(await selectedText('/' + logical));
    const portable = transformPsiViews(logical, before);
    assert.deepEqual(transformPsiViews(logical, portable, { reverse: true }), before);
    current.set(logical, before.toString()); after.set(logical, portable.toString());
  }
  const deassemble = text => normalizeImports(Buffer.from(text), profile.recordedPropertyImports).toString();
  const canonical = async logical => {
    const pin = closure.files.find(row => row.path === logical); assert(pin, 'Missing original source pin: ' + logical);
    return (await pinned(path.join(sourceRoot, logical), pin)).toString();
  };
  const helperSources = {
    originalLines: relocate(await canonical(LINES)),
    portableLines: deassemble(await selectedText('/components/sourceHostReceipt/' + LINES)),
    originalIr: await canonical(IR_ENTRY),
    portableIr: deassemble(await selectedText('/components/irFileLineSearchReceipt/' + IR_ENTRY)),
    originalTree: relocate(await canonical(TREE_UTILS)),
    portableTree: deassemble(await selectedText('/components/positioningReceipt/compiler-port-positioning/LightTreeUtils.kt')),
    comments: deassemble(await selectedText('/components/positioningReceipt/compiler-port-positioning/LightTreePositioningStrategy.kt')),
    host: deassemble(await selectedText('/components/sourceHostReceipt/compiler-port-host/PortableLightTree.kt')),
    tokens: deassemble(await selectedText('/components/firNavigationReceipt/compiler-port-positioning/TokenSet.kt')),
  };
  current.set(HOST, await canonical(HOST));
  for (const binding of profile.portableBindings) {
    const bytes = Buffer.from(deassemble(await selectedText('/' + binding.path)));
    assert.deepEqual(identity(bytes), { bytes: binding.bytes, sha256: binding.sha256 });
    const receipt = JSON.parse(await pinned(path.join(baselineRoot, binding.receiptRelative)));
    assert.equal(receipt.sourceLockSha256, binding.sourceLockSha256);
    const row = receipt[binding.outputField].find(item => item.path === binding.path); assert(row);
    assert.deepEqual(identity(bytes), { bytes: row.bytes, sha256: row.sha256 });
  }
  const additional = await canonical(ADDITIONAL_IR);
  const naiveClass = balancedSpan(additional, 'class NaiveSourceBasedFileEntryImpl(').text;
  const naive = 'package org.jetbrains.kotlin.ir.util\nimport org.jetbrains.kotlin.ir.*\n' +
    'const val SYNTHETIC_OFFSET = -2\n' + naiveClass;
  assert(additional.includes('const val SYNTHETIC_OFFSET = -2'));
  projections.push({ logical: ADDITIONAL_IR, exactClassBody: identity(Buffer.from(naiveClass)), bodyRewritten: false });
  const template = (await pinned(path.join(HERE, 'RuntimePayloadProbe.kt.in'))).toString();
  for (const name of observerNames) await pinned(path.join(HERE, name));
  await pinned(path.join(HERE, 'transform.mjs'));
  await pinned(path.join(HERE, '../fir-navigation/transform.mjs'));
  await pinned(path.join(HERE, '../klib-signature-index/transform.mjs'));
  const bootstrap = await verifyBootstrap();
  const flagsBytes = await pinned(path.join(HERE, '../build-flags.json')), flags = JSON.parse(flagsBytes);
  const stdlib = bootstrap.artifacts.find(row => row.id === 'stdlib-jvm').path;
  const compilerArtifact = bootstrap.artifacts.find(row => row.file.startsWith('kotlin-compiler-embeddable-'));
  assert(compilerArtifact);
  const originalFriend = ['-Xfriend-paths=' + compilerArtifact.path];
  const jvm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
    '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', flags.languageVersion,
    '-api-version', flags.apiVersion, ...flags.compilerFlags];
  if (!prepareOnly) await run('five-complete-original-source-jvm-typecheck', 'java', [...jvm, ...originalFriend, '-classpath', bootstrap.classPath,
    '-d', path.join(outputRoot, 'full-original.jar'), ...originalFiles]);
  const kernel = await put('actual-original/FileEntryKernel.kt', genuineConverterKernel(original.get(CONVERTER)));
  const observed = {};
  for (const variant of ['original', 'common']) {
    const portable = variant === 'common';
    const projected = projectPsiViews(portable ? after : current, portable);
    projections.push({ variant, ...projected, bytes: undefined, output: identity(projected.bytes) });
    const sourceFiles = [await put(variant + '/PsiBoundaries.kt', projected.bytes)];
    const carrierImports = portable ? 'import org.jetbrains.kotlin.portable.source.*' : [
      'import org.jetbrains.kotlin.com.intellij.lang.LighterASTNode',
      'import org.jetbrains.kotlin.com.intellij.openapi.util.Ref',
      'import org.jetbrains.kotlin.com.intellij.psi.tree.IElementType',
      'import org.jetbrains.kotlin.com.intellij.util.diff.FlyweightCapableTreeStructure',
    ].join('\n');
    const nodeMembers = portable
      ? '    override val tokenType: IElementType get() = token\n    override val startOffset: Int get() = start\n    override val endOffset: Int get() = end'
      : '    override fun getTokenType(): IElementType = token\n    override fun getStartOffset(): Int = start\n    override fun getEndOffset(): Int = end';
    const payload = template.replace('@CARRIER_IMPORTS@', carrierImports).replace('@NODE_MEMBERS@', nodeMembers).replace('@NULLABLE@', portable ? '' : '?');
    sourceFiles.push(await put(variant + '/Payload.kt', payload));
    const comment = commentHelpers(helperSources.comments, portable);
    projections.push({ variant, helper: 'pinned existing LightTree comment/filler bodies', spans: comment.spans });
    sourceFiles.push(await put(variant + '/CommentHelpers.kt', comment.bytes));
    sourceFiles.push(await put(variant + '/IrFileEntry.kt', portable ? helperSources.portableIr : helperSources.originalIr));
    sourceFiles.push(await put(variant + '/NaiveSourceBasedFileEntryImpl.kt', naive));
    sourceFiles.push(await put(variant + '/SourceLines.kt', portable ? helperSources.portableLines : helperSources.originalLines));
    sourceFiles.push(await put(variant + '/LightTreeUtils.kt', portable ? helperSources.portableTree : helperSources.originalTree));
    sourceFiles.push(await put(variant + '/Observation.kt', await pinned(path.join(HERE, 'RuntimeObservationProbe.kt'))));
    if (portable) {
      sourceFiles.push(await put(variant + '/PortableLightTree.kt', helperSources.host));
      sourceFiles.push(await put(variant + '/TokenSet.kt', helperSources.tokens));
      for (const name of ['KtTokens.kt', 'KtNodeTypes.kt', 'KtStubBasedElementTypes.kt', 'LegacyTokens.kt', 'LegacyNodeType.kt', 'KDocTokens.kt'])
        sourceFiles.push(await put(variant + '/' + name, deassemble(await selectedText('/components/positioningReceipt/compiler-port-positioning/' + name))));
    }
    if (prepareOnly) continue;
    const jar = path.join(outputRoot, variant + '/probe.jar');
    const commonFlags = portable ? ['-Xmulti-platform', '-Xcommon-sources=' + sourceFiles.join(',')] : [];
    await run(variant + '-boundary-jvm-build', 'java', [...jvm, ...(portable ? [] : originalFriend), '-classpath', portable ? stdlib : bootstrap.classPath,
      ...commonFlags, '-d', jar, ...sourceFiles, path.join(HERE, 'RuntimeJvmProbe.kt')]);
    observed[variant] = await run(variant + '-boundary-jvm-observe', 'java',
      ['-ea', '-cp', jar + path.delimiter + (portable ? stdlib : bootstrap.classPath), 'org.jetbrains.kotlin.portable.psiviews.probe.RuntimeJvmProbeKt']);
    await put(variant + '-observations.txt', observed[variant]);
    if (!portable) {
      const jar = path.join(outputRoot, 'genuine-agreement.jar');
      await run('genuine-fir-source-agreement-jvm-build', 'java', [...jvm, ...originalFriend, '-classpath', bootstrap.classPath, '-d', jar,
        ...originalFiles, ...sourceFiles, kernel, path.join(HERE, 'RuntimeActualJvmProbe.kt')]);
      observed.genuine = await run('genuine-fir-source-agreement-jvm-observe', 'java',
        ['-ea', '-cp', jar + path.delimiter + bootstrap.classPath, 'org.jetbrains.kotlin.portable.psiviews.probe.RuntimeActualJvmProbeKt']);
      await put('genuine-agreement-observations.txt', observed.genuine);
    } else {
      assert.equal(observed.common, observed.original, 'Original/common JVM observations differ');
      await mkdir(path.join(outputRoot, 'klib')); await mkdir(path.join(outputRoot, 'wasm'));
      const wasm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler',
        '-Xwasm-target=wasm-js', '-libraries', bootstrap.wasmJsStdlib,
        '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
      await run('common-boundary-wasmjs-klib-build', 'java', [...wasm, ...commonFlags, '-Xir-produce-klib-file',
        '-ir-output-dir', path.join(outputRoot, 'klib'), '-ir-output-name', 'psi-views',
        ...sourceFiles, path.join(HERE, 'RuntimeWasmProbe.kt')]);
      await run('common-boundary-wasmjs-module-build', 'java', [...wasm, '-Xir-produce-js',
        '-Xinclude=' + path.join(outputRoot, 'klib/psi-views.klib'), '-ir-output-dir', path.join(outputRoot, 'wasm'),
        '-ir-output-name', 'psi-views', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
      observed.wasm = await run('actual-node-wasmjs-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module',
        '-e', 'const module=await import(process.argv[1]);process.stdout.write(module.psiViewsObservation());',
        pathToFileURL(path.join(outputRoot, 'wasm/psi-views.mjs')).href]);
      assert.equal(observed.wasm, observed.original, 'Original JVM/actual Node Wasm observations differ');
      await put('wasm-observations.txt', observed.wasm);
    }
  }
  if (prepareOnly) {
    const receipt = { result: 'prepared', inputPins, artifacts, projections, commands,
      runtimeExecuted: false, fullFirToIrExecuted: false, fullCompilerBuilt: false };
    await writeJson(path.join(outputRoot, 'preparation-receipt.json'), receipt);
    return { outputRoot, receipt };
  }
  const browser = await browserObservation(outputRoot, observed.original, playwrightFrom);
  for (const pin of inputPins) assert.deepEqual(identity(await readRegular(pin.filename, 96 * 1024 * 1024)), { bytes: pin.bytes, sha256: pin.sha256 }, 'Observer input changed while running: ' + pin.filename);
  for (const relative of ['full-original.jar', 'original/probe.jar', 'common/probe.jar', 'genuine-agreement.jar', 'klib/psi-views.klib',
    ...(await readdir(path.join(outputRoot, 'wasm'))).sort().map(name => 'wasm/' + name)])
    artifacts.push({ path: relative, ...identity(await readRegular(path.join(outputRoot, relative))) });
  const receipt = { schemaVersion: 1, kind: 'fir-lighttree-null-psi-view-method-boundary-runtime', result: 'pass',
    source: closure.source, inputsUnchanged: true, inputPins, projections, commands, artifacts, browser,
    bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null,
      originalJvmFriendArtifact: compilerArtifact.id,
      originalJvmFriendReason: 'Complete compiler source files reference internal declarations of their compiler module; friend access does not rewrite source bodies.',
      artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    comparison: { observations: observed.original.trimEnd().split('\n').length, originalJvmSha256: sha256(Buffer.from(observed.original)),
      commonJvmSha256: sha256(Buffer.from(observed.common)), actualNodeWasmSha256: sha256(Buffer.from(observed.wasm)),
      rawOutputNormalization: false, originalJvmEqualsCommonJvm: true, originalJvmEqualsActualNodeWasm: true, originalJvmEqualsChromium: true },
    genuineOriginalAgreement: { observations: observed.genuine.trimEnd().split('\n').length, sha256: sha256(Buffer.from(observed.genuine)),
      objects: ['KtLightSourceElement', 'FirImport', 'FirLiteralExpression', 'FirSimpleNamedReference', 'FirProperty', 'FirField',
        'FirDefaultPropertyGetter', 'FirFile', 'FirMetadataSource.Property', 'FirMetadataSource.Field'],
      conversionCallback: 'Nothing-returning callback throws an identity-checked marker; no fake IR implementation.' },
    limits: ['Source/FIR payloads are explicit, non-shipping method-boundary carriers; no PSI class implementation is supplied.',
      'The original PSI branch of the generic source-offset dispatch is excluded only for the LightTree payload projection, then compared with genuine original JVM objects.',
      'Getter evaluation counts and failure identities use instrumentation payloads, not subclassed FIR or PSI implementations.',
      'The exact file-entry expression executes; full Fir2IrConverter registration and full FIR-to-IR lowering do not execute.',
      'The complete original five files typecheck on JVM; common Wasm executes only the attested method and helper boundaries.'],
    fullFirToIrExecuted: false, fullCompilerBuilt: false, publicLanguageSupport: false };
  await writeJson(path.join(outputRoot, 'runtime-receipt.json'), receipt);
  return { outputRoot, receipt };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sourceRoot, baselineRoot, outputRoot, playwrightFrom, mode] = process.argv.slice(2);
  assert(mode === undefined || mode === '--prepare-only');
  assert(sourceRoot && baselineRoot && outputRoot && playwrightFrom,
    'Usage: runtime-probe.mjs SOURCE_ROOT BASELINE_ROOT FRESH_OUTPUT_ROOT PLAYWRIGHT_PACKAGE_JSON');
  const result = await runPsiViewsRuntime({ sourceRoot, baselineRoot, outputRoot, playwrightFrom, prepareOnly: mode === '--prepare-only' });
  console.log(JSON.stringify({ outputRoot, result: result.receipt.result, comparison: result.receipt.comparison,
    genuineOriginalAgreement: result.receipt.genuineOriginalAgreement, fullFirToIrExecuted: false }));
}
