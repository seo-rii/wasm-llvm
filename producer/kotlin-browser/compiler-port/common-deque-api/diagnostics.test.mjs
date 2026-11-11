import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../../scripts/source.mjs';
import { TARGETS } from './transform.mjs';
import { EXPECTED_DEQUE_DIAGNOSTICS, REMAINING_DEQUE_DIAGNOSTICS, parseDiagnosticLog,
  qualifyDequeDiagnostics, readRelocatedDequeBaseline } from './diagnostics.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const selection = JSON.parse(await readFile(path.join(here, '../official-main-entry/selection.lock.json')));
const targets = new Set(TARGETS);
const oldRoot = '/diagnostic-test/baseline', newRoot = '/diagnostic-test/current';
const outside = selection.rows.find(row => !targets.has(row.path)).path;

function fixture() {
  const baselineSources = selection.rows.map(row => ({ path: row.path, filename: path.join(oldRoot, row.ownerRelative),
    bytes: row.bytes, sha256: row.sha256, compile: true }));
  const currentSources = baselineSources.map(row => ({ ...row, filename: row.filename.replace(oldRoot, newRoot),
    ...(targets.has(row.path) ? { bytes: row.bytes + 1, sha256: sha256(Buffer.from('policy-test-output:' + row.path)) } : {}) }));
  // Deliberate repeated entries exercise multiset accounting. These are policy
  // unit fixtures, not claimed observations from a real compiler execution.
  const unchanged = Array.from({ length: 1217 }, () => ({ source: outside, line: 18, column: 7, message: 'existing fixture failure' }));
  const removed = Array.from({ length: 29 }, (_, index) => ({ source: TARGETS[index % TARGETS.length],
    line: 500 + index, column: 9, message: 'existing deque fixture failure ' + index }));
  const baseline = [...unchanged, ...structuredClone(REMAINING_DEQUE_DIAGNOSTICS), ...removed];
  const current = [...structuredClone(unchanged), ...structuredClone(REMAINING_DEQUE_DIAGNOSTICS)];
  return { baselineSources, currentSources, baseline, current };
}

test('fixed policy requires six full files, 29 removals and the four exact unresolved host sites', () => {
  const result = qualifyDequeDiagnostics(fixture());
  assert.deepEqual(result.expected, EXPECTED_DEQUE_DIAGNOSTICS);
  assert.equal(result.removedDiagnostics.length, 29);
  assert.deepEqual(result.newDiagnostics, []); assert.deepEqual(result.diagnosticWaivers, []);
  assert.equal(result.unchangedSourceCount, 3565);
});

const rejections = [
  ['compiler source omitted', f => f.currentSources.pop()],
  ['compiler source added', f => f.currentSources.push({ ...f.currentSources[0] })],
  ['compiler source order changed', f => [f.currentSources[0], f.currentSources[1]] = [f.currentSources[1], f.currentSources[0]]],
  ['duplicate logical source', f => f.currentSources[1].path = f.currentSources[0].path],
  ['duplicate absolute owner', f => f.currentSources[1].filename = f.currentSources[0].filename],
  ['relative compiler owner', f => f.currentSources[0].filename = 'sources/relative.kt'],
  ['noncanonical compiler owner', f => f.currentSources[0].filename = '/diagnostic-test/current/../relative.kt'],
  ['traversing logical source', f => f.currentSources[0].path = '../outside.kt'],
  ['inactive selected source', f => f.currentSources[0].compile = false],
  ['invalid digest', f => f.currentSources[0].sha256 = 'not-sha256'],
  ['invalid byte count', f => f.currentSources[0].bytes = -1],
  ['unchanged source byte count drift', f => f.currentSources.find(row => !targets.has(row.path)).bytes++],
  ['unchanged source digest drift', f => f.currentSources.find(row => !targets.has(row.path)).sha256 = 'f'.repeat(64)],
  ['target not transformed', f => {
    const row = f.currentSources.find(row => targets.has(row.path)), before = f.baselineSources.find(item => item.path === row.path);
    row.bytes = before.bytes; row.sha256 = before.sha256;
  }],
  ['JVM signature removed from both vectors', f => {
    for (const rows of [f.baselineSources, f.currentSources]) rows.find(row => row.path.startsWith('compiler-port-jvm-descriptor-signatures/')).path = 'changed-signature.kt';
  }],
  ['unselected diagnostic owner', f => f.current[0].source = 'never-compiled.kt'],
  ['invalid diagnostic line', f => f.current[0].line = 0],
  ['invalid diagnostic column', f => f.current[0].column = 1.5],
  ['empty diagnostic text', f => f.current[0].message = ''],
  ['surviving line drift', f => f.current[0].line++],
  ['surviving column drift', f => f.current[0].column++],
  ['surviving message drift', f => f.current[0].message += ' changed'],
  ['surviving logical source drift', f => f.current[0].source = f.currentSources.find(row => !targets.has(row.path) && row.path !== outside).path],
  ['diagnostic multiplicity drift', f => f.current.pop()],
  ['extra current diagnostic', f => f.current.push({ ...f.current[0] })],
  ['extra baseline diagnostic', f => f.baseline.push({ ...f.baseline[0] })],
  ['unrelated target file failure removed', f => f.current[1217] = { ...f.baseline.at(-1) }],
  ['unrelated target reflection column moved', f => f.current.at(-1).column++],
  ['outside failure removed while target failure returns', f => f.current[0] = { ...f.baseline.at(-1) }],
  ['duplicate remaining failure hiding another', f => f.current.at(-1).message = f.current.at(-2).message],
];
for (const [name, mutate] of rejections) test('reject ' + name, () => {
  const data = fixture(); mutate(data); assert.throws(() => qualifyDequeDiagnostics(data));
});

test('log reader binds relative and absolute locations to actual selected owners', () => {
  const data = fixture(), owner = data.baselineSources[0];
  const entries = parseDiagnosticLog(`${path.relative(oldRoot, owner.filename)}:1:2: error: first\n${owner.filename}:3:4: error: second\n`,
    oldRoot, data.baselineSources);
  assert.deepEqual(entries, [{ source: owner.path, line: 1, column: 2, message: 'first' },
    { source: owner.path, line: 3, column: 4, message: 'second' }]);
});
for (const crash of ['Exception in thread "main" java.lang.IllegalStateException', 'java.lang.OutOfMemoryError: Java heap space',
  'java.lang.StackOverflowError', 'Internal compiler error', 'exception: crashed']) {
  test('reject compiler crash marker ' + crash.split(':')[0], () => {
    const data = fixture(), owner = data.baselineSources[0];
    assert.throws(() => parseDiagnosticLog(`${owner.filename}:1:1: error: existing\n${crash}\n`, oldRoot, data.baselineSources), /crash/);
  });
}
test('reject diagnostic in a file outside actual compiler arguments', () => {
  assert.throws(() => parseDiagnosticLog('sources/unselected.kt:1:1: error: invalid\n', oldRoot, fixture().baselineSources), /actual compiler input/);
});
test('reject an empty failed-compiler log', () => assert.throws(() => parseDiagnosticLog('compiler finished\n', oldRoot, fixture().baselineSources), /observable diagnostics/));
test('compiler-wide errors remain explicit entries', () => {
  assert.deepEqual(parseDiagnosticLog('error: library missing\n', oldRoot, fixture().baselineSources),
    [{ source: '<compiler>', line: 0, column: 0, message: 'library missing' }]);
});
test('baseline relocation requires a canonical existing bounded descriptor', async () => {
  await assert.rejects(readRelocatedDequeBaseline('relative.json', '/baseline.log'), /Canonical/);
});
