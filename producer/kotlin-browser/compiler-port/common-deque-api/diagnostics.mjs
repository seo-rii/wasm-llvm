import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256 } from '../../scripts/source.mjs';
import { compilerInputPins, projectControlArguments } from '../compiler-exception-attachment-profile/current-foundation-control.mjs';
import { TARGETS, transformCommonDequeApi } from './transform.mjs';

const targets = new Set(TARGETS);
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const pin = (filename, bytes) => ({ filename, ...identity(bytes) });
const exactKey = row => JSON.stringify([row.source, row.line, row.column, row.message]);
const sourceIdentity = row => ({ bytes: row.bytes, sha256: row.sha256 });
const canonical = filename => {
  assert(typeof filename === 'string' && path.isAbsolute(filename) && path.resolve(filename) === filename,
    'Canonical absolute artifact filename required');
  return filename;
};

// Fixed before the new whole build. Import/API errors and their local inference
// cascades disappear; the four unrelated file/reflection failures remain exact.
export const EXPECTED_DEQUE_DIAGNOSTICS = Object.freeze({
  sources: 3571, jvmSignatureSources: 18, replacedSources: 6,
  baselineTotal: 1250, currentTotal: 1221, baselineTarget: 33, currentTarget: 4, removed: 29,
});
export const REMAINING_DEQUE_DIAGNOSTICS = Object.freeze([
  { source: TARGETS[0], line: 95, column: 8, message: "unresolved reference 'java'." },
  { source: TARGETS[0], line: 367, column: 27, message: "unresolved reference 'File'." },
  { source: TARGETS[5], line: 169, column: 43, message: "unresolved reference 'java' on receiver of type 'KClass<out TypeConstructor>'." },
  { source: TARGETS[5], line: 174, column: 54, message: "unresolved reference 'java' on receiver of type 'KClass<out DeclarationDescriptor>'." },
].map(Object.freeze));

const BASELINE = Object.freeze({
  archiveSha256: '5cc36b426abdf3b0f6c4a625df2ad43cac7006e86e7cf9581a3838baec97ada2',
  archiveBytes: 233852609,
  manifestSha256: 'a07024090eb51dd8fc1629f461035069542fc1d0cb2ef8bec67229d5b442e247',
  receiptSha256: '1a2e85ed2ac9d86a8e12a54ecf99f1dcefa4ed083f8179000db9ce09957370e4',
  argumentFileSha256: '9abc62fb59f02d736364435b9cba5cbf030fdbef370324a3fe9462e6d1bd418e',
  logSha256: '924c6f03dbfaf9cfd02145a63bd2f2cf5bfa54b4268ecf330d7c054a47cf81b8',
  snapshotRoot: '/home/seorii/dev/hancomac/.worktrees/wasm-llvm-kotlin-entry-20261108',
  buildRoot: '/home/seorii/dev/hancomac/.worktrees/wasm-llvm-kotlin-entry-20261108/out/official-main-whole-v1',
});

function validateSources(rows, label) {
  assert(Array.isArray(rows) && rows.length === EXPECTED_DEQUE_DIAGNOSTICS.sources,
    label + ' requires all 3571 compiler sources');
  const logical = new Set(), owners = new Set();
  for (const row of rows) {
    relativePath(row.path); canonical(row.filename);
    assert(!logical.has(row.path), label + ' contains a duplicate logical source');
    assert(!owners.has(row.filename), label + ' contains a duplicate source owner');
    logical.add(row.path); owners.add(row.filename);
    assert(Number.isSafeInteger(row.bytes) && row.bytes >= 0 && /^[a-f0-9]{64}$/.test(row.sha256 ?? ''),
      label + ' contains an invalid source identity');
    if ('compile' in row) assert.equal(row.compile, true, label + ' contains an inactive source');
  }
  assert(TARGETS.every(filename => logical.has(filename)), label + ' must retain all six whole target files');
  assert.equal(rows.filter(row => row.path.startsWith('compiler-port-jvm-descriptor-signatures/')).length, 18);
  return logical;
}

function validateDiagnostics(entries, sources, label) {
  assert(Array.isArray(entries));
  for (const row of entries) {
    assert(row.source === '<compiler>' || sources.has(row.source), label + ' diagnostic has an unselected source');
    assert(Number.isSafeInteger(row.line) && Number.isSafeInteger(row.column) &&
      (row.source === '<compiler>' ? row.line === 0 && row.column === 0 : row.line > 0 && row.column > 0),
    label + ' diagnostic position is invalid');
    assert(typeof row.message === 'string' && row.message.length > 0, label + ' diagnostic needs an exact message');
  }
}

