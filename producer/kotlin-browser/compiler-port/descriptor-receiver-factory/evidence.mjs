import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
async function pin(filename) { const bytes = await readRegular(filename, 100 * 1024 * 1024); return { filename, bytes: bytes.length, sha256: sha256(bytes) }; }
async function verify(record, root) {
    const actual = await pin(record.filename ?? path.join(root, record.path));
    assert.equal(actual.bytes, record.bytes); assert.equal(actual.sha256, record.sha256); return actual;
}
const directory = path.join(HERE, 'evidence'); await mkdir(directory, { mode: 0o700 });
const jobs = {}, verified = {};
for (const name of ['runtime', 'guards']) {
    const jobFile = '/tmp/kotlin-descriptor-receiver-' + name + '-job.json', job = JSON.parse(await readRegular(jobFile));
    const status = JSON.parse(await readRegular(job.status)); assert.equal(status.state, 'exited'); assert.equal(status.exitCode, 0); assert.equal(status.pid, job.pid);
    let receipts;
    if (name === 'runtime') {
        const file = path.join(job.output, 'receipt.json'), bytes = await readRegular(file, 64 * 1024 * 1024), receipt = JSON.parse(bytes);
        assert.equal(receipt.result, 'pass'); assert(receipt.commands.every(command => command.exitCode === 0)); assert.equal(receipt.observations, 32);
        const archiveFile = path.join(job.output, 'input-archive/manifest.json'), archives = JSON.parse(await readRegular(archiveFile));
        assert.equal(archives.length, 1); assert.equal(archives[0].sourceFilename, path.join(HERE, 'sources.lock.json'));
        const historicalLock = receipt.filePins.find(pin => pin.filename === archives[0].sourceFilename);
        assert(historicalLock); assert.equal(historicalLock.bytes, archives[0].archivePin.bytes); assert.equal(historicalLock.sha256, archives[0].archivePin.sha256);
        await verify(archives[0].archivePin);
        const records = async variant => (await readRegular(path.join(job.output, variant + '-observe.stdout'))).toString().trimEnd().split('\n').filter(row => row.startsWith('record:'));
        const original = await records('original'), common = await records('common'); assert.deepEqual(common, original); assert.equal(common.length, receipt.observations);
        assert.equal(sha256(Buffer.from(common.join('\n'))), receipt.comparedRecordsSha256);
        for (const record of receipt.filePins) {
            const archive = archives.find(item => item.sourceFilename === record.filename);
            if (archive) { assert.equal(record.bytes, archive.archivePin.bytes); assert.equal(record.sha256, archive.archivePin.sha256); await verify(archive.archivePin); }
            else await verify(record, job.output);
        }
        for (const record of receipt.artifacts) await verify(record, job.output);
        await writeFile(path.join(directory, 'runtime.json'), bytes, { flag: 'wx', mode: 0o600 });
        verified.runtime = { inputPins: receipt.filePins.length, artifactPins: receipt.artifacts.length, rawRecords: common.length };
        job.inputArchives = archives; job.archiveManifestPin = await pin(archiveFile);
        receipts = [await pin(file)];
    } else {
        receipts = [];
        for (const name of ['late', 'early']) {
            const file = path.join(job.output, name + '-proof.json'), bytes = await readRegular(file), receipt = JSON.parse(bytes); assert.equal(receipt.result, 'pass');
            await writeFile(path.join(directory, name + '.json'), bytes, { flag: 'wx', mode: 0o600 }); receipts.push(await pin(file));
        }
        const log = (await readRegular(job.log)).toString(); assert(log.includes('pass 2')); assert(log.includes('fail 0')); assert(log.includes('skipped 0'));
    }
    jobs[name] = { ...job, execution: status, receipts, jobPin: await pin(jobFile), logPin: await pin(job.log), statusPin: await pin(job.status), runnerPin: await pin(job.runner) };
}
const currentFiles = [];
for (const item of await readdir(HERE, { withFileTypes: true })) if (item.isFile()) currentFiles.push(await pin(path.join(HERE, item.name)));
await writeJson(path.join(directory, 'executions.json'), { schemaVersion: 1, kind: 'genuine-descriptor-receiver-factory-completed-executions', jobs, verified, currentFiles,
    fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false });
console.log(JSON.stringify({ result: 'pass', verified, currentFiles: currentFiles.length }));
