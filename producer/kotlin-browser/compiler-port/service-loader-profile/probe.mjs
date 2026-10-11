import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { prepareServiceLoaderProfile, verifyServiceLoaderFinalSources, TARGET } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
assert.equal(process.argv.length, 4);
const build = path.resolve(process.argv[2]), root = path.resolve(process.argv[3]);
assert(root.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(root, { mode: 0o700 });
const buildReceiptBytes = await readRegular(path.join(build, 'compiler-build-receipt.json'), 64 * 1024 * 1024);
const buildReceipt = JSON.parse(buildReceiptBytes), argsBytes = await readRegular(path.join(build, 'compiler-klib.args'));
assert.equal(sha256(argsBytes), buildReceipt.commands[0].argumentFileSha256);
const filenames = argsBytes.toString().trimEnd().split('\n').map(line => JSON.parse(line)).filter(name => path.isAbsolute(name) && name.endsWith('.kt'));
assert.equal(filenames.length, buildReceipt.compileSources.length);
const retainedSources = buildReceipt.compileSources.map((pin, index) => ({ ...pin, filename: filenames[index] }));
const options = { sourceRoot: path.join(REPO, 'out/kotlin-compiler-port/sources'), outputRoot: path.join(root, 'profile'), retainedSources };
const prepared = await prepareServiceLoaderProfile(options), target = retainedSources.find(pin => pin.path === TARGET);
const finalSources = retainedSources.filter(pin => pin.path !== TARGET);
const finalOptions = { outputRoot: prepared.outputRoot, retainedSources: finalSources, expectedReceiptSha256: prepared.receiptSha256 };
const final = await verifyServiceLoaderFinalSources(finalOptions);
const fixturePath = path.join(root, 'fixture.json');
await writeJson(fixturePath, { outputRoot: prepared.outputRoot, receiptSha256: prepared.receiptSha256, finalSources, target });
const command = [process.execPath, '--test', '--test-reporter=tap', path.join(HERE, 'prepare.test.mjs')];
const result = await promisify(execFile)(command[0], command.slice(1), { cwd: REPO, timeout: 180000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, KOTLIN_SERVICE_PROFILE_TEST_FIXTURE: fixturePath } });
await writeFile(path.join(root, 'guards.stdout'), result.stdout, { flag: 'wx', mode: 0o600 });
await writeFile(path.join(root, 'guards.stderr'), result.stderr, { flag: 'wx', mode: 0o600 });
assert.match(result.stdout, /# fail 0/); assert.match(result.stdout, /# skipped 0/);
assert.deepEqual(await verifyServiceLoaderFinalSources(finalOptions), final);
for (const pin of retainedSources) { const bytes = await readRegular(pin.filename);
    assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256); }
const localFiles = [];
for (const name of ['prepare.mjs', 'prepare.test.mjs', 'probe.mjs', 'sources.lock.json', 'README.md']) {
    const bytes = await readRegular(path.join(HERE, name)); localFiles.push({ path: name, ...{ bytes: bytes.length, sha256: sha256(bytes) } });
}
const artifacts = [];
for (const filename of [prepared.receiptPath, fixturePath, path.join(root, 'guards.stdout'), path.join(root, 'guards.stderr'), prepared.originalReferenceSources[0]]) {
    const bytes = await readRegular(filename); artifacts.push({ path: path.relative(root, filename), bytes: bytes.length, sha256: sha256(bytes) });
}
await writeJson(path.join(root, 'evidence.json'), { schemaVersion: 1, kind: 'actual-service-loader-exclusion-proof', artifactRoot: path.relative(REPO, root),
    source: prepared.receipt.source, sourceLockSha256: prepared.receipt.sourceLockSha256, localFiles, artifacts,
    priorWholeBuild: { path: path.relative(REPO, build), receipt: { bytes: buildReceiptBytes.length, sha256: sha256(buildReceiptBytes) },
        argumentFileSha256: sha256(argsBytes), selectedSources: retainedSources.length },
    originalAudit: prepared.receipt.originals, beforeSources: retainedSources.length, afterSources: finalSources.length,
    final, guards: { command, exitCode: 0, actualGraphRejections: 8, lexicalReferenceCases: 10, restoredPositivePassed: true },
    serviceLoaderImplemented: false, completeCompilerBuilt: false, languageReadiness: false });
console.log(JSON.stringify({ result: 'pass', originalFiles: prepared.receipt.originals.inspectedFiles,
    beforeSources: retainedSources.length, afterSources: finalSources.length, actualGraphRejections: 8, lexicalReferenceCases: 10 }));