function additions(before, after) {
  const counts = new Map(), added = [];
  for (const row of before) { const key = exactKey(row); counts.set(key, (counts.get(key) ?? 0) + 1); }
  for (const row of after) {
    const key = exactKey(row), count = counts.get(key) ?? 0;
    if (count) counts.set(key, count - 1); else added.push(row);
  }
  return added;
}

export function parseDiagnosticLog(text, buildRoot, sources) {
  canonical(buildRoot); validateSources(sources, 'Logged');
  assert(!/^(?:Exception in thread|java\.lang\.(?:OutOfMemoryError|StackOverflowError)|Internal compiler error|exception:)/mi.test(text),
    'Compiler crash cannot qualify as a diagnostic reduction');
  const owners = new Map(sources.map(row => [row.filename, row.path])), entries = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(.*?):(\d+):(\d+): error: (.*)$/.exec(line);
    if (match) {
      const logical = owners.get(path.resolve(buildRoot, match[1]));
      assert(logical, 'Diagnostic source is not an actual compiler input: ' + match[1]);
      entries.push({ source: logical, line: Number(match[2]), column: Number(match[3]), message: match[4] });
    } else if (/^error: /.test(line)) entries.push({ source: '<compiler>', line: 0, column: 0, message: line.slice(7) });
  }
  assert(entries.length > 0, 'Completed failing compiler must have observable diagnostics');
  validateDiagnostics(entries, new Set(sources.map(row => row.path)), 'Logged');
  return entries;
}

export function qualifyDequeDiagnostics({ baseline, current, baselineSources, currentSources }) {
  const oldPaths = validateSources(baselineSources, 'Baseline'), newPaths = validateSources(currentSources, 'Current');
  for (const [index, row] of currentSources.entries()) {
    const previous = baselineSources[index];
    assert.equal(row.path, previous.path, 'Complete compiler source selection/order changed');
    if (targets.has(row.path)) assert.notDeepEqual(sourceIdentity(row), sourceIdentity(previous), 'Target source was not replaced');
    else assert.deepEqual(sourceIdentity(row), sourceIdentity(previous), 'Untouched source identity changed');
  }
  validateDiagnostics(baseline, oldPaths, 'Baseline'); validateDiagnostics(current, newPaths, 'Current');
  assert.equal(baseline.length, EXPECTED_DEQUE_DIAGNOSTICS.baselineTotal);
  assert.equal(current.length, EXPECTED_DEQUE_DIAGNOSTICS.currentTotal);
  const baselineTarget = baseline.filter(row => targets.has(row.source));
  const currentTarget = current.filter(row => targets.has(row.source));
  assert.equal(baselineTarget.length, EXPECTED_DEQUE_DIAGNOSTICS.baselineTarget);
  assert.deepEqual(currentTarget.map(exactKey).sort(), REMAINING_DEQUE_DIAGNOSTICS.map(exactKey).sort(),
    'The four pre-existing unrelated target diagnostics must remain exact');
  const added = additions(baseline, current), removed = additions(current, baseline);
  assert.deepEqual(added, [], 'New/changed diagnostic source, line, column, message or multiplicity');
  assert.equal(removed.length, EXPECTED_DEQUE_DIAGNOSTICS.removed);
  assert(removed.every(row => targets.has(row.source)), 'A diagnostic outside the six target files disappeared');
  return { expected: { ...EXPECTED_DEQUE_DIAGNOSTICS }, baselineTotal: baseline.length, currentTotal: current.length,
    baselineTargetEntries: baselineTarget, currentTargetEntries: currentTarget, removedDiagnostics: removed,
    newDiagnostics: added, sourceSelectionAndOrderPreserved: true, unchangedSourceCount: 3565,
    allSurvivingDiagnosticsExact: true, otherDiagnosticMultisetUnchanged: true, diagnosticWaivers: [] };
}

async function streamPin(filename, expectedBytes, expectedSha256) {
  canonical(filename); await assertNoSymlink(filename);
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); assert(stat.isFile()); assert.equal(stat.size, expectedBytes);
    const hash = createHash('sha256');
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
    const actual = { filename, bytes: stat.size, sha256: hash.digest('hex') };
    assert.equal(actual.sha256, expectedSha256, 'Immutable predecessor archive changed');
    return actual;
  } finally { await handle.close(); }
}

