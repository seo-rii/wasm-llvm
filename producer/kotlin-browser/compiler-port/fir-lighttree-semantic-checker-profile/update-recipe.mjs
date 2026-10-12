import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gitBlob, sha256, verifyFile } from '../../scripts/source.mjs';
import { normalizeImports } from '../klib-signature-index/transform.mjs';
import { selectedDeclarations } from '../backend-profile/references.mjs';
import { actualSelection } from '../fir-syntax-lighttree-profile/fixture.mjs';
import { TARGETS, REGISTRIES, SYMBOLS, BOUNDARIES, checkerChanges, applyCheckerChanges, checkerReferences } from './transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const buildRoot = path.resolve(process.argv[2] ?? path.join(REPO, 'out/kotlin-compiler-port/builds/closure-selection-whole-1791789518688526956'));
const primaryBytes = await readFile(path.join(HERE, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
const current = await actualSelection(buildRoot), imports = current.receipt.propertyImports.imports;
const dependencies = [];
for (const filename of ['prepare.mjs', 'transform.mjs', 'update-recipe.mjs', '../../scripts/source.mjs',
    '../fir-navigation/transform.mjs', '../fir-navigation/prepare.mjs', '../fir-navigation/sources.lock.json',
    '../fir-syntax-lighttree-profile/prepare.mjs', '../fir-syntax-lighttree-profile/sources.lock.json',
    '../native-js-output-profile/references.mjs', '../backend-profile/references.mjs', '../klib-signature-index/transform.mjs',
    '../host/prepare.mjs', '../host/sources.lock.json', '../host/patches/source-host.patch',
    '../positioning/prepare.mjs', '../positioning/positioning.recipe.json', '../entry/BrowserCompiler.kt', '../entry/BrowserCompilerPipeline.kt']) {
    const bytes = await readFile(path.join(HERE, filename)), pin = { path: filename, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) };
    verifyFile(bytes, pin); dependencies.push(pin);
}
const targets = TARGETS.map(p => primary.files.find(r => r.path === p)), registries = REGISTRIES.map(p => primary.files.find(r => r.path === p));
const changes = {}, outputs = [], originalDeclarations = {}, outputDeclarations = {};
for (const pin of targets) {
    const bytes = verifyFile(await readFile(path.join(REPO, 'out/kotlin-compiler-port/sources', pin.path)), pin);
    changes[pin.path] = checkerChanges(pin.path, bytes); const transformed = applyCheckerChanges(bytes, changes[pin.path]);
    assert.deepEqual(applyCheckerChanges(transformed, changes[pin.path], true), bytes);
    outputs.push({ path: pin.path, bytes: transformed.length, sha256: sha256(transformed) });
    originalDeclarations[pin.path] = selectedDeclarations(bytes.toString()); outputDeclarations[pin.path] = selectedDeclarations(transformed.toString());
}
const boundaries = [];
for (const logical of BOUNDARIES) {
    const row = current.retainedSources.find(r => r.path === logical); assert(row, 'Missing actual semantic checker boundary: ' + logical);
    const bytes = await readFile(row.filename); assert.equal(bytes.length, row.bytes); assert.equal(sha256(bytes), row.sha256);
    const canonical = normalizeImports(bytes, imports); boundaries.push({ path: logical, bytes: canonical.length, sha256: sha256(canonical) });
}
const syntax = JSON.parse(await readFile(path.join(HERE, '../fir-syntax-lighttree-profile/sources.lock.json')));
assert.deepEqual(boundaries.find(r => r.path === REGISTRIES[1]), syntax.outputs.find(r => r.path === REGISTRIES[1]));
assert.deepEqual(boundaries.find(r => r.path === REGISTRIES[0]), { path: REGISTRIES[0], bytes: registries[0].bytes, sha256: registries[0].sha256 });
const primaryReferences = [];
for (const pin of [...registries, ...targets].slice().sort((a, b) => a.path.localeCompare(b.path))) {
    const bytes = verifyFile(await readFile(path.join(REPO, 'out/kotlin-compiler-port/sources', pin.path)), pin);
    primaryReferences.push({ path: pin.path, names: checkerReferences(bytes.toString()) });
}
const lock = { schemaVersion: 1, kind: 'official-fir-lighttree-semantic-checker-profile', source: primary.source,
    primaryClosureSha256: sha256(primaryBytes), targets, registries, symbols: SYMBOLS, changes, outputs, originalDeclarations, outputDeclarations,
    primaryReferences, boundaries, dependencies, recordedPropertyImports: imports, sourceHostLockSha256: syntax.sourceHostLockSha256,
    frozenBuild: current.evidence, sourceSetExclusions: [], preservedRegistrations: true,
    scope: 'Exactly two complete FIR checker files; impossible PSI arms/imports and existing portable carrier bindings only',
    fullFirRuntime: false, fullCompilerBuilt: false, tokenMappingImplemented: false };
await writeFile(path.join(HERE, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n');
console.log(JSON.stringify({ outputs: outputs.length, spans: Object.values(changes).reduce((n, rows) => n + rows.length, 0), exclusions: 0, boundaries: boundaries.length }));
