import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
assert.equal(process.argv.length, 3);
const config = JSON.parse(await readRegular(path.resolve(process.argv[2])));
async function pin(filename) { const bytes = await readRegular(filename, 64 * 1024 * 1024); return { filename, bytes: bytes.length, sha256: sha256(bytes) }; }
const runs = [];
for (const run of config.runs) {
    const status = JSON.parse(await readRegular(run.status)); assert.equal(status.exitCode, run.expectedExitCode);
    runs.push({ kind: run.kind, expectedExitCode: run.expectedExitCode, log: await pin(run.log), status: await pin(run.status) });
}
const runtime = JSON.parse(await readRegular(path.join(config.runtimeRoot, 'receipt.json'))); assert.equal(runtime.result, 'pass');
const chain = JSON.parse(await readRegular(path.join(config.chainRoot, 'receipt.json'), 64 * 1024 * 1024)); assert.equal(chain.result, 'pass');
for (const [name, root] of [['runtime', config.runtimeRoot], ['chain', config.chainRoot]])
    await writeFile(path.join(HERE, 'evidence', name + '.json'), await readRegular(path.join(root, 'receipt.json'), 64 * 1024 * 1024), { flag: 'wx', mode: 0o600 });
const externalArtifacts = [];
async function collectExternal(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, item.name);
        if (item.isDirectory()) await collectExternal(filename); else externalArtifacts.push(await pin(filename));
    }
}
await collectExternal(config.chainRoot);
for (const filename of config.failedAttemptSources ?? []) externalArtifacts.push(await pin(filename));
const files = [];
async function collect(prefix = '') {
    for (const item of await readdir(path.join(HERE, prefix), { withFileTypes: true })) {
        const name = prefix ? prefix + '/' + item.name : item.name;
        if (item.isDirectory()) await collect(name);
        else if (name !== 'evidence/seal.json') { const { filename, ...record } = await pin(path.join(HERE, name)); files.push({ path: name, ...record }); }
    }
}
await collect();
await writeJson(path.join(HERE, 'evidence/seal.json'), { schemaVersion: 1, kind: 'genuine-descriptor-base-evidence-seal', files, runs, externalArtifacts,
    focusedGuardTests: 10, scope: 'Full original/common JVM families, selected-source reverse composition and ownership guards; no complete Wasm descriptor family or full compiler acceptance.',
    fullCompilerBuilt: false, languageReadiness: false });
console.log(JSON.stringify({ result: 'sealed', files: files.length, runs: runs.length, externalArtifacts: externalArtifacts.length }));
