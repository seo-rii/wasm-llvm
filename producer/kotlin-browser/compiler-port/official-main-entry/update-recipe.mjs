import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, relativePath, sha256, gitBlob } from '../../scripts/source.mjs';
import { normalizeImports } from '../klib-signature-index/transform.mjs';
import { exceptionChanges, transform as transformException } from '../compiler-exception-attachment-profile/transform.mjs';
import { readQualifiedTowerPredecessor } from './fixture.mjs';
import { TARGET, TARGETS, RECIPE, OFFICIAL_LINKAGE, OFFICIAL_PHASE_TAIL, transformOfficialMainEntry } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
assert(process.argv[2], 'Pass the actual qualified post-tower 1250-diagnostic 3571-source predecessor build root');
const before = await readQualifiedTowerPredecessor(process.argv[2]);
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const primaryBytes = await readRegular(path.join(here, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
assert.deepEqual(before.receipt.source, primary.source);
const rows = before.retainedSources, paths = new Set(), owners = new Set();
for (const row of rows) {
  assert.deepEqual(Object.keys(row), ['path', 'filename', 'bytes', 'sha256', 'compile']);
  relativePath(row.path); assert.equal(row.compile, true);
  assert(!paths.has(row.path) && !owners.has(row.filename)); paths.add(row.path); owners.add(row.filename);
}
for (let offset = 0; offset < rows.length; offset += 24) {
  const batch = await Promise.allSettled(rows.slice(offset, offset + 24).map(async row => {
    const bytes = await readRegular(row.filename);
    assert.deepEqual(identity(bytes), { bytes: row.bytes, sha256: row.sha256 });
  }));
  for (const result of batch) if (result.status !== 'fulfilled') throw result.reason;
}
const selection = { schemaVersion: 1, kind: 'actual-current-foundation-official-main-entry-selection', source: primary.source,
  compilerExitCode: 1, baselineDiagnosticCount: 1250, currentFoundationQualified: true, ...before.identities, jvmSignatureSources: 18,
  rows: rows.map(row => {
    const ownerRelative = path.relative(before.buildRoot, row.filename); relativePath(ownerRelative);
    return { path: row.path, ownerRelative, bytes: row.bytes, sha256: row.sha256, compile: row.compile };
  }) };
const rawTemplate = await readRegular(path.join(here, '../entry/BrowserCompilerPipeline.kt'));
const original = transformException(rawTemplate, exceptionChanges(TARGET, rawTemplate));
const selectedTarget = await readRegular(rows.find(row => row.path === TARGET).filename);
assert.deepEqual(normalizeImports(selectedTarget, before.recordedPropertyImports), original,
  'The complete post-tower predecessor must preserve the exact previous exception-scoped entry');
const transformed = transformOfficialMainEntry(TARGET, original), assembled = transformOfficialMainEntry(TARGET, selectedTarget);
assert.deepEqual(transformOfficialMainEntry(TARGET, transformed, { reverse: true }), original);
assert.deepEqual(transformOfficialMainEntry(TARGET, assembled, { reverse: true }), selectedTarget);
const towerLockBytes = await readRegular(path.join(here, '../fir-tower-mode-map/sources.lock.json')), towerLock = JSON.parse(towerLockBytes);
assert.equal(sha256(towerLockBytes), before.receipt.firTowerModeMapReceipt.sourceLockSha256);
await writeFile(path.join(here, 'selection.lock.json'), JSON.stringify(selection, null, 2) + '\n');
async function pin(name) {
  const bytes = await readRegular(path.resolve(here, name));
  return { path: name, ...identity(bytes), gitBlob: gitBlob(bytes) };
}
// Pin only this recipe and immutable predecessor boundaries. New whole-build,
// native phase integration, runtime observations and aggregate proof are owned
// separately and cannot silently become trusted source-composition inputs.
const dependencyNames = new Set([
  'prepare.mjs', 'transform.mjs', 'update-recipe.mjs', 'fixture.mjs', 'selection.lock.json',
  '../../scripts/source.mjs', '../closure.lock.json', '../entry/BrowserCompilerPipeline.kt',
  '../klib-signature-index/transform.mjs', '../compiler-exception-attachment-profile/transform.mjs',
  '../fir-tower-mode-map/sources.lock.json', '../fir-tower-mode-map/evidence/current-foundation-v1.json',
  ...towerLock.dependencies.map(row => path.relative(here, path.resolve(here, '../fir-tower-mode-map', row.path))),
]);
const dependencies = await Promise.all([...dependencyNames].map(pin));
const lock = { schemaVersion: 1, kind: 'official-main-entry-composition', source: primary.source,
  primaryClosureSha256: sha256(primaryBytes), targets: TARGETS, recipes: RECIPE,
  officialPhases: { linkage: OFFICIAL_LINKAGE, tail: OFFICIAL_PHASE_TAIL }, rawTemplate: await pin('../entry/BrowserCompilerPipeline.kt'),
  incoming: { path: TARGET, ...identity(original) }, outgoing: { path: TARGET, ...identity(transformed) },
  assembledOutput: { path: TARGET, ...identity(assembled) }, selection: await pin('selection.lock.json'),
  recordedPropertyImports: before.recordedPropertyImports, towerSourceLockSha256: sha256(towerLockBytes), dependencies,
  scope: 'One complete production entry removes only the custom pre-lowering main gate; official phases remain byte-identical',
  sourceSetExclusions: [], addedSources: [], handwrittenEntrySelectorOrWrapperAdded: false,
  fullCompilerBuilt: false, publicLanguageSupport: false };
await writeFile(path.join(here, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n');
console.log(JSON.stringify({ sourceFiles: rows.length, replacements: 1, added: 0, excluded: 0,
  baselineDiagnosticCount: 1250, jvmSignatureSources: 18, predecessorReceiptSha256: before.identities.actualBuildReceipt.sha256,
  sourceLockSha256: sha256(await readRegular(path.join(here, 'sources.lock.json'))) }));
