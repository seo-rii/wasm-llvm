import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, relativePath, sha256, gitBlob, verifyFile } from '../../scripts/source.mjs';
import { normalizeImports } from '../klib-signature-index/transform.mjs';
import { readQualifiedPsiPredecessor } from './fixture.mjs';
import { TARGET, TARGETS, MODES, RECIPE, transformTowerModeMap } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
assert(process.argv[2], 'Pass the actual qualified post-PSI 3571-source predecessor build root');
const before = await readQualifiedPsiPredecessor(process.argv[2]);
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
const selection = { schemaVersion: 1, kind: 'actual-current-foundation-fir-tower-mode-map-selection', source: primary.source,
  compilerExitCode: 1, currentFoundationQualified: true, ...before.identities, jvmSignatureSources: 18,
  rows: rows.map(row => {
    const ownerRelative = path.relative(before.buildRoot, row.filename); relativePath(ownerRelative);
    return { path: row.path, ownerRelative, bytes: row.bytes, sha256: row.sha256, compile: row.compile };
  }) };
const targetPin = primary.files.find(row => row.path === TARGET);
const original = verifyFile(await readRegular(path.join(before.sourceRoot, TARGET)), targetPin);
const selectedTarget = await readRegular(rows.find(row => row.path === TARGET).filename);
assert.deepEqual(normalizeImports(selectedTarget, before.recordedPropertyImports), original,
  'The complete post-PSI tower predecessor must still be the exact original algorithm');
const transformed = transformTowerModeMap(TARGET, original), assembled = transformTowerModeMap(TARGET, selectedTarget);
assert.deepEqual(transformTowerModeMap(TARGET, transformed, { reverse: true }), original);
assert.deepEqual(transformTowerModeMap(TARGET, assembled, { reverse: true }), selectedTarget);
const psiLockBytes = await readRegular(path.join(here, '../fir-lighttree-psi-views/sources.lock.json')), psiLock = JSON.parse(psiLockBytes);
assert.equal(sha256(psiLockBytes), before.receipt.firLightTreePsiViewsReceipt.sourceLockSha256);
await writeFile(path.join(here, 'selection.lock.json'), JSON.stringify(selection, null, 2) + '\n');
async function pin(name) {
  const bytes = await readRegular(path.resolve(here, name));
  return { path: name, ...identity(bytes), gitBlob: gitBlob(bytes) };
}
const dependencyNames = new Set([
  'prepare.mjs', 'transform.mjs', 'update-recipe.mjs', 'fixture.mjs', 'selection.lock.json',
  '../../scripts/source.mjs', '../closure.lock.json', '../klib-signature-index/transform.mjs',
  '../fir-lighttree-psi-views/sources.lock.json', '../fir-lighttree-psi-views/evidence/current-foundation-v1.json',
  ...psiLock.dependencies.map(row => path.relative(here, path.resolve(here, '../fir-lighttree-psi-views', row.path))),
]);
const dependencies = await Promise.all([...dependencyNames].map(pin));
const lock = { schemaVersion: 1, kind: 'fir-private-tower-mode-map', source: primary.source,
  primaryClosureSha256: sha256(primaryBytes), targets: [targetPin], modes: MODES, recipes: RECIPE,
  incoming: { path: TARGET, ...identity(original) }, outgoing: { path: TARGET, ...identity(transformed) },
  assembledOutput: { path: TARGET, ...identity(assembled) }, selection: await pin('selection.lock.json'),
  recordedPropertyImports: before.recordedPropertyImports, psiSourceLockSha256: sha256(psiLockBytes), dependencies,
  scope: 'One complete private FIR tower mode map; exact six modes and nullable values; no general EnumMap port',
  sourceSetExclusions: [], addedSources: [], fullFirToIrWasmExecuted: false, fullCompilerBuilt: false, publicLanguageSupport: false };
assert.deepEqual(lock.targets.map(row => row.path), TARGETS);
await writeFile(path.join(here, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n');
console.log(JSON.stringify({ sourceFiles: rows.length, replacements: 1, added: 0, excluded: 0,
  jvmSignatureSources: 18, predecessorReceiptSha256: before.identities.actualBuildReceipt.sha256,
  sourceLockSha256: sha256(await readRegular(path.join(here, 'sources.lock.json'))) }));
