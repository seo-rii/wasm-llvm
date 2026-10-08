#!/usr/bin/env node
/** Run the real portable official KLIB readers and MemoryKotlinLibrary in an offline Chromium Worker. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const options = {};
const args = process.argv.slice(2);
while (args.length) {
    const key = args.shift();
    assert(['--output', '--evidence', '--playwright-from'].includes(key) && args[0] && !options[key]);
    options[key] = path.resolve(args.shift());
}
const output = options['--output'] ?? path.resolve(here, '../../../../out/kotlin-klib-probe');
const evidencePath = options['--evidence'] ?? path.join(output, 'klib-browser.json');
const { chromium } = createRequire(options['--playwright-from'] ?? path.resolve(here, '../../../../../wasm-idle/package.json'))('playwright-core');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const buildBytes = await readFile(path.join(output, 'build-receipt.json'));
const build = JSON.parse(buildBytes);
assert.equal(build.status, 'passed');
assert.equal(build.sourceLockSha256, hash(await readFile(path.join(here, 'sources.lock.json'))));
assert.equal(build.buildScriptSha256, hash(await readFile(path.join(here, 'build-probe.mjs'))));
assert.equal(build.patch.sha256, hash(await readFile(path.join(here, build.patch.path))));
assert.equal(build.hostLibraryPathSha256, hash(await readFile(path.join(here, '../host/LibraryPath.kt'))));
for (const record of build.observerSources) assert.equal(record.sha256, hash(await readFile(path.join(here, record.path))));
for (const record of build.preparation.sources.filter((record) => record.originalSha256 === null)) {
    assert.equal(record.sha256, hash(await readFile(path.join(here, path.basename(record.path)))));
}
const assets = new Map();
for (const record of build.outputs) {
    const bytes = await readFile(path.join(output, record.path));
    assert.equal(bytes.byteLength, record.bytes);
    assert.equal(hash(bytes), record.sha256);
    if (record.path.startsWith('wasm/')) assets.set('/assets/' + path.basename(record.path), bytes);
}
const indexBytes = await readFile(path.join(output, 'fixture/index.json'));
assert.equal(hash(indexBytes), build.targetStdlib.fixtureIndexSha256);
const index = JSON.parse(indexBytes);
assert.equal(index.stdlibSha256, build.targetStdlib.sha256);
assets.set('/fixture/index.json', indexBytes);
for (const record of index.files) {
    const bytes = await readFile(path.join(output, 'fixture/files', record.path));
    assert.equal(bytes.byteLength, record.bytes);
    assert.equal(hash(bytes), record.sha256);
    assets.set('/fixture/files/' + record.path, bytes);
}
const originalSnapshot = await readFile(path.join(output, 'original-snapshot.bin'));
assert.equal(hash(originalSnapshot), build.jvmComparison.snapshotSha256);
assets.set('/expected-snapshot.bin', originalSnapshot);
const original = JSON.parse(await readFile(path.join(output, 'original-jvm.json')));
const portable = JSON.parse(await readFile(path.join(output, 'portable-jvm.json')));
assert.deepEqual(original.unit, portable.unit);
assert.deepEqual(original.manifest, portable.manifest);
const origin = 'https://kotlin-klib-probe.invalid';
const worker = `
import { klibProbeAddFile, klibProbeAddDirectory, klibProbeUnits, klibProbeManifests, klibProbeChecks, klibProbeStdlibSnapshot } from '${origin}/assets/klib-probe.mjs';
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
const indexBytes = new Uint8Array(await (await fetch('${origin}/fixture/index.json')).arrayBuffer());
if (await digest(indexBytes) !== '${build.targetStdlib.fixtureIndexSha256}') throw new Error('Fixture index hash mismatch');
const index = JSON.parse(new TextDecoder().decode(indexBytes));
for (const directory of index.directories) klibProbeAddDirectory(directory);
for (const record of index.files) {
  const bytes = new Uint8Array(await (await fetch('${origin}/fixture/files/' + record.path)).arrayBuffer());
  if (bytes.byteLength !== record.bytes || await digest(bytes) !== record.sha256) throw new Error('Fixture file integrity mismatch');
  klibProbeAddFile(record.path, bytes, record.sha256);
}
const expected = new Uint8Array(await (await fetch('${origin}/expected-snapshot.bin')).arrayBuffer());
if (await digest(expected) !== '${build.jvmComparison.snapshotSha256}') throw new Error('Expected snapshot integrity mismatch');
self.onmessage = async () => {
  try {
    const start = performance.now();
    const unit = JSON.parse(klibProbeUnits());
    const manifest = JSON.parse(klibProbeManifests());
    const guards = JSON.parse(klibProbeChecks());
    const bytes = klibProbeStdlibSnapshot();
    if (bytes.byteLength !== expected.byteLength) throw new Error('Stdlib snapshot byte count differs');
    for (let index = 0; index < bytes.byteLength; index++) if (bytes[index] !== expected[index]) throw new Error('Stdlib snapshot byte differs at ' + index);
    const sha256 = await digest(bytes);
    self.postMessage({ kind: 'observed', unit, manifest, guards, snapshotBytes: bytes.byteLength, snapshotSha256: sha256,
      everySnapshotByteCompared: true, elapsedMs: performance.now() - start });
  } catch (error) { self.postMessage({ kind: 'fatal', message: String(error), stack: error?.stack }); }
};
self.postMessage({ kind: 'ready' });
`;
const browser = await chromium.launch({ headless: true });
try {
    const context = await browser.newContext();
    const localRequests = [];
    const externalRequests = [];
    await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname === '/') {
            await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Official KLIB memory boundary probe</title>' });
        } else if (url.origin === origin && assets.has(url.pathname)) {
            localRequests.push(url.pathname);
            await route.fulfill({ status: 200, contentType: url.pathname.endsWith('.wasm') ? 'application/wasm' :
                url.pathname.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream', body: assets.get(url.pathname) });
        } else { externalRequests.push(route.request().url()); await route.abort(); }
    });
    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(async (source) => {
        window.klibWorkerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        window.klibWorker = new Worker(window.klibWorkerUrl, { type: 'module' });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { window.klibWorker.terminate(); reject(new Error('KLIB fixture initialization timed out')); }, 60000);
            window.klibWorker.onerror = (event) => { clearTimeout(timer); window.klibWorker.terminate(); reject(new Error(event.message)); };
            window.klibWorker.onmessage = ({ data }) => { clearTimeout(timer); if (data.kind === 'ready') resolve(); else reject(new Error(data.message)); };
        });
    }, worker);
    await context.setOffline(true);
    const requestsDuringProbe = [];
    const requestListener = (request) => requestsDuringProbe.push(request.url());
    context.on('request', requestListener);
    let observed;
    try {
        observed = await page.evaluate(async () => {
            try {
                return await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => { window.klibWorker.terminate(); reject(new Error('KLIB offline execution timed out')); }, 60000);
                    window.klibWorker.onerror = (event) => { clearTimeout(timer); reject(new Error(event.message)); };
                    window.klibWorker.onmessage = ({ data }) => { clearTimeout(timer); if (data.kind === 'observed') resolve(data); else reject(new Error(data.message)); };
                    window.klibWorker.postMessage({ kind: 'observe' });
                });
            } finally { window.klibWorker.terminate(); URL.revokeObjectURL(window.klibWorkerUrl); }
        });
    } finally { context.off('request', requestListener); }
    assert.deepEqual(requestsDuringProbe, []);
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(observed.unit, original.unit);
    assert.deepEqual(observed.manifest, original.manifest);
    assert.deepEqual(observed.guards, portable.guards);
    assert.equal(observed.snapshotBytes, originalSnapshot.byteLength);
    assert.equal(observed.snapshotSha256, hash(originalSnapshot));
    assert.equal(observed.everySnapshotByteCompared, true);
    const evidence = {
        schemaVersion: 1, kind: 'official-klib-memory-host-jvm-wasmjs-differential', status: 'passed', gate: 'G2-KLIB-container-and-byte-boundary-only',
        source: build.source, sourceLockSha256: build.sourceLockSha256, patch: build.patch, sources: build.preparation.sources,
        referenceOnlySources: build.referenceOnlySources, observerSources: build.observerSources, buildScriptSha256: build.buildScriptSha256,
        browserProbeSha256: hash(await readFile(fileURLToPath(import.meta.url))), buildReceiptSha256: hash(buildBytes),
        hostLibraryPathSha256: build.hostLibraryPathSha256, bootstrapVersion: build.bootstrapVersion,
        bootstrapCompilerSourceCommit: build.bootstrapCompilerSourceCommit, bootstrapArtifacts: build.bootstrapArtifacts,
        commands: build.commands, browserCommand: [process.execPath, ...process.argv.slice(1)], targetStdlib: build.targetStdlib, outputs: build.outputs,
        corpus: { required: build.jvmComparison.unitCases + build.jvmComparison.manifestCases + portable.guards.length + 1,
            unitCases: build.jvmComparison.unitCases, manifestCases: build.jvmComparison.manifestCases, guards: portable.guards.length,
            realStdlibSnapshots: 1, failed: 0, skipped: 0, notRun: 0 },
        stdlibComparison: { originalJvmPortableJvmEveryByteEqual: true, originalJvmBrowserEveryByteEqual: true,
            snapshotBytes: observed.snapshotBytes, snapshotSha256: observed.snapshotSha256,
            coverage: 'All metadata packages/fragments/header/manifest/version values; main + inlinable IR files, declaration IDs, all individual bodies/types/signatures/strings/debug-info/file-entries and all public raw rows.' },
        guards: portable.guards, environment: { browser: 'Chromium', browserVersion: browser.version(), headless: true },
        network: { offlineAfterStaticPreparation: true, requestsDuringProbe, externalRequests, preparedAssetRequests: localRequests.length },
        elapsedMs: observed.elapsedMs, languageReadiness: false,
        limitations: [...build.limitations, 'Only this Chromium configuration was tested; no performance target or total browser memory measurement.',
            'Offline begins after hash-verified fixture and loader preparation; app-shell restart and persistent caching were not exercised.',
            'Source-host paths and immutable file index are new host abstractions; no arbitrary archive/filesystem/third-party KLIB upload support.'],
    };
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ evidence: evidencePath, status: evidence.status, corpus: evidence.corpus,
        snapshotBytes: observed.snapshotBytes, browser: browser.version() }));
} finally { await browser.close(); }
