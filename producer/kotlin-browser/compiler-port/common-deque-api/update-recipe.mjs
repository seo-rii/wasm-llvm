#!/usr/bin/env node
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, relativePath, sha256, gitBlob, verifyFile } from '../../scripts/source.mjs';
import { TARGET as ENTRY } from '../official-main-entry/transform.mjs';
import { TARGETS, RECIPES, transformCommonDequeApi } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = { '--baseline': 'baseline', '--source-root': 'sourceRoot' }[process.argv[index]];
  assert(key && process.argv[index + 1] && !options[key], 'Required arguments: --baseline selection.json --source-root original-sources');
  options[key] = path.resolve(process.argv[index + 1]);
}
assert(options.baseline && options.sourceRoot, 'Both authenticated baseline graph and original source root are required');
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const primaryBytes = await readRegular(path.join(here, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
const mainBytes = await readRegular(path.join(here, '../official-main-entry/sources.lock.json')), main = JSON.parse(mainBytes);
const before = JSON.parse(verifyFile(await readRegular(path.join(here, '../official-main-entry/selection.lock.json')), main.selection));
const qualificationBytes = await readRegular(path.join(here, '../official-main-entry/evidence/current-foundation-v1.json'));
const qualification = JSON.parse(qualificationBytes);
assert.equal(qualification.result, 'pass');
assert.deepEqual(identity(mainBytes), { bytes: qualification.sourceLock.bytes, sha256: qualification.sourceLock.sha256 });
assert.equal(main.primaryClosureSha256, sha256(primaryBytes));
assert.deepEqual(before.source, primary.source); assert.equal(before.rows.length, 3571);
const rows = before.rows.map(row => row.path === ENTRY ? {
  ...row, ownerRelative: 'components/officialMainEntryReceipt/' + row.path,
  bytes: main.assembledOutput.bytes, sha256: main.assembledOutput.sha256,
} : row);
const fixture = JSON.parse(await readRegular(options.baseline, 4 * 1024 * 1024));
const buildRoot = fixture.buildRoot ?? fixture.baselineRoot;
assert(path.isAbsolute(buildRoot) && buildRoot === path.resolve(buildRoot));
assert.equal(fixture.retainedSources.length, rows.length);
const paths = new Set(), owners = new Set();
for (const [index, row] of fixture.retainedSources.entries()) {
  const selected = rows[index]; relativePath(selected.ownerRelative); relativePath(selected.path);
  assert.deepEqual(row, { path: selected.path, filename: path.join(buildRoot, selected.ownerRelative),
    bytes: selected.bytes, sha256: selected.sha256, compile: true }, 'Baseline must be the exact qualified official-main graph');
  assert(!paths.has(row.path) && !owners.has(row.filename)); paths.add(row.path); owners.add(row.filename);
}
for (let offset = 0; offset < rows.length; offset += 24) {
  const batch = await Promise.allSettled(fixture.retainedSources.slice(offset, offset + 24).map(async row => {
    assert.deepEqual(identity(await readRegular(row.filename)), { bytes: row.bytes, sha256: row.sha256 });
  }));
  for (const result of batch) if (result.status !== 'fulfilled') throw result.reason;
}
assert.equal(rows.filter(row => row.path.startsWith('compiler-port-jvm-descriptor-signatures/')).length, 18);
const files = [];
for (const logical of TARGETS) {
  const pin = primary.files.find(row => row.path === logical);
  assert(pin?.compile); const original = verifyFile(await readRegular(path.join(options.sourceRoot, logical)), pin);
  const rawOutgoing = transformCommonDequeApi(logical, original);
  assert.deepEqual(transformCommonDequeApi(logical, rawOutgoing, { reverse: true }), original);
  const row = fixture.retainedSources.find(row => row.path === logical), assembled = await readRegular(row.filename);
  const outgoing = transformCommonDequeApi(logical, assembled);
  assert.deepEqual(transformCommonDequeApi(logical, outgoing, { reverse: true }), assembled);
  files.push({ path: logical, original: { path: logical, ...identity(original), gitBlob: gitBlob(original) },
    rawOutgoing: { path: logical, ...identity(rawOutgoing) }, incoming: { path: logical, ...identity(assembled) },
    outgoing: { path: logical, ...identity(outgoing) } });
}
const selection = { schemaVersion: 1, kind: 'qualified-official-main-entry-output-selection', source: primary.source,
  foundationCommit: '6d520fcc01a5eedb2edeb83ae36dea72f7394850', compilerExitCode: 1,
  baselineDiagnosticCount: 1250, currentFoundationQualified: true, jvmSignatureSources: 18,
  officialMainSourceLockSha256: sha256(mainBytes), actualBuildReceipt: qualification.build.receipt,
  qualifiedEvidence: { path: '../official-main-entry/evidence/current-foundation-v1.json', ...identity(qualificationBytes) }, rows };
await writeFile(path.join(here, 'selection.lock.json'), JSON.stringify(selection, null, 2) + '\n');
async function pin(name) {
  const bytes = await readRegular(path.resolve(here, name));
  return { path: name, ...identity(bytes), gitBlob: gitBlob(bytes) };
}
const dependencyNames = new Set([
  'prepare.mjs', 'transform.mjs', 'update-recipe.mjs', 'selection.lock.json', '../../scripts/source.mjs', '../closure.lock.json',
  '../official-main-entry/prepare.mjs', '../official-main-entry/transform.mjs', '../official-main-entry/sources.lock.json',
  '../official-main-entry/selection.lock.json', '../official-main-entry/evidence/current-foundation-v1.json',
  ...main.dependencies.map(row => path.relative(here, path.resolve(here, '../official-main-entry', row.path))),
]);
const lock = { schemaVersion: 1, kind: 'common-deque-api-composition', source: primary.source,
  primaryClosureSha256: sha256(primaryBytes), targets: TARGETS, recipes: RECIPES, files,
  officialMainSourceLockSha256: sha256(mainBytes), selection: await pin('selection.lock.json'),
  recordedPropertyImports: main.recordedPropertyImports, dependencies: await Promise.all([...dependencyNames].map(pin)),
  scope: 'Six complete official compiler sources retain their algorithms and mixed-end traversal order while using common deque APIs',
  sourceSetExclusions: [], addedSources: [], userSourceRewritten: false, fullCompilerBuilt: false, publicLanguageSupport: false };
await writeFile(path.join(here, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n');
console.log(JSON.stringify({ sourceFiles: rows.length, replacements: files.length, added: 0, excluded: 0,
  baselineDiagnosticCount: 1250, jvmSignatureSources: 18, sourceLockSha256: sha256(await readRegular(path.join(here, 'sources.lock.json'))) }));
