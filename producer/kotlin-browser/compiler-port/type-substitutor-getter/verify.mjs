import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { verifyTypeImplementationPreparation } from '../type-implementation/prepare.mjs';
import { verifyFinalTypeSubstitutorGetter } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
async function checked(filename, pin) {
    const bytes = await readRegular(filename, Math.max(pin.bytes, 64 * 1024 * 1024)); assert.equal(bytes.length, pin.bytes, filename); assert.equal(sha256(bytes), pin.sha256, filename); return bytes;
}
const seal = JSON.parse(await readRegular(path.join(HERE, 'evidence/seal.json')));
for (const pin of seal.files) await checked(path.join(HERE, pin.path), pin);
for (const pin of seal.externalArtifacts) await checked(pin.filename, pin);
for (const run of seal.runs) {
    const status = JSON.parse(await checked(run.status.filename, run.status)); assert.equal(status.exitCode, run.expectedExitCode); await checked(run.log.filename, run.log);
}
const runtime = JSON.parse(await readRegular(path.join(HERE, 'evidence/runtime.json'))), guards = JSON.parse(await readRegular(path.join(HERE, 'evidence/guards.json')));
assert.equal(runtime.result, 'pass'); assert.equal(runtime.observations, 6); assert.equal(runtime.originalObservationSha256, runtime.commonObservationSha256);
assert.equal(runtime.commands.filter(item => item.expectedExitCode === 1).length, 1);
assert(runtime.commands.every(item => item.exitCode === item.expectedExitCode));
for (const pin of runtime.artifacts) await checked(path.join(runtime.outputRoot, pin.path), pin);
await verifyTypeImplementationPreparation(path.join(runtime.outputRoot, 'types'));
const bootstrap = await verifyBootstrap(); assert.deepEqual(runtime.bootstrap.artifacts, bootstrap.artifacts);
assert.equal(guards.result, 'pass'); assert.equal(guards.checks.length, 12); assert.equal(guards.finalSources, guards.preparedSources + 1);
const preparedRoot = path.join(guards.outputRoot, 'prepared'), prepared = JSON.parse(await readRegular(path.join(preparedRoot, 'receipt.json'), 64 * 1024 * 1024));
const retainedSources = prepared.selectedInventory.map(item => guards.final.checked.find(pin => pin.path === item.path) ?? item);
retainedSources.push(guards.final.checked.find(item => item.path === 'compiler-port-type-substitutor-getter/TypeSubstitutorProperties.kt'));
const historicalBytes = await readRegular(path.join(guards.historical.outputRoot, 'compiler-build-receipt.json'), 64 * 1024 * 1024);
assert.equal(sha256(historicalBytes), guards.historical.receiptSha256);
assert.equal(sha256(await readRegular(path.join(guards.historical.outputRoot, 'compiler-klib.args'), 16 * 1024 * 1024)), guards.historical.argumentSha256);
const historical = JSON.parse(historicalBytes);
assert.deepEqual(await verifyFinalTypeSubstitutorGetter({ outputRoot: preparedRoot, retainedSources, recordedPropertyImports: historical.propertyImports.imports }), guards.final);
for (const key of ['fullCompilerBuilt', 'languageReadiness', 'fullCommonClassesWasmExecuted', 'fullConsumerClassesCompiled']) assert.equal(runtime[key], false);
console.log(JSON.stringify({ result: 'pass', observations: 6, guardTests: guards.checks.length, actualHistoricalSources: guards.preparedSources, fullCompilerBuilt: false }));
