import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
import { TARGETS } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), targets = new Set(TARGETS);
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const pin = (filename, bytes) => ({ filename, ...identity(bytes) });
const exactKey = row => JSON.stringify([row.source, row.line, row.column, row.message]);
// Only the five transformed files may move a diagnostic with their source edits.
const comparisonKey = row => targets.has(row.source) ? JSON.stringify([row.source, row.message]) : exactKey(row);
const ordered = rows => rows.map(row => ({ column: row.column, message: row.message }))
  .sort((a, b) => a.column - b.column || a.message.localeCompare(b.message));

export function newPsiDiagnostics(baseline, current) {
  const counts = new Map(), added = [];
  for (const row of baseline) { const key = comparisonKey(row); counts.set(key, (counts.get(key) ?? 0) + 1); }
  for (const row of current) {
    const key = comparisonKey(row);
    if (counts.get(key)) counts.set(key, counts.get(key) - 1); else added.push(row);
  }
  return added;
}

export async function readPsiDiagnosticBuild(buildRoot, log) {
  const receiptFile = path.join(buildRoot, 'compiler-build-receipt.json');
  const receiptBytes = await readRegular(receiptFile, 128 * 1024 * 1024), receipt = JSON.parse(receiptBytes);
  const argsFile = path.join(buildRoot, 'compiler-klib.args'), argsBytes = await readRegular(argsFile, 16 * 1024 * 1024);
  const command = receipt.commands.find(row => row.phase === 'official-compiler-source-to-wasmjs-klib');
  assert(command, 'Actual compiler invocation required'); assert.equal(command.exitCode, 1); assert.equal(command.signal, null);
  assert.equal(command.argumentFileSha256, sha256(argsBytes));
  const args = argsBytes.toString().trimEnd().split('\n').map(JSON.parse);
  const filenames = args.slice(-receipt.compileSources.length);
  const sources = receipt.compileSources.map((row, index) => ({ ...row, filename: filenames[index] }));
  const owners = new Map(sources.map(row => [row.filename, row.path])); assert.equal(owners.size, 3571);
  const logBytes = await readRegular(log, 64 * 1024 * 1024), entries = [];
  assert(!/^(?:Exception in thread|java\.lang\.(?:OutOfMemoryError|StackOverflowError)|Internal compiler error|exception:)/mi.test(logBytes.toString()),
    'Compiler crash cannot qualify as a diagnostic reduction');
  for (const line of logBytes.toString().split(/\r?\n/)) {
    const match = /^(.*?):(\d+):(\d+): error: (.*)$/.exec(line);
    if (match) {
      const logical = owners.get(path.resolve(buildRoot, match[1]));
      assert(logical, 'Diagnostic source is not an actual compiler input: ' + match[1]);
      entries.push({ source: logical, line: Number(match[2]), column: Number(match[3]), message: match[4] });
    } else if (/^error: /.test(line)) entries.push({ source: '<compiler>', line: 0, column: 0, message: line.slice(7) });
  }
  assert(entries.length > 0, 'Completed failing compiler must have observable diagnostics');
  return { entries, sources, receipt: identity(receiptBytes), inputs: [pin(receiptFile, receiptBytes), pin(argsFile, argsBytes), pin(log, logBytes)] };
}

