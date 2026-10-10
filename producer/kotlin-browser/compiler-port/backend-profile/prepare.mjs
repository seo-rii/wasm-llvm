#!/usr/bin/env node
/** Whole-rebuild source profile; no lowering implementation is rewritten. */
import assert from 'node:assert/strict';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { CANDIDATE_FILES, SPLITS, generateBackendSplit } from './generate.mjs';
import { chooseExclusions, selectedDeclarations, selectedFileGraph } from './references.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = { repository: 'https://github.com/JetBrains/kotlin.git', commit: '4d78aae1e337cd40f69baa865aed950fe807a775', treeSha: '2be662d1ae06bfcf435efbe18191ba5e1e3f035e' };
const SELECTED = [...CANDIDATE_FILES, ...SPLITS.map(rule => rule.path)];
const WASM_PHASES = 'compiler/ir/backend.wasm/src/org/jetbrains/kotlin/backend/wasm/WasmLoweringPhases.kt';
const DRIVER = 'compiler-port-backend/OfficialWasmDriver.kt';

function identity(bytes) { return { bytes: bytes.length, sha256: sha256(bytes) }; }
function logicalSelectedPath(filename) { return SELECTED.find(selected => filename.endsWith(path.sep + selected.split('/').join(path.sep))); }
function checkedSelection(result, label) {
  if (result.promoted.length || result.unclosed.length) {
    const error = new Error('Backend profile has retained references in ' + label + ': ' + JSON.stringify([...result.promoted, ...result.unclosed].slice(0, 8)));
    error.name = 'UnclosedBackendProfileError'; error.report = { promoted: result.promoted, unclosed: result.unclosed }; throw error;
  }
  assert.deepEqual(result.excluded, [...CANDIDATE_FILES].sort());
}

async function loadInputs(sourceRoot) {
  sourceRoot = path.resolve(sourceRoot); await assertNoSymlink(sourceRoot);
  const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
  assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'official-wasm-whole-rebuild-source-profile');
  assert.deepEqual(lock.source, SOURCE); assert.equal(lock.languageReadiness, false);
  assert.deepEqual(lock.exclusionCandidates.map(pin => pin.path), CANDIDATE_FILES);
  assert.deepEqual(lock.splits.map(pin => pin.path), SPLITS.map(rule => rule.path));
  assert.equal(sha256(await readRegular(path.join(HERE, 'generate.mjs'))), lock.generatorSha256);
  assert.equal(sha256(await readRegular(path.join(HERE, 'references.mjs'))), lock.referenceReaderSha256);
  const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')); const closure = JSON.parse(closureBytes);
  assert.equal(sha256(closureBytes), lock.primaryClosureSha256); assert.deepEqual(closure.source, SOURCE);
  const pins = closure.files.filter(pin => pin.compile && pin.path.endsWith('.kt'));
  assert.equal(pins.length, lock.primaryKotlinSources); assert(pins.length <= 8192);
  const originals = new Map(); let totalBytes = 0;
  for (let offset = 0; offset < pins.length; offset += 24) {
    const batch = await Promise.allSettled(pins.slice(offset, offset + 24).map(async pin => {
      relativePath(pin.path); return [pin.path, verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin)];
    }));
    for (const result of batch) {
      if (result.status !== 'fulfilled') throw result.reason;
      const [filename, bytes] = result.value; assert(!originals.has(filename)); originals.set(filename, bytes); totalBytes += bytes.length;
    }
  }
  assert(totalBytes <= 64 * 1024 * 1024);
  const candidates = new Map(), splits = new Map(), generated = [];
  for (const pin of lock.exclusionCandidates) {
    const bytes = verifyFile(originals.get(pin.path), pin); const text = bytes.toString('utf8'); const declarations = selectedDeclarations(text);
    assert.deepEqual(declarations, pin.declarations, 'Selected IC declaration inventory changed'); candidates.set(pin.path, { text, declarations });
  }
  for (const [index, rule] of SPLITS.entries()) {
    const pin = lock.splits[index]; const original = verifyFile(originals.get(pin.path), pin); const value = generateBackendSplit(original, rule);
    assert.deepEqual(selectedDeclarations(original.toString('utf8')), pin.declarations);
    assert.deepEqual(selectedDeclarations(value.bytes.toString('utf8')).map(declaration => declaration.name), rule.retainedDeclarations);
    assert.deepEqual(identity(value.bytes), pin.generated); assert.deepEqual(value.fragments.map(identity), pin.fragments);
    const removedDeclarations = pin.declarations.filter(declaration => !rule.retainedDeclarations.includes(declaration.name));
    assert.deepEqual(removedDeclarations, pin.removedDeclarations);
    splits.set(pin.path, { text: value.bytes.toString('utf8'), removedDeclarations }); generated.push({ pin, original, bytes: value.bytes });
  }
  for (const pin of lock.retainedBoundaries) { assert(!SELECTED.includes(pin.path)); verifyFile(originals.get(pin.path), pin); }
  assert(lock.retainedBoundaries.some(pin => pin.path === WASM_PHASES));
  return { sourceRoot, lock, lockBytes, pins, originals, candidates, splits, generated, totalBytes };
}

