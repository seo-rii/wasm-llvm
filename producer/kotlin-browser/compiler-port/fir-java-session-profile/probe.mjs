import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { prepareFirJavaSessionProfile, verifyFirJavaSessionProfile, verifyFinalFirJavaSessionProfile } from './prepare.mjs';
import { TARGET } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
assert.equal(process.argv.length, 4);
const build = path.resolve(process.argv[2]), root = path.resolve(process.argv[3]);
assert(root.startsWith(path.join(repository, 'out') + path.sep)); await mkdir(root, { mode: 0o700 });
const receiptBytes = await readRegular(path.join(build, 'compiler-build-receipt.json'), 64 * 1024 * 1024), prior = JSON.parse(receiptBytes);
assert.equal(prior.status, 'failed');
const argsBytes = await readRegular(path.join(build, 'compiler-klib.args'));
assert.equal(sha256(argsBytes), prior.commands.find(row => row.phase === 'official-compiler-source-to-wasmjs-klib').argumentFileSha256);
const argumentsList = argsBytes.toString().trimEnd().split('\n').map(row => JSON.parse(row));
const filenames = argumentsList.slice(-prior.compileSources.length);
const retainedSources = [];
for (let start = 0; start < filenames.length; start += 24) {
    const rows = await Promise.allSettled(filenames.slice(start, start + 24).map(async (filename, offset) => {
        assert(path.isAbsolute(filename) && filename.endsWith('.kt'));
        const pin = prior.compileSources[start + offset], bytes = await readRegular(filename);
        assert.deepEqual({ bytes: bytes.length, sha256: sha256(bytes) }, { bytes: pin.bytes, sha256: pin.sha256 });
        return { ...pin, filename };
    }));
    for (const row of rows) { if (row.status !== 'fulfilled') throw row.reason; retainedSources.push(row.value); }
}
const sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources'), originalFilename = path.join(sourceRoot, TARGET), original = await readRegular(originalFilename);
const originalTarget = { path: TARGET, filename: originalFilename, bytes: original.length, sha256: sha256(original) };
const rebound = retainedSources.map(pin => pin.path === TARGET ? originalTarget : pin);
assert.equal(rebound.filter(pin => pin.path === TARGET).length, 1);
const prepared = await prepareFirJavaSessionProfile({ sourceRoot, outputRoot: path.join(root, 'profile'), retainedSources: rebound });
await verifyFirJavaSessionProfile({ outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256 });
const lock = JSON.parse(await readRegular(path.join(here, 'sources.lock.json'))), filename = prepared.commonSources[0];
const canonical = await readRegular(filename), existing = new Set([...canonical.toString().matchAll(/^import ([^\r\n]+)$/gm)].map(row => row[1]));
const additions = lock.recordedPropertyImports.filter(name => !existing.has(name)), declaration = /^package[^\r\n]+/m.exec(canonical.toString());
const end = declaration.index + declaration[0].length;
const assembled = Buffer.from(canonical.toString().slice(0, end) + '\n' + additions.map(name => 'import ' + name).join('\n') + '\n' + canonical.toString().slice(end));
await writeFile(filename, assembled, { mode: 0o600 });
const target = { path: TARGET, filename, bytes: assembled.length, sha256: sha256(assembled) };
const finalSources = retainedSources.map(pin => pin.path === TARGET ? target : pin);
const options = { outputRoot: prepared.outputRoot, retainedSources: finalSources,
    recordedPropertyImports: lock.recordedPropertyImports, expectedReceiptSha256: prepared.receiptSha256 };
const final = await verifyFinalFirJavaSessionProfile(options), fixturePath = path.join(root, 'fixture.json');
await writeJson(fixturePath, { outputRoot: prepared.outputRoot, receiptSha256: prepared.receiptSha256, finalSources,
    originalTarget, recordedPropertyImports: lock.recordedPropertyImports });
const command = [process.execPath, '--test', '--test-reporter=tap', path.join(here, 'prepare.test.mjs')];
const result = await promisify(execFile)(command[0], command.slice(1), { cwd: repository, timeout: 300000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, KOTLIN_FIR_JAVA_PROFILE_FIXTURE: fixturePath } });
for (const stream of ['stdout', 'stderr']) await writeFile(path.join(root, 'guards.' + stream), result[stream], { flag: 'wx', mode: 0o600 });
assert.match(result.stdout, /# fail 0/); assert.match(result.stdout, /# skipped 0/);
assert.deepEqual(await verifyFinalFirJavaSessionProfile(options), final);
const artifacts = [], localFiles = [];
for (const name of ['prepare.mjs', 'transform.mjs', 'prepare.test.mjs', 'probe.mjs', 'sources.lock.json', 'README.md']) {
    const bytes = await readRegular(path.join(here, name)); localFiles.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
}
for (const file of [prepared.receiptPath, fixturePath, filename, path.join(root, 'guards.stdout'), path.join(root, 'guards.stderr')]) {
    const bytes = await readRegular(file); artifacts.push({ path: path.relative(root, file), bytes: bytes.length, sha256: sha256(bytes) });
}
await writeJson(path.join(root, 'evidence.json'), { schemaVersion: 1, kind: 'actual-fir-java-session-selection-proof',
    artifactRoot: path.relative(repository, root), source: prepared.receipt.source, localFiles, artifacts,
    priorWholeBuild: { path: path.relative(repository, build), receipt: { bytes: receiptBytes.length, sha256: sha256(receiptBytes) },
        argumentFileSha256: sha256(argsBytes), selectedSources: retainedSources.length },
    preparationRebinding: [TARGET], originalAudit: prepared.receipt.originalAudit, selectedSources: finalSources.length,
    unchangedSources: finalSources.length - 1, final, guards: { command, exitCode: 0, actualGraphRejections: 10, restoredPositivePassed: true },
    fullFirSessionRuntime: false, fullCompilerBuilt: false, publicLanguageSupport: false });
process.stdout.write(JSON.stringify({ result: 'pass', selectedSources: finalSources.length, unchangedSources: finalSources.length - 1,
    removedDeclarations: prepared.receipt.removedDeclarations, actualGraphRejections: 10 }) + '\n');