/** No normalization or whole-line waiver: every reviewed site is an exact pre-existing failing expression. */
export function qualifyPsiDiagnosticDrift({ baseline, current, sources, lock }) {
  assert.equal(lock.kind, 'fir-psi-exact-existing-failure-diagnostic-drift'); assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.sources.length, 4); assert.equal(lock.sites.length, 5);
  assert.equal(new Set(lock.sites.map(row => row.id)).size, 5);
  assert.equal(new Set(lock.sites.map(row => row.source + ':' + row.line)).size, 5);
  assert.equal(sources.length, 4);
  const texts = new Map();
  for (const source of lock.sources) {
    assert(!targets.has(source.path), 'Reviewed drift cannot excuse a transformed source');
    const bytes = sources.find(row => row.path === source.path); assert(bytes);
    assert.deepEqual(identity(bytes.before), { bytes: source.bytes, sha256: source.sha256 }, 'Reviewed source SHA changed');
    assert.deepEqual(bytes.after, bytes.before, 'Reviewed source bytes changed');
    texts.set(source.path, bytes.before.toString().split(/\r?\n/));
  }
  const reviewedExpected = [], sites = [];
  let replacements = 0, nullableCascades = 0, removedCascades = 0, beforeCount = 0, afterCount = 0;
  const unsafe = "unsafe call on receiver of nullable type 'Nothing?'. Consider using a safe call '?.' or non-null asserted call '!!.'.";
  for (const site of lock.sites) {
    const lines = texts.get(site.source); assert(lines);
    assert.equal(lines[site.line - 1], site.expression, 'Reviewed source expression changed');
    for (const line of site.context) assert.equal(lines[line.line - 1], line.text, 'Reviewed source context changed');
    const before = baseline.filter(row => row.source === site.source && row.line === site.line);
    const after = current.filter(row => row.source === site.source && row.line === site.line);
    assert.deepEqual(ordered(before), ordered(site.baseline), 'Baseline site diagnostic multiplicity/position changed');
    assert.deepEqual(ordered(after), ordered(site.current), 'Current site diagnostic multiplicity/position changed');
    const marker = { source: site.source, ...site.existingPsiFailure };
    assert.equal(marker.message, "unresolved reference 'KtPsiSourceElement'.");
    for (const entries of [baseline, current]) assert.equal(entries.filter(row => exactKey(row) === exactKey(marker)).length, 1,
      'Existing unsupported PSI failure marker disappeared or changed');
    assert.equal(site.receiver.type, 'KtSourceElement');
    if (site.receiver.declaration) {
      const declaration = site.receiver.declaration;
      assert.equal(lines[declaration.line - 1], declaration.text);
      assert(/\bval KtSourceElement\./.test(declaration.text), 'Receiver declaration changed');
    }
    if (site.receiver.expression === 'this') assert(site.receiver.declaration, 'Implicit receiver requires its source declaration');
    else assert(site.expression.includes(site.receiver.expression + '.psi'), 'Reviewed receiver expression changed');
    for (const column of site.receiver.candidateColumns) for (const entries of [before, after])
      assert(entries.some(row => row.column === column && row.message.includes("Actual receiver type is 'KtSourceElement'.")),
        'Existing invalid receiver type changed');
    const expectedAdded = [], expectedRemoved = [];
    for (const replacement of site.replacements) {
      expectedAdded.push({ source: site.source, line: site.line, column: replacement.column, message: replacement.after });
      expectedRemoved.push({ source: site.source, line: site.line, column: replacement.column, message: replacement.before });
    }
    for (const cascade of site.additionalNullableCascades) {
      assert.equal(cascade.message, unsafe);
      assert(site.replacements.some(row => row.column === cascade.existingFailureColumn), 'Nullable cascade lacks a pre-existing failed access');
      expectedAdded.push({ source: site.source, line: site.line, column: cascade.column, message: cascade.message });
    }
    for (const removed of site.removedInferenceCascades)
      expectedRemoved.push({ source: site.source, line: site.line, column: removed.column, message: removed.message });
    assert.deepEqual(newPsiDiagnostics(before, after).map(exactKey).sort(), expectedAdded.map(exactKey).sort(), 'Reviewed added messages changed');
    assert.deepEqual(newPsiDiagnostics(after, before).map(exactKey).sort(), expectedRemoved.map(exactKey).sort(), 'Reviewed removed messages changed');
    reviewedExpected.push(...expectedAdded);
    replacements += site.replacements.length; nullableCascades += site.additionalNullableCascades.length;
    removedCascades += site.removedInferenceCascades.length; beforeCount += before.length; afterCount += after.length;
    sites.push({ id: site.id, source: site.source, line: site.line, expression: site.expression,
      sourceSha256: lock.sources.find(row => row.path === site.source).sha256,
      baselineDiagnostics: before.length, currentDiagnostics: after.length });
  }
  assert.equal(replacements, 7); assert.equal(nullableCascades, 2); assert.equal(removedCascades, 5);
  assert.equal(beforeCount, 26); assert.equal(afterCount, 23);
  for (const [key, value] of Object.entries({ messageReplacements: replacements, additionalNullableCascades: nullableCascades,
    removedInferenceCascades: removedCascades, baselineSiteDiagnostics: beforeCount, currentSiteDiagnostics: afterCount })) assert.equal(lock[key], value);
  const added = newPsiDiagnostics(baseline, current).filter(row => !targets.has(row.source));
  const expected = new Map(reviewedExpected.map(row => [exactKey(row), row]));
  assert.equal(expected.size, lock.reviewedNewDiagnosticCount); assert.equal(expected.size, 9);
  const reviewed = [], unreviewed = [];
  for (const row of added) { const key = exactKey(row); if (expected.delete(key)) reviewed.push(row); else unreviewed.push(row); }
  assert.equal(expected.size, 0, 'A reviewed diagnostic moved, disappeared, or changed');
  return { sites, messageReplacements: replacements, additionalNullableCascades: nullableCascades,
    removedInferenceCascades: removedCascades, baselineSiteDiagnostics: beforeCount, currentSiteDiagnostics: afterCount,
    reviewedNewDiagnosticEntries: reviewed, unreviewedNewDiagnosticEntries: unreviewed,
    reviewedMessagesAllAtPreexistingFailureSites: true,
    limitation: 'The five PSI expressions remain unsupported and failing; reviewed messages are visible, not ignored or claimed fixed.' };
}