async function backendInputs(preparedBackend, input) {
  const { receipt, commonSources } = preparedBackend ?? {};
  assert.equal(receipt?.kind, 'official-wasm-backend-memory-host-preparation'); assert.deepEqual(receipt.source, SOURCE);
  assert.equal(receipt.sourceLockSha256, input.lock.backendSourceLockSha256); assert.equal(receipt.browserCompiler, 'not-built');
  assert.deepEqual(receipt.sources, input.lock.backendPreparedSourcePins, 'Prepared backend source pins changed');
  const expectedLock = JSON.parse(await readRegular(path.join(HERE, '../backend/sources.lock.json')));
  assert.equal(sha256(await readRegular(path.join(HERE, '../backend/sources.lock.json'))), input.lock.backendSourceLockSha256);
  assert.deepEqual(receipt.codegen, expectedLock.codegen); assert.deepEqual(receipt.linker, expectedLock.linker); assert.deepEqual(receipt.patch, expectedLock.patch);
  assert(Array.isArray(commonSources) && commonSources.length >= 3 && commonSources.length <= 16);
  const sources = new Map(), identities = [];
  for (const filename of commonSources) {
    assert(typeof filename === 'string' && path.isAbsolute(filename) && filename.endsWith('.kt'));
    const matches = receipt.sources.filter(pin => filename.endsWith(path.sep + pin.path.split('/').join(path.sep)));
    assert.equal(matches.length, 1, 'Prepared backend source must bind one receipt path'); const pin = matches[0];
    const bytes = await readRegular(filename); assert.deepEqual(identity(bytes), { bytes: pin.bytes, sha256: pin.sha256 });
    assert(!sources.has(pin.path)); sources.set(pin.path, { text: bytes.toString('utf8') }); identities.push({ filename: path.resolve(filename), path: pin.path, ...identity(bytes) });
  }
  assert(sources.has(DRIVER));
  // Exact helper bytes are bound to the existing preparation receipt. Verify the
  // source slice once more, rather than assuming the CLI's mode-selection shell.
  const codegen = verifyFile(await readRegular(path.join(input.sourceRoot, expectedLock.codegen.path)), expectedLock.sources.find(pin => pin.path === expectedLock.codegen.path)).toString('utf8');
  const wholeProgram = codegen.slice(codegen.indexOf(expectedLock.codegen.start), codegen.indexOf(expectedLock.codegen.end));
  assert.equal(sha256(Buffer.from(wholeProgram)), expectedLock.codegen.sha256); assert(sources.get(DRIVER).text.includes(wholeProgram));
  assert(wholeProgram.includes('generateAsSingleFileFragment')); assert(wholeProgram.includes('multimoduleOptions = null'));
  assert(!wholeProgram.includes('WasmIrModule(')); assert(!wholeProgram.includes('CacheUpdater'));
  return { sources, identities, receiptSha256: sha256(Buffer.from(JSON.stringify(receipt))), wholeProgramSha256: expectedLock.codegen.sha256 };
}