function invocation(receipt, argumentBytes, buildRoot) {
  assert.equal(receipt.kind, 'official-kotlin-compiler-wasmjs-build'); assert.equal(receipt.status, 'failed');
  assert.equal(receipt.sourceHost, 'portable'); assert.equal(receipt.publicLanguageSupport, false);
  const commands = receipt.commands.filter(row => row.phase === 'official-compiler-source-to-wasmjs-klib');
  assert.equal(commands.length, 1, 'Exactly one actual whole compiler invocation required');
  const command = commands[0]; assert.equal(command.exitCode, 1); assert.equal(command.signal, null);
  assert.equal(command.argumentFileSha256, sha256(argumentBytes));
  assert.equal(command.command.at(-1), '@' + path.join(buildRoot, 'compiler-klib.args'));
  const args = argumentBytes.toString().trimEnd().split('\n').map(JSON.parse);
  assert.equal(receipt.compileSources.length, 3571);
  const filenames = args.slice(-3571);
  const sources = receipt.compileSources.map((row, index) => ({ ...row, filename: filenames[index] }));
  validateSources(sources, 'Actual');
  assert.equal(args.filter(value => value.startsWith('-Xcommon-sources=')).length, 1);
  assert(args.includes('-Xcommon-sources=' + filenames.join(',')), 'Actual common and positional compiler vectors differ');
  return { command, args, sources };
}

export async function readRelocatedDequeBaseline(selectionFile, logFile) {
  const selectionBytes = await readRegular(canonical(selectionFile), 8 * 1024 * 1024), selected = JSON.parse(selectionBytes);
  assert.equal(selected.kind, 'relocated-authenticated-official-main-whole-build'); assert.equal(selected.schemaVersion, 1);
  assert.equal(selected.originalSnapshotRoot, BASELINE.snapshotRoot); assert.equal(selected.originalBuildRoot, BASELINE.buildRoot);
  canonical(selected.buildRoot); assert.equal(selected.baselineRoot, selected.buildRoot);
  assert.equal(selected.archiveSha256, BASELINE.archiveSha256); assert.equal(selected.manifestSha256, BASELINE.manifestSha256);
  const archivePin = await streamPin(selected.archive, BASELINE.archiveBytes, BASELINE.archiveSha256);
  const manifestBytes = await readRegular(canonical(selected.manifest), 32 * 1024 * 1024);
  assert.equal(sha256(manifestBytes), BASELINE.manifestSha256, 'Immutable predecessor manifest changed');
  const manifest = JSON.parse(manifestBytes), members = new Map(manifest.members.map(row => [row.path, row]));
  assert.equal(members.size, manifest.members.length);
  const receiptFile = path.join(selected.buildRoot, 'compiler-build-receipt.json');
  const receiptBytes = await readRegular(receiptFile, 128 * 1024 * 1024), receipt = JSON.parse(receiptBytes);
  assert.equal(sha256(receiptBytes), BASELINE.receiptSha256, 'Baseline whole compiler receipt must retain its original bytes');
  assert.deepEqual(selected.receipt, pin(receiptFile, receiptBytes));
  const argumentFile = path.join(selected.buildRoot, 'compiler-klib.args');
  const argumentBytes = await readRegular(argumentFile, 16 * 1024 * 1024);
  assert.equal(sha256(argumentBytes), BASELINE.argumentFileSha256, 'Baseline compiler arguments must retain their original bytes');
  assert.deepEqual(selected.argumentFile, pin(argumentFile, argumentBytes));
  const opened = invocation(receipt, argumentBytes, BASELINE.buildRoot);
  const sources = opened.sources.map(row => {
    const relative = path.relative(BASELINE.buildRoot, row.filename); relativePath(relative);
    const member = members.get('worktree/out/official-main-whole-v1/' + relative);
    assert(member && member.kind === 'file' && member.source === row.filename, 'Baseline owner lacks authenticated archive bytes');
    assert.deepEqual(sourceIdentity(member), sourceIdentity(row));
    return { ...row, filename: path.join(selected.buildRoot, relative), compile: true };
  });
  assert.deepEqual(selected.retainedSources, sources, 'Relocation changed selected source metadata or order');
  const logBytes = await readRegular(canonical(logFile), 64 * 1024 * 1024);
  assert.equal(sha256(logBytes), BASELINE.logSha256, 'Baseline compiler log changed');
  const entries = parseDiagnosticLog(logBytes.toString(), BASELINE.buildRoot, opened.sources);
  return { ...opened, originalSources: opened.sources, sources, receipt, entries, buildRoot: selected.buildRoot,
    originalBuildRoot: BASELINE.buildRoot,
    inputs: [pin(selectionFile, selectionBytes), archivePin, pin(selected.manifest, manifestBytes),
      pin(receiptFile, receiptBytes), pin(argumentFile, argumentBytes), pin(logFile, logBytes)] };
}