export async function comparePsiDiagnostics(currentBuild, currentLog, baselineBuild, baselineLog) {
  const current = await readPsiDiagnosticBuild(currentBuild, currentLog), baseline = await readPsiDiagnosticBuild(baselineBuild, baselineLog);
  const lockFile = path.join(here, 'diagnostic-drift.lock.json'), lockBytes = await readRegular(lockFile), lock = JSON.parse(lockBytes);
  const sourceLockFile = path.join(here, 'sources.lock.json'), sourceLockBytes = await readRegular(sourceLockFile);
  assert.equal(sha256(sourceLockBytes), lock.sourceLockSha256);
  assert.deepEqual(baseline.receipt, lock.baselineBuildReceipt); assert.deepEqual(current.receipt, lock.currentBuildReceipt);
  const previous = new Map(baseline.sources.map(row => [row.path, row]));
  for (const row of current.sources) if (!targets.has(row.path)) {
    const prior = previous.get(row.path); assert(prior);
    assert.deepEqual({ bytes: row.bytes, sha256: row.sha256 }, { bytes: prior.bytes, sha256: prior.sha256 }, 'Untouched diagnostic source changed');
  }
  const sources = [], sourcePins = [];
  for (const source of lock.sources) {
    const prior = previous.get(source.path), actual = current.sources.find(row => row.path === source.path); assert(prior && actual);
    const before = await readRegular(prior.filename), after = await readRegular(actual.filename);
    assert.deepEqual(identity(before), { bytes: prior.bytes, sha256: prior.sha256 });
    assert.deepEqual(identity(after), { bytes: actual.bytes, sha256: actual.sha256 });
    sources.push({ path: source.path, before, after }); sourcePins.push(pin(prior.filename, before), pin(actual.filename, after));
  }
  const reviewedDrift = qualifyPsiDiagnosticDrift({ baseline: baseline.entries, current: current.entries, sources, lock });
  const added = newPsiDiagnostics(baseline.entries, current.entries);
  return { kind: 'fir-lighttree-psi-logical-diagnostic-comparison', currentBuild, currentLog, baselineBuild, baselineLog,
    inputs: [...baseline.inputs, ...current.inputs, pin(lockFile, lockBytes), pin(sourceLockFile, sourceLockBytes), ...sourcePins],
    driftLock: pin(lockFile, lockBytes), comparisonPolicy: 'Only five transformed files use logical-source/message; all 3566 unchanged files also require exact line/column.',
    baselineTotal: baseline.entries.length, currentTotal: current.entries.length,
    baselineProfileEntries: baseline.entries.filter(row => targets.has(row.source)), currentProfileEntries: current.entries.filter(row => targets.has(row.source)),
    newProfileDiagnosticEntries: added.filter(row => targets.has(row.source)), newOtherDiagnosticEntries: added.filter(row => !targets.has(row.source)),
    reviewedDrift, interpretation: 'Raw new messages remain visible. Seven exact replacements and two nullable cascades at five unchanged already-failing PSI expressions are separately reviewed; no other new diagnostic is accepted. Cascades are not independent bugs or whole compiler correctness evidence.' };
}