async function assess(input, { preparedBackend, browserEntry, retainedSources }) {
  const backend = await backendInputs(preparedBackend, input);
  assert(typeof browserEntry === 'string' && path.isAbsolute(browserEntry)); const entryBytes = await readRegular(browserEntry); const entryText = entryBytes.toString('utf8');
  for (const required of ['WasmTarget.WASI', 'IrFactoryImplForWasmIC(WholeWorldStageController())', 'compileToLoweredIr(', 'compileWholeProgramModeToWasmIr(', 'writeBrowserProgramBinary(', 'configuration.wasmDisableCrossFileOptimisations = false']) assert(entryText.includes(required), 'Whole-program browser entry changed: ' + required);
  assert(Array.isArray(retainedSources) && retainedSources.length > 0 && retainedSources.length <= 8192);
  const canonical = new Map([...input.originals].filter(([filename]) => !SELECTED.includes(filename)).map(([filename, bytes]) => [filename, { text: bytes.toString('utf8') }]));
  const composed = new Map(), composedIdentities = [], seen = new Set(); let composedBytes = 0;
  for (let offset = 0; offset < retainedSources.length; offset += 24) {
    const batch = await Promise.allSettled(retainedSources.slice(offset, offset + 24).map(async raw => {
      assert(typeof raw === 'string' && path.isAbsolute(raw) && raw.endsWith('.kt')); const filename = path.resolve(raw);
      const bytes = await readRegular(filename); return { filename, bytes };
    }));
    for (const result of batch) {
      if (result.status !== 'fulfilled') throw result.reason;
      const { filename, bytes } = result.value; assert(!seen.has(filename), 'Duplicate composed Kotlin input'); seen.add(filename);
      composedBytes += bytes.length; const replacedByProfile = logicalSelectedPath(filename);
      composedIdentities.push({ filename, ...identity(bytes), replacedByProfile: replacedByProfile ?? null });
      if (!replacedByProfile) composed.set(filename, { text: bytes.toString('utf8') });
    }
  }
  assert(composedBytes <= 64 * 1024 * 1024);
  const retainedBoundaryBindings = input.lock.retainedBoundaries.map(pin => {
    const callers = composedIdentities.filter(value => value.filename.endsWith(path.sep + pin.path.split('/').join(path.sep)) && value.replacedByProfile === null);
    assert(callers.length, 'Missing required retained Wasm/shared boundary: ' + pin.path);
    return { path: pin.path, callers: callers.map(({ filename, bytes, sha256 }) => ({ filename, bytes, sha256 })) };
  });
  for (const values of [canonical, composed]) {
    for (const [filename, source] of backend.sources) values.set('prepared-backend/' + filename, source);
    values.set('browser-entry/' + path.basename(browserEntry), { text: entryText });
  }
  const canonicalResult = chooseExclusions({ candidates: input.candidates, splits: input.splits, retained: canonical }); checkedSelection(canonicalResult, 'pinned primary Kotlin sources');
  const composedResult = chooseExclusions({ candidates: input.candidates, splits: input.splits, retained: composed }); checkedSelection(composedResult, 'actual composed compiler Kotlin sources');
  const discardedGraphSources = new Map(input.candidates);
  for (const rule of SPLITS) discardedGraphSources.set(rule.path, { text: input.originals.get(rule.path).toString('utf8'), declarations: input.splits.get(rule.path).removedDeclarations });
  const graph = selectedFileGraph(discardedGraphSources);
  return { backend, browserEntry: { filename: path.resolve(browserEntry), ...identity(entryBytes) }, composedIdentities,
    sourceSelection: { primaryKotlinInputs: input.pins.length, primarySourceBytes: input.totalBytes, composedKotlinInputs: retainedSources.length, composedSourceBytes: composedBytes,
      primaryGuardedCallers: canonical.size, composedGuardedCallers: composed.size, excludedOriginalFiles: CANDIDATE_FILES.length, splitOriginalFiles: SPLITS.length,
      primaryIncomingReferences: [], composedIncomingReferences: [], retainedBoundaryBindings, graph },
    retainedHostEdges: [
      { declaration: 'IrICProgramFragments.serialize', source: SPLITS[1].path, boundary: 'java.io.OutputStream', status: 'unported; exact original signature retained' },
      { declaration: 'JsIrProgramFragments.serialize', source: 'compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/transformers/irToJs/JsIrProgramFragment.kt', boundary: 'OutputStream and real serializeTo', status: 'retained original; no success stub' },
      { declaration: 'JsCommonBackendContext.compileSuspendAsJsGenerator', source: 'compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/utils/misc.kt', boundary: 'JsIrBackendContext and actual configuration predicate', status: 'unchanged; shared JS context/AST source coupling remains' },
    ] };
}

