import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
assert.equal(process.argv.length, 4, 'Usage: evidence.mjs RUNTIME_JOB_JSON GUARD_JOB_JSON');
async function pin(filename) { const bytes = await readRegular(filename, 64 * 1024 * 1024); return { filename, bytes: bytes.length, sha256: sha256(bytes) }; }
async function check(base, pins) {
    for (const item of pins) {
        const filename = item.filename ?? path.resolve(base, item.path), actual = await pin(filename);
        assert.equal(actual.bytes, item.bytes, filename); assert.equal(actual.sha256, item.sha256, filename);
    }
}
const records = [], receipts = [];
for (const [index, jobPath] of process.argv.slice(2).entries()) {
    const job = JSON.parse(await readRegular(jobPath)), status = JSON.parse(await readRegular(job.status));
    assert.equal(status.exitCode, 0); assert.equal(status.pid, job.pid); assert(status.durationSeconds > 0);
    assert(job.output.startsWith(path.join(REPO, 'out') + path.sep));
    assert.equal(job.argv[1], 'producer/kotlin-browser/compiler-port/ir-file-line-search/' + (index === 0 ? 'check.mjs' : 'integrity.test.mjs'));
    assert.equal(job.argv[2], job.output);
    const bytes = await readRegular(path.join(job.output, 'receipt.json'), 64 * 1024 * 1024), receipt = JSON.parse(bytes);
    assert.equal(receipt.kind, index === 0 ? 'genuine-ir-file-line-search-jvm-wasm-differential' : 'genuine-ir-file-line-search-integrity');
    assert.equal(receipt.fullCompilerBuilt, false); assert.equal(receipt.fullCommonClassWasmExecuted, index === 0); assert.equal(receipt.languageReadiness, false);
    await check(HERE, receipt.inputs);
    if (index === 0) {
        assert.equal(receipt.commands.length, 7); assert(receipt.commands.every(command => command.exitCode === 0));
        assert(receipt.comparison.records > 40000); assert.equal(receipt.comparison.normalizedText, false); assert.equal(receipt.comparison.originalJvmEqualsCommonJvm, true);
        await check(job.output, receipt.artifacts);
    } else {
        assert.equal(receipt.result, 'pass'); assert.equal(receipt.passed.length, 7); assert.equal(receipt.originalInventory.length, 3533);
        await check(REPO, receipt.originalInventory);
    }
    records.push({ job: await pin(jobPath), log: await pin(job.log), status: await pin(job.status), runner: await pin(job.runner),
        receipt: await pin(path.join(job.output, 'receipt.json')), processId: job.pid, outputRoot: job.output, exitCode: status.exitCode, durationSeconds: status.durationSeconds });
    receipts.push(bytes);
}
await mkdir(path.join(HERE, 'evidence'), { mode: 0o700 });
for (const [index, name] of ['differential.json', 'integrity.json'].entries()) {
    const target = path.join(HERE, 'evidence', name);
    const { writeFile } = await import('node:fs/promises'); await writeFile(target, receipts[index], { flag: 'wx', mode: 0o600 });
}
const currentFiles = [];
for (const name of ['prepare.mjs', 'transform.mjs', 'sources.lock.json', 'Probe.kt', 'JvmEntry.kt', 'WasmEntry.kt', 'check.mjs', 'integrity.test.mjs', 'evidence.mjs', 'README.md']) currentFiles.push(await pin(path.join(HERE, name)));
await writeJson(path.join(HERE, 'evidence', 'executions.json'), { schemaVersion: 1, kind: 'genuine-ir-file-line-search-completed-executions',
    result: 'pass', records, currentFiles, fullCommonClassWasmExecuted: true, fullCompilerBuilt: false, languageReadiness: false });
console.log(JSON.stringify({ result: 'pass', executions: records.length, currentFiles: currentFiles.length }));
