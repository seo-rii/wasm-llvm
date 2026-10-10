#!/usr/bin/env node
/** Actual source-selection/integrity checks; does not execute a compiler. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { prepareBackendSources } from '../backend/prepare.mjs';
import { CANDIDATE_FILES, SPLITS, generateBackendSplit } from './generate.mjs';
import { chooseExclusions, declarationReferences, selectedDeclarations, selectedFileGraph } from './references.mjs';
import { prepareBackendProfileSources, verifyBackendProfilePreparation } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); const execute = promisify(execFile);

export async function runBackendProfileChecks({ sourceRoot, composedBaseline, outputRoot }) {
  sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
  await mkdir(outputRoot, { recursive: false, mode: 0o700 });
  const baselineBytes = await readRegular(composedBaseline); const baseline = JSON.parse(baselineBytes);
  assert.equal(baseline.sourceCommit, '4d78aae1e337cd40f69baa865aed950fe807a775');
  // Existing composed sources stay intact. Their backend files may carry later
  // import adaptations; prepare a new exact backend snapshot instead of falsely
  // assigning its old preparation hashes to those changed files.
  const backendRoot = path.join(outputRoot, 'fresh-backend'); await mkdir(backendRoot, { mode: 0o700 });
  await execute('git', ['init', '--quiet', backendRoot], { timeout: 10000, maxBuffer: 65536 });
  const preparedBackend = await prepareBackendSources({ sourceRoot, outputRoot: backendRoot });
  const paths = { sourceRoot, preparedBackend, browserEntry: path.resolve(HERE, '../entry/BrowserCompilerPipeline.kt'), retainedSources: baseline.retainedSources };
  await writeJson(path.join(outputRoot, 'fresh-composed-input.json'), { ...baseline, preparedBackend });
  const prepared = await prepareBackendProfileSources({ ...paths, outputRoot: path.join(outputRoot, 'profile') });
  const root = path.dirname(prepared.receiptPath); const checked = await verifyBackendProfilePreparation(root);
  const guards = []; async function check(id, operation) { await operation(); guards.push({ id, result: 'pass' }); }
  await check('actual-source-selection-and-exact-bodies', async () => {
    assert.equal(checked.receipt.sourceSelection.composedKotlinInputs, baseline.retainedSources.length);
    assert.equal(checked.receipt.sourceSelection.primaryKotlinInputs, 3417); assert.equal(checked.commonSources.length, 4);
    assert.deepEqual(checked.sourceSetExclusions, CANDIDATE_FILES); assert.equal(checked.receipt.browserCompilerBuilt, false); assert.equal(checked.receipt.languageReadiness, false);
    const lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
    assert.equal(lock.wasmUsedJsLoweringFiles.length, 9); assert.equal(checked.receipt.retainedHostEdges.length, 3);
    for (const rule of SPLITS) {
      const original = await readRegular(path.join(sourceRoot, rule.path)); const expected = generateBackendSplit(original, rule);
      assert.deepEqual(await readRegular(path.join(root, rule.path)), expected.bytes);
      assert(expected.fragments.every(fragment => original.includes(fragment)), 'Retained declaration body must be exact original bytes');
    }
    const factory = await readRegular(path.join(root, SPLITS[0].path));
    for (const retained of ['copyByDefault = false', 'jsToKotlinStringAdapterBuiltIn', 'eraseSignature', 'unitGetInstanceBuiltIn']) assert(factory.includes(Buffer.from(retained)));
    assert((await readRegular(path.join(root, SPLITS[1].path))).includes(Buffer.from('abstract fun serialize(stream: OutputStream)')));
  });
  await check('existing-output-is-preserved', async () => {
    const before = await readRegular(prepared.receiptPath); await assert.rejects(prepareBackendProfileSources({ ...paths, outputRoot: path.join(outputRoot, 'profile') }), /already exists/);
    assert.deepEqual(await readRegular(prepared.receiptPath), before);
  });
  await check('prepared-source-mutation-rejected', async () => {
    const filename = checked.commonSources[0]; const before = await readRegular(filename);
    try { await writeFile(filename, Buffer.concat([before, Buffer.from('\n// changed\n')])); await assert.rejects(verifyBackendProfilePreparation(root), /Backend extracted source changed/); }
    finally { await writeFile(filename, before); }
  });
  await check('forged-readiness-rejected', async () => {
    const before = await readRegular(prepared.receiptPath);
    try { await writeFile(prepared.receiptPath, JSON.stringify({ ...checked.receipt, browserCompilerBuilt: true, languageReadiness: true })); await assert.rejects(verifyBackendProfilePreparation(root), /Stale backend/); }
    finally { await writeFile(prepared.receiptPath, before); }
  });
  await check('backend-binding-mutation-rejected', async () => {
    const before = await readRegular(preparedBackend.commonSources[0]);
    try {
      await writeFile(preparedBackend.commonSources[0], Buffer.concat([before, Buffer.from('\n// mutation\n')]));
      await assert.rejects(prepareBackendProfileSources({ ...paths, outputRoot: path.join(outputRoot, 'bad-backend') }), /deep-equal/);
    } finally { await writeFile(preparedBackend.commonSources[0], before); }
  });
  await check('new-retained-alias-reference-rejected', async () => {
    const filename = path.join(outputRoot, 'RetainedSerializerCaller.kt');
    await writeFile(filename, 'package retained.guard\nimport org.jetbrains.kotlin.backend.wasm.serialization.WasmSerializer as SerializerAlias\nfun guard(value: SerializerAlias) = value\n', { flag: 'wx', mode: 0o600 });
    await assert.rejects(prepareBackendProfileSources({ ...paths, retainedSources: [...paths.retainedSources, filename], outputRoot: path.join(outputRoot, 'new-alias-reference') }), error => error.name === 'UnclosedBackendProfileError' && error.report.promoted.some(value => value.filename.endsWith('WasmSerializer.kt')));
  });
  await check('new-reference-to-split-declaration-rejected', async () => {
    const filename = path.join(outputRoot, 'RetainedCacheCaller.kt');
    await writeFile(filename, 'package retained.guard\nimport org.jetbrains.kotlin.ir.backend.js.ic.*\nfun guard(value: CacheUpdater<*, *, *, *>) = value\n', { flag: 'wx', mode: 0o600 });
    await assert.rejects(prepareBackendProfileSources({ ...paths, retainedSources: [...paths.retainedSources, filename], outputRoot: path.join(outputRoot, 'new-split-reference') }), error => error.name === 'UnclosedBackendProfileError' && error.report.unclosed.some(value => value.declaration === 'CacheUpdater'));
  });
  await check('required-shared-lowering-removal-rejected', async () => {
    const filename = 'compiler/ir/backend.wasm/src/org/jetbrains/kotlin/backend/wasm/WasmLoweringPhases.kt';
    await assert.rejects(prepareBackendProfileSources({ ...paths, retainedSources: paths.retainedSources.filter(value => !value.endsWith('/' + filename)), outputRoot: path.join(outputRoot, 'missing-lowering') }), /Missing required retained Wasm\/shared boundary/);
  });
  await check('upstream-source-mutation-rejected', async () => {
    const copy = path.join(outputRoot, 'tampered-source'); await cp(sourceRoot, copy, { recursive: true, dereference: false });
    const filename = path.join(copy, SPLITS[0].path); const bytes = await readRegular(filename); await writeFile(filename, Buffer.concat([bytes, Buffer.from('\n')]));
    await assert.rejects(prepareBackendProfileSources({ ...paths, sourceRoot: copy, outputRoot: path.join(outputRoot, 'bad-upstream') }), /Pinned source content mismatch/);
  });
  await check('symlink-output-rejected', async () => {
    const target = path.join(outputRoot, 'symlink-target'); await mkdir(target, { mode: 0o700 }); const filename = path.join(outputRoot, 'symlink-output'); await symlink(target, filename);
    await assert.rejects(prepareBackendProfileSources({ ...paths, outputRoot: filename }), /Symlink paths/);
  });
  await check('reference-kinds-and-transitive-retention', async () => {
    const declaration = { packageName: 'a.b', name: 'Removed', kind: 'class' };
    for (const text of ['package a.b\nval k = Removed()', 'package x\nimport a.b.Removed as Alias\nval x = Alias()', 'package x\nimport a.b.*\nval x = Removed()', 'package x\nval x = a.b.Removed()', 'package x\nimport a.b.Removed.Nested\nval x = Nested()']) assert(declarationReferences(text, declaration).length);
    const first = { text: 'package a.b\nclass Removed : Other()', declarations: [declaration] };
    const second = { text: 'package a.b\nclass Other : Removed()', declarations: [{ ...declaration, name: 'Other' }] };
    const sources = new Map([['first.kt', first], ['second.kt', second]]);
    const graph = selectedFileGraph(sources); assert.deepEqual(graph.components, [['first.kt', 'second.kt']]);
    const promoted = chooseExclusions({ candidates: sources, splits: new Map(), retained: new Map([['actual.kt', { text: 'package a.b\nfun f() = Removed()' }]]) });
    assert.equal(promoted.excluded.length, 0); assert.equal(promoted.promoted.length, 2);
    assert.deepEqual(selectedDeclarations('package a.b\nfun interface Factory<T>\nprivate typealias Alias = String\ninternal fun String.call() = this\nval String.name get() = this').map(value => value.name), ['Factory', 'Alias', 'call', 'name']);
  });
  const final = await verifyBackendProfilePreparation(root); assert.equal(final.receiptSha256, checked.receiptSha256);
  const preparation = final.receipt; const evidence = { schemaVersion: 1, kind: 'official-wasm-whole-rebuild-backend-source-selection', source: preparation.source,
    sourceLockSha256: preparation.sourceLockSha256, preparationToolSha256: preparation.preparationToolSha256, preparationReceiptSha256: final.receiptSha256,
    priorComposedBaseline: { path: path.resolve(composedBaseline), sha256: sha256(baselineBytes), sourceCount: baseline.retainedSources.length },
    preparedBackend: preparation.backend, browserEntry: preparation.browserEntry, sourceSelection: preparation.sourceSelection,
    splits: preparation.files, sourceSetExclusions: preparation.sourceSetExclusions, retainedBoundaries: preparation.retainedBoundaries,
    retainedHostEdges: preparation.retainedHostEdges, referenceScope: preparation.sourceGraphLimit, composition: 'profile runs last, disables previous replacements at excluded original logical paths',
    guardResults: guards, results: { sourceSelection: 'pass', exactRetainedBodies: 'pass', integrityGuards: 'pass', wholeCompilerBuild: 'not-run for this profile', browserNewSourceCompile: 'not-run' },
    browserCompilerBuilt: false, languageReadiness: false,
    commands: [{ argv: ['node', 'producer/kotlin-browser/compiler-port/backend-profile/probe.mjs', '--source-root', sourceRoot, '--composed-baseline', path.resolve(composedBaseline), '--output', outputRoot], exitCode: 0 }],
    limits: ['No resolved semantic/Gradle dependency closure claimed', 'Retained JVM OutputStream boundary remains unresolved', 'No browser compiler or new user source compile/run acceptance claimed'] };
  await writeJson(path.join(outputRoot, 'source-selection.json'), evidence); await writeJson(path.join(outputRoot, 'guards.json'), { schemaVersion: 1, kind: 'official-backend-source-profile-integrity-guards', preparationReceiptSha256: final.receiptSha256, guardResults: guards, pass: guards.length, fail: 0, languageReadiness: false });
  return { receiptPath: prepared.receiptPath, evidencePath: path.join(outputRoot, 'source-selection.json'), guardPath: path.join(outputRoot, 'guards.json'), guards: guards.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(value => value !== '--');
  if (args.length !== 6 || args[0] !== '--source-root' || args[2] !== '--composed-baseline' || args[4] !== '--output') throw new Error('Usage: probe.mjs --source-root PINNED_SOURCES --composed-baseline ACTUAL_INPUT_JSON --output NEW_DIRECTORY');
  console.log(JSON.stringify(await runBackendProfileChecks({ sourceRoot: args[1], composedBaseline: args[3], outputRoot: args[5] })));
}
