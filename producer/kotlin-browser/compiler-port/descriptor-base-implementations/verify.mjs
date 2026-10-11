import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { verifyDescriptorBaseImplementations } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const seal = JSON.parse(await readRegular(path.join(HERE, 'evidence/seal.json')));
async function checked(filename, pin) { const bytes = await readRegular(filename, Math.max(pin.bytes, 64 * 1024 * 1024)); assert.equal(bytes.length, pin.bytes, filename); assert.equal(sha256(bytes), pin.sha256, filename); return bytes; }
for (const pin of seal.files) await checked(path.join(HERE, pin.path), pin);
for (const run of seal.runs) {
    const status = JSON.parse(await checked(run.status.filename, run.status));
    assert.equal(status.exitCode, run.expectedExitCode); await checked(run.log.filename, run.log);
}
const runtime = JSON.parse(await readRegular(path.join(HERE, 'evidence/runtime.json')));
assert.equal(runtime.result, 'pass'); assert.equal(runtime.observations, 38);
assert(runtime.commands.every(command => command.exitCode === 0));
for (const pin of runtime.filePins) await checked(pin.filename, pin);
for (const pin of runtime.artifacts) await checked(path.join(runtime.outputRoot, pin.path), pin);
assert.deepEqual(await verifyDescriptorBaseImplementations(path.join(runtime.outputRoot, 'prepared')), runtime.preparation);
const bootstrap = await verifyBootstrap(); assert.deepEqual(runtime.bootstrap.artifacts, bootstrap.artifacts);
const chain = JSON.parse(await readRegular(path.join(HERE, 'evidence/chain.json'), 64 * 1024 * 1024));
assert.equal(chain.result, 'pass'); assert.equal(chain.actualHistoricalSources, 3525); assert.equal(chain.finalSources, 3527);
assert.equal(chain.allHistoricalBytesUnchanged, true);
for (const key of ['fullCompilerBuilt', 'languageReadiness']) { assert.equal(chain[key], false); assert.equal(runtime[key], false); }
for (const pin of seal.externalArtifacts) await checked(pin.filename, pin);
console.log(JSON.stringify({ result: 'pass', observations: runtime.observations, integrityTests: 10, actualHistoricalSources: chain.actualHistoricalSources, finalSources: chain.finalSources, fullCompilerBuilt: false }));