export async function compareDequeDiagnostics({ currentBuild, currentLog, baselineSelection, baselineLog }) {
  canonical(currentBuild); canonical(currentLog);
  const baseline = await readRelocatedDequeBaseline(baselineSelection, baselineLog);
  const receiptFile = path.join(currentBuild, 'compiler-build-receipt.json');
  const receiptBytes = await readRegular(receiptFile, 128 * 1024 * 1024), receipt = JSON.parse(receiptBytes);
  const argumentFile = path.join(currentBuild, 'compiler-klib.args');
  const argumentBytes = await readRegular(argumentFile, 16 * 1024 * 1024);
  const current = invocation(receipt, argumentBytes, currentBuild);
  const logBytes = await readRegular(currentLog, 64 * 1024 * 1024);
  const entries = parseDiagnosticLog(logBytes.toString(), currentBuild, current.sources);
  const comparison = qualifyDequeDiagnostics({ baseline: baseline.entries, current: entries,
    baselineSources: baseline.sources, currentSources: current.sources });
  assert.deepEqual(receipt.source, baseline.receipt.source, 'Official compiler source revision changed');
  assert.deepEqual(receipt.bootstrap, baseline.receipt.bootstrap, 'Official bootstrap compiler inputs changed');
  assert.deepEqual(receipt.hostLibraries, baseline.receipt.hostLibraries, 'Complete compiler host library metadata changed');
  const compilerPins = await compilerInputPins(current.command.command, current.args, receipt.bootstrap, receipt.hostLibraries);
  const normalizedCommand = (command, root) => {
    const result = [...command]; assert.equal(result.filter(value => value === '-cp').length, 1);
    result[result.indexOf('-cp') + 1] = result[result.indexOf('-cp') + 1].split(path.delimiter).map(filename => path.basename(filename)).join(path.delimiter);
    assert.equal(result.at(-1), '@' + path.join(root, 'compiler-klib.args')); result[result.length - 1] = '@<verified-args>';
    return result;
  };
  assert.deepEqual(normalizedCommand(current.command.command, currentBuild),
    normalizedCommand(baseline.command.command, baseline.originalBuildRoot), 'Non-classpath whole compiler command changed');
  for (const field of ['maximumHeap', 'timeoutMs']) assert.equal(current.command[field], baseline.command[field]);
  const projected = projectControlArguments(current.args, current.sources, baseline.originalSources, baseline.originalBuildRoot);
  const libraryNames = args => {
    const result = [...args]; assert.equal(result.filter(value => value === '-libraries').length, 1);
    const index = result.indexOf('-libraries') + 1;
    result[index] = result[index].split(path.delimiter).map(filename => path.basename(filename)).join(path.delimiter);
    return result;
  };
  assert.deepEqual(libraryNames(projected), libraryNames(baseline.args), 'Non-source whole compiler arguments changed');
  const sourcePins = [];
  for (let offset = 0; offset < current.sources.length; offset += 16) {
    const opened = await Promise.allSettled(current.sources.slice(offset, offset + 16).map(async (row, index) => {
      const prior = baseline.sources[offset + index];
      const before = await readRegular(prior.filename), after = await readRegular(row.filename);
      assert.deepEqual(identity(before), sourceIdentity(prior), 'Relocated baseline source differs from its authenticated archive');
      assert.deepEqual(identity(after), sourceIdentity(row), 'Actual current source differs from its compiler invocation');
      if (targets.has(row.path)) {
        assert.deepEqual(transformCommonDequeApi(row.path, after, { reverse: true }), before, 'Complete six-file inverse changed');
        assert.equal(before.toString().split('\n').length, after.toString().split('\n').length, 'Deque adaptation changed line count');
      } else assert.deepEqual(after, before, 'An untouched compiler source changed');
      return [pin(prior.filename, before), pin(row.filename, after)];
    }));
    for (const result of opened) { if (result.status !== 'fulfilled') throw result.reason; sourcePins.push(...result.value); }
  }
  return { schemaVersion: 1, kind: 'common-deque-api-exact-diagnostic-comparison', result: 'pass',
    currentBuild, currentLog, baselineSelection, baselineLog, ...comparison,
    inputs: [...baseline.inputs, pin(receiptFile, receiptBytes), pin(argumentFile, argumentBytes), pin(currentLog, logBytes),
      ...compilerPins, ...sourcePins],
    actualSourceFilesReopened: sourcePins.length, sixCompleteSourceInversesVerified: true,
    compilerLibraryPinsReopened: compilerPins.length, compilerLibraryBytesUnchanged: true,
    nonSourceOptionsHeapAndDeadlineUnchanged: true, commonAndPositionalSourceVectorsVerified: true,
    baselineReceiptAndArgumentsUnmodified: true, baselineRelocationExplicitAndAuthenticated: true,
    comparisonPolicy: 'Exactly 29 target diagnostics removed; every surviving source/line/column/message/multiplicity is unchanged. No diagnostic normalization or waiver.',
    fullCompilerBuilt: false, browserKotlinCompilation: false, publicLanguageSupport: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv[2], 'Usage: diagnostics.mjs CONFIGURATION_JSON');
  const configuration = JSON.parse(await readRegular(path.resolve(process.argv[2])));
  const result = await compareDequeDiagnostics(configuration);
  console.log(JSON.stringify(result));
}
