import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
assert.equal(process.argv.length, 4, 'Usage: evidence.mjs RUNTIME_JOB_JSON GUARDS_JOB_JSON');
async function pin(filename) {
    const bytes = await readRegular(filename, 32 * 1024 * 1024);
    return { path: filename, bytes: bytes.length, sha256: sha256(bytes) };
}
async function verify(filename, expected) {
    const actual = await pin(filename); assert.equal(actual.bytes, expected.bytes); assert.equal(actual.sha256, expected.sha256, filename);
}
const jobs = [];
for (const [index, filename] of process.argv.slice(2).entries()) {
    const manifest = JSON.parse(await readRegular(filename)), status = JSON.parse(await readRegular(manifest.status));
    assert.equal(status.state, 'exited'); assert.equal(status.exitCode, 0); assert.equal(status.pid, manifest.pid);
    assert(manifest.output.startsWith(path.join(REPO, 'out') + path.sep));
    assert.equal(manifest.argv[1], 'producer/kotlin-browser/compiler-port/ir-interning/' + (index === 0 ? 'check.mjs' : 'integrity.test.mjs'));
    assert.equal(manifest.argv[2], manifest.output);
    const receipt = JSON.parse(await readRegular(path.join(manifest.output, 'receipt.json')));
    jobs.push({ manifest, status, receipt, execution: await Promise.all([filename, manifest.status, manifest.log, manifest.runner].map(pin)) });
}
const [runtime, guards] = jobs;
assert.equal(runtime.receipt.kind, 'genuine-complete-ir-interning-jvm-wasm-differential');
assert.equal(runtime.receipt.comparison.originalJvmEqualsCommonJvm, true);
assert.equal(runtime.receipt.comparison.originalJvmEqualsNodeWasm, true);
assert.equal(runtime.receipt.comparison.completeConsumerBodyPreserved, true);
assert.equal(runtime.receipt.comparison.genuineNameAndIrFileEntriesExecuted, true);
assert.equal(runtime.receipt.comparison.normalizedText, false);
assert(runtime.receipt.comparison.records > 30000);
assert.equal(runtime.receipt.commands.length, 8);
for (const command of runtime.receipt.commands) assert.equal(command.exitCode, 0);
for (const input of runtime.receipt.inputs) await verify(input.path, input);
for (const artifact of runtime.receipt.artifacts) await verify(path.join(runtime.manifest.output, artifact.path), artifact);
for (const name of ['original-observations.txt', 'common-observations.txt', 'wasm-observations.txt']) {
    const bytes = await readRegular(path.join(runtime.manifest.output, name));
    assert.equal(sha256(bytes), runtime.receipt.comparison.rawSha256);
    assert.equal(bytes.toString().trimEnd().split('\n').length, runtime.receipt.comparison.records);
}
assert.equal(guards.receipt.kind, 'genuine-ir-interning-integrity'); assert.equal(guards.receipt.result, 'pass');
assert.equal(guards.receipt.historical.selectedSources, 3533); assert.equal(guards.receipt.complete.length, 8);
for (const input of guards.receipt.inputs) await verify(path.join(HERE, input.path), input);
for (let offset = 0; offset < guards.receipt.originalInventory.length; offset += 24) {
    const checked = await Promise.allSettled(guards.receipt.originalInventory.slice(offset, offset + 24).map(input => verify(input.filename, input)));
    for (const result of checked) if (result.status !== 'fulfilled') throw result.reason;
}
const currentFiles = ['CanonicalInterningSet.kt', 'transform.mjs', 'prepare.mjs', 'sources.lock.json', 'Probe.kt', 'JvmEntry.kt', 'WasmEntry.kt', 'PrimitiveSearchBoundary.kt', 'check.mjs', 'integrity.test.mjs', 'evidence.mjs', 'README.md'];
const current = await Promise.all(currentFiles.map(name => pin(path.join(HERE, name))));
const sourceLock = await readRegular(path.join(HERE, 'sources.lock.json'));
assert.equal(sha256(sourceLock), runtime.receipt.sourceLockSha256);
await mkdir(path.join(HERE, 'evidence'), { mode: 0o700 });
await writeJson(path.join(HERE, 'evidence/differential.json'), runtime.receipt);
await writeJson(path.join(HERE, 'evidence/integrity.json'), guards.receipt);
await writeJson(path.join(HERE, 'evidence/execution.json'), { schemaVersion: 1, kind: 'genuine-ir-interning-evidence-execution',
    runtime: { ...runtime.manifest, statusResult: runtime.status, pins: runtime.execution,
        receipt: await pin(path.join(runtime.manifest.output, 'receipt.json')) },
    guards: { ...guards.manifest, statusResult: guards.status, pins: guards.execution,
        receipt: await pin(path.join(guards.manifest.output, 'receipt.json')) },
    current, exactRawReceiptsCopied: true, fullCompilerBuilt: false, languageReadiness: false });
console.log(JSON.stringify({ records: runtime.receipt.comparison.records, guards: guards.receipt.complete.length, originalSources: guards.receipt.historical.selectedSources }));