function receiptFor(root, input, result, paths, preparationToolSha256) {
  const files = input.generated.map(value => ({ path: value.pin.path, ...identity(value.bytes), originalSha256: value.pin.sha256 }));
  return { schemaVersion: 1, kind: 'official-wasm-whole-rebuild-source-profile-preparation', source: SOURCE,
    sourceLockSha256: sha256(input.lockBytes), preparationToolSha256,
    inputPaths: { sourceRoot: input.sourceRoot, preparedBackend: paths.preparedBackend, browserEntry: path.resolve(paths.browserEntry), retainedSources: paths.retainedSources.map(filename => path.resolve(filename)) },
    backend: { sourceLockSha256: input.lock.backendSourceLockSha256, receiptSha256: result.backend.receiptSha256, sources: result.backend.identities, wholeProgramSha256: result.backend.wholeProgramSha256 },
    browserEntry: result.browserEntry, composedSources: result.composedIdentities, sourceSelection: result.sourceSelection,
    retainedBoundaries: input.lock.retainedBoundaries, retainedHostEdges: result.retainedHostEdges,
    files, commonSources: files.map(pin => path.join(root, pin.path)), replacedOriginalPaths: SPLITS.map(rule => rule.path),
    sourceSetExclusions: [...CANDIDATE_FILES], exclusionReason: 'No retained import, qualified, same-package or wildcard reference to any sealed selected declaration in both pinned primary and actual composed compiler inputs',
    sourceGraphLimit: 'Reviewed pinned top-level declaration inventories and conservative lexical references; not a resolved semantic compiler call graph or complete Gradle/host closure',
    lowerings: 'All common/Wasm and nine Wasm-used JS lowering files and original phase order retained', originalSourceUnmodified: true,
    requiresCompositionLast: true, compilerSourceBuild: 'not-run for this source profile', browserCompilerBuilt: false, browserCompiledNewSource: false, languageReadiness: false };
}

export async function prepareBackendProfileSources({ sourceRoot, outputRoot, preparedBackend, browserEntry, retainedSources }) {
  outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot);
  const root = path.join(outputRoot, 'compiler-port-backend-profile'); await assertNoSymlink(root);
  try { await lstat(root); throw new Error('Backend profile output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const input = await loadInputs(sourceRoot); const paths = { preparedBackend, browserEntry, retainedSources }; const result = await assess(input, paths);
  if (outputRoot === input.sourceRoot || outputRoot.startsWith(input.sourceRoot + path.sep) || input.sourceRoot.startsWith(outputRoot + path.sep)) throw new Error('Backend profile output overlaps original source');
  await mkdir(outputRoot, { recursive: true, mode: 0o700 }); await mkdir(root, { recursive: false, mode: 0o700 });
  for (const { pin, original, bytes } of input.generated) for (const [prefix, content] of [['original', original], ['', bytes]]) {
    const filename = path.join(root, prefix, relativePath(pin.path)); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, content, { flag: 'wx', mode: 0o600 });
  }
  const receipt = receiptFor(root, input, result, paths, sha256(await readRegular(fileURLToPath(import.meta.url)))); const receiptPath = path.join(root, 'receipt.json');
  await writeJson(receiptPath, receipt);
  return { commonSources: receipt.commonSources, replacedOriginalPaths: receipt.replacedOriginalPaths, sourceSetExclusions: receipt.sourceSetExclusions, receipt, receiptPath };
}

export async function verifyBackendProfilePreparation(root) {
  root = path.resolve(root); await assertNoSymlink(root); const receiptBytes = await readRegular(path.join(root, 'receipt.json')); const receipt = JSON.parse(receiptBytes);
  const input = await loadInputs(receipt.inputPaths.sourceRoot); const result = await assess(input, receipt.inputPaths);
  assert.deepEqual(receipt, receiptFor(root, input, result, receipt.inputPaths, sha256(await readRegular(fileURLToPath(import.meta.url)))), 'Stale backend source-profile receipt');
  for (const pin of receipt.files) {
    const bytes = await readRegular(path.join(root, relativePath(pin.path))); assert.deepEqual(identity(bytes), { bytes: pin.bytes, sha256: pin.sha256 }, 'Backend extracted source changed');
    verifyFile(await readRegular(path.join(root, 'original', pin.path)), input.lock.splits.find(value => value.path === pin.path));
  }
  return { root, receipt, receiptSha256: sha256(receiptBytes), commonSources: receipt.commonSources, replacedOriginalPaths: receipt.replacedOriginalPaths, sourceSetExclusions: receipt.sourceSetExclusions };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(value => value !== '--');
  if (args.length !== 6 || args[0] !== '--source-root' || args[2] !== '--composed-baseline' || args[4] !== '--output') throw new Error('Usage: prepare.mjs --source-root PINNED_SOURCES --composed-baseline ACTUAL_INPUT_JSON --output NEW_DIRECTORY');
  const baseline = JSON.parse(await readRegular(args[3])); assert.equal(baseline.sourceCommit, SOURCE.commit);
  const result = await prepareBackendProfileSources({ sourceRoot: args[1], preparedBackend: baseline.preparedBackend, browserEntry: path.resolve(HERE, '../entry/BrowserCompilerPipeline.kt'), retainedSources: baseline.retainedSources, outputRoot: args[5] });
  console.log(JSON.stringify({ receiptPath: result.receiptPath, commonSources: result.commonSources.length, excluded: result.sourceSetExclusions.length, browserCompilerBuilt: false }));
}
