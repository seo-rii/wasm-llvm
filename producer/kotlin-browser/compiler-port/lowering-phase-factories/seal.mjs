import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, gitBlob, writeJson } from '../../scripts/source.mjs';
import { TARGETS, HELPER, RECIPE, transformLoweringPhaseSource } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
const originals = TARGETS.map(name => closure.files.find(pin => pin.path === name)), outputs = [];
for (const pin of originals) {
    const bytes = await readRegular(path.join(REPO, 'out/kotlin-compiler-port/sources', pin.path)); assert.equal(sha256(bytes), pin.sha256);
    const common = transformLoweringPhaseSource(pin.path, bytes); outputs.push({ path: pin.path, bytes: common.length, sha256: sha256(common), gitBlob: gitBlob(common) });
}
const helper = await readRegular(path.join(HERE, 'LoweringPassFactory.kt')); outputs.push({ path: HELPER, bytes: helper.length, sha256: sha256(helper), gitBlob: gitBlob(helper) });
const callSites = JSON.parse(await readRegular(path.join(HERE, 'call-sites.json')));
const declarationFiles = [...new Set(callSites.flatMap(row => row.classDeclarations.map(declaration => declaration.path)))].sort().map(name => closure.files.find(pin => pin.path === name));
assert(declarationFiles.every(Boolean));
const dependencies = [];
for (const name of ['prepare.mjs', 'transform.mjs', 'recipes.json', 'call-sites.json', 'LoweringPassFactory.kt', '../../scripts/source.mjs', '../tower-group/transform.mjs']) {
    const bytes = await readRegular(path.join(HERE, name)); dependencies.push({ path: name, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) });
}
await writeJson(path.join(HERE, 'sources.lock.json'), { schemaVersion: 1, kind: 'genuine-lowering-phase-factory-metadata', source: closure.source,
    primaryClosureSha256: sha256(closureBytes), originals, outputs, recipes: RECIPE, callSites, declarationFiles,
    missingNativeDeclarations: [...new Set(callSites.filter(row => !row.classDeclarations.length).map(row => row.rawClass))], dependencies });
