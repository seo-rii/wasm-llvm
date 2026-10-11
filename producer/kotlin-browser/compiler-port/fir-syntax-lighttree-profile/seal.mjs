import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../../scripts/source.mjs';
import { normalizeImports } from '../klib-signature-index/transform.mjs';
import { selectedDeclarations } from '../backend-profile/references.mjs';
import { BASE, EXCLUDED, FAMILY, REPLACED, HOST, ENTRY, PIPELINE, PARSER, SYMBOLS, referenceNames, syntaxChanges, applyChanges, expandObjectImports } from './transform.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../../../..');
const primaryBytes = await readFile(path.join(here, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
const sourceRoot = path.join(repo, 'out/kotlin-compiler-port/sources');
const buildRoot = path.join(repo, 'out/kotlin-compiler-port/builds/memory-host-whole-1791700702126849235');
const receiptBytes = await readFile(path.join(buildRoot, 'compiler-build-receipt.json')), receipt = JSON.parse(receiptBytes);
const args = (await readFile(path.join(buildRoot, 'compiler-klib.args'), 'utf8')).trimEnd().split('\n').map(JSON.parse);
const filenames = args.slice(-receipt.compileSources.length), retained = receipt.compileSources.map((r, i) => ({...r, filename:filenames[i]}));
const identity = bytes => ({bytes:bytes.length,sha256:sha256(bytes)});
const selected = new Map();
for (const row of retained) { const bytes = await readFile(row.filename); assert.deepEqual(identity(bytes), {bytes:row.bytes,sha256:row.sha256}); selected.set(row.path, normalizeImports(bytes, receipt.propertyImports.imports)); }
const sources = [], changes = {}, outputs = [], declarationInventory = {};
for (const logical of [...FAMILY, ...REPLACED.filter(p => !FAMILY.includes(p))]) {
    const pin = primary.files.find(r => r.path === logical); assert(pin); const original = await readFile(path.join(sourceRoot, logical));
    assert.deepEqual(identity(original), {bytes:pin.bytes,sha256:pin.sha256}); sources.push(pin); declarationInventory[logical] = selectedDeclarations(original.toString());
    assert.deepEqual(selected.get(logical), expandObjectImports(original, receipt.staticImportBindings.objectOwners), 'Actual prior assembled algorithm differs: ' + logical);
    if (logical === EXCLUDED) continue;
    changes[logical] = syntaxChanges(logical, original); const output = applyChanges(original, changes[logical]);
    assert.deepEqual(applyChanges(output, changes[logical], true), original); outputs.push({path:logical,...identity(output)});
}
const boundaries = [];
for (const [logical, bytes] of selected) if ((!FAMILY.includes(logical) && !REPLACED.includes(logical) && referenceNames(bytes.toString()).length) || [HOST, ENTRY, PIPELINE, PARSER].includes(logical))
    boundaries.push({path:logical,...identity(bytes),references:referenceNames(bytes.toString())});
const deps = ['transform.mjs', '../fir-navigation/transform.mjs', '../native-js-output-profile/references.mjs', '../backend-profile/references.mjs', '../klib-signature-index/transform.mjs', '../host/prepare.mjs', '../host/sources.lock.json', '../host/patches/source-host.patch', '../entry/BrowserCompiler.kt', '../entry/BrowserCompilerPipeline.kt', '../positioning/positioning.recipe.json'];
const dependencies = [];
for (const logical of deps) dependencies.push({path:logical,...identity(await readFile(path.join(here,logical)))});
const lock = {schemaVersion:1,kind:'official-fir-syntax-lighttree-source-profile',source:primary.source,primaryClosureSha256:sha256(primaryBytes),sources,outputs,changes,declarationInventory,
    symbols:SYMBOLS, family:FAMILY, replacedOriginalPaths:REPLACED, sourceSetExclusions:[EXCLUDED], dependencies, boundaries,
    recordedPropertyImports:receipt.propertyImports.imports, objectOwners:receipt.staticImportBindings.objectOwners,
    sourceHostLockSha256:receipt.sourceHostReceipt.sourceLockSha256,
    frozenBuild:{filename:path.join(buildRoot,'compiler-build-receipt.json'),...identity(receiptBytes),selectedSources:retained.length},
    limitations:{fullFirRuntime:false,fullCompilerBuilt:false,kmpLiteralAffixDiagnosticParity:false}};
await writeFile(path.join(here,'sources.lock.json'),JSON.stringify(lock,null,2)+'\n');
console.log(JSON.stringify({sources:sources.length,outputs:outputs.length,excluded:1,boundaries:boundaries.length,spans:Object.values(changes).reduce((n,c)=>n+c.length,0)}));
