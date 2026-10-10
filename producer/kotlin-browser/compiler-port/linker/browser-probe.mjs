#!/usr/bin/env node
/** Execute actual official portable component writers in an offline Chromium Worker and compare every output byte. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const options = {};
const args = process.argv.slice(2);
while (args.length) { const key = args.shift(); assert(['--output', '--evidence', '--playwright-from'].includes(key) && args[0] && !options[key]); options[key] = path.resolve(args.shift()); }
const output = options['--output'] ?? path.resolve(here, '../../../../out/kotlin-linker-writer-probe');
const evidencePath = options['--evidence'] ?? path.join(output, 'writer-browser.json');
const { chromium } = createRequire(options['--playwright-from'] ?? path.resolve(here, '../../../../../wasm-idle/package.json'))('playwright-core');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const buildBytes = await readFile(path.join(output, 'build-receipt.json'));
const build = JSON.parse(buildBytes);
assert.equal(build.status, 'passed');
assert.equal(build.sourceLockSha256, hash(await readFile(path.join(here, 'sources.lock.json'))));
assert.equal(build.klibSourceLockSha256, hash(await readFile(path.join(here, '../klib/sources.lock.json'))));
assert.equal(build.buildScriptSha256, hash(await readFile(path.join(here, 'build-probe.mjs'))));
assert.equal(build.patch.sha256, hash(await readFile(path.join(here, build.patch.path))));
assert.equal(build.klibPatch.sha256, hash(await readFile(path.join(here, '../klib', build.klibPatch.path))));
assert.equal(build.hostLibraryPathSha256, hash(await readFile(path.join(here, '../host/LibraryPath.kt'))));
assert.equal(build.sourceBuildFlags.sha256, hash(await readFile(path.join(here, '../build-flags.json'))));
for (const record of build.observerSources) assert.equal(record.sha256, hash(await readFile(path.join(here, record.path))));
for (const record of build.preparation.sources.filter((record) => record.originalSha256 === null)) assert.equal(record.sha256, hash(await readFile(path.join(here, path.basename(record.path)))));
for (const record of build.klibPreparation.sources.filter((record) => record.originalSha256 === null)) assert.equal(record.sha256, hash(await readFile(path.join(here, '../klib', path.basename(record.path)))));
const assets = new Map();
for (const record of build.outputs) {
    const bytes = await readFile(path.join(output, record.path));
    assert.equal(bytes.byteLength, record.bytes); assert.equal(hash(bytes), record.sha256);
    if (record.path.startsWith('wasm/')) assets.set('/assets/' + path.basename(record.path), bytes);
}
const indexBytes = await readFile(path.join(output, 'fixture/index.json'));
assert.equal(hash(indexBytes), build.targetStdlib.fixtureIndexSha256);
const index = JSON.parse(indexBytes);
assert.equal(index.stdlibSha256, build.targetStdlib.sha256);
assets.set('/fixture/index.json', indexBytes);
for (const record of index.files) {
    const bytes = await readFile(path.join(output, 'fixture/files', record.path));
    assert.equal(bytes.byteLength, record.bytes); assert.equal(hash(bytes), record.sha256);
    assets.set('/fixture/files/' + record.path, bytes);
}
const snapshot = await readFile(path.join(output, 'original-snapshot.bin'));
assert.equal(hash(snapshot), build.jvmComparison.snapshotSha256);
assets.set('/expected-snapshot.bin', snapshot);
const jars = (await readFile(path.join(output, 'original-jars.txt'))).toString();
assert.equal((await readFile(path.join(output, 'portable-jars.txt'))).toString(), jars);
const guards = (await readFile(path.join(output, 'portable-guards.txt'))).toString().split('\n');
const origin = 'https://kotlin-writer-probe.invalid';
const worker = `
import { writerProbeAddFile, writerProbeSnapshot, writerProbeJars, writerProbeGuards } from '${origin}/assets/linker-writer-probe.mjs';
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
const indexBytes = new Uint8Array(await (await fetch('${origin}/fixture/index.json')).arrayBuffer());
if (await digest(indexBytes) !== '${build.targetStdlib.fixtureIndexSha256}') throw new Error('Fixture index hash mismatch');
const index = JSON.parse(new TextDecoder().decode(indexBytes));
for (const record of index.files) {
  const bytes = new Uint8Array(await (await fetch('${origin}/fixture/files/' + record.path)).arrayBuffer());
  if (bytes.byteLength !== record.bytes || await digest(bytes) !== record.sha256) throw new Error('Fixture integrity mismatch');
  writerProbeAddFile(record.path, bytes);
}
const expected = new Uint8Array(await (await fetch('${origin}/expected-snapshot.bin')).arrayBuffer());
if (await digest(expected) !== '${build.jvmComparison.snapshotSha256}') throw new Error('Expected snapshot mismatch');
self.onmessage = async () => {
  try {
    const started = performance.now();
    const bytes = writerProbeSnapshot();
    if (bytes.byteLength !== expected.byteLength) throw new Error('Writer byte count differs');
    for (let index = 0; index < bytes.byteLength; index++) if (bytes[index] !== expected[index]) throw new Error('Writer byte differs at ' + index);
    self.postMessage({ kind: 'observed', everyOutputByteEqual: true, snapshotBytes: bytes.byteLength,
      snapshotSha256: await digest(bytes), jars: writerProbeJars(), guards: writerProbeGuards().split('\\n'), elapsedMs: performance.now() - started });
  } catch (error) { self.postMessage({ kind: 'fatal', message: String(error), stack: error?.stack }); }
};
self.postMessage({ kind: 'ready' });
`;
const browser = await chromium.launch({ headless: true });
try {
    const context = await browser.newContext();
    const externalRequests = [];
    const assetRequests = [];
    await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname === '/') await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Official KLIB component writer probe</title>' });
        else if (url.origin === origin && assets.has(url.pathname)) {
            assetRequests.push(url.pathname);
            await route.fulfill({ status: 200, contentType: url.pathname.endsWith('.wasm') ? 'application/wasm' : url.pathname.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream', body: assets.get(url.pathname) });
        } else { externalRequests.push(route.request().url()); await route.abort(); }
    });
    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(async (source) => {
        window.writerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        window.writerWorker = new Worker(window.writerUrl, { type: 'module' });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { window.writerWorker.terminate(); reject(new Error('Writer preparation timed out')); }, 60000);
            window.writerWorker.onerror = (event) => { clearTimeout(timer); window.writerWorker.terminate(); reject(new Error(event.message)); };
            window.writerWorker.onmessage = ({ data }) => { clearTimeout(timer); if (data.kind === 'ready') resolve(); else reject(new Error(data.message)); };
        });
    }, worker);
    await context.setOffline(true);
    const requestsDuringProbe = [];
    const listener = (request) => requestsDuringProbe.push(request.url());
    context.on('request', listener);
    let observed;
    try {
        observed = await page.evaluate(async () => {
            try {
                return await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => { window.writerWorker.terminate(); reject(new Error('Writer offline probe timed out')); }, 60000);
                    window.writerWorker.onerror = (event) => { clearTimeout(timer); reject(new Error(event.message)); };
                    window.writerWorker.onmessage = ({ data }) => { clearTimeout(timer); if (data.kind === 'observed') resolve(data); else reject(new Error(data.message)); };
                    window.writerWorker.postMessage({ kind: 'observe' });
                });
            } finally { window.writerWorker.terminate(); URL.revokeObjectURL(window.writerUrl); }
        });
    } finally { context.off('request', listener); }
    assert.deepEqual(externalRequests, []); assert.deepEqual(requestsDuringProbe, []);
    assert.equal(observed.everyOutputByteEqual, true);
    assert.equal(observed.snapshotBytes, snapshot.byteLength); assert.equal(observed.snapshotSha256, hash(snapshot));
    assert.equal(observed.jars, jars); assert.deepEqual(observed.guards, guards);
    const evidence = {
        schemaVersion: 1, kind: 'official-klib-component-writer-jvm-wasmjs-differential', status: 'passed', gate: 'G2-KLIB-component-writer-host-boundary-only',
        source: build.source, sourceLockSha256: build.sourceLockSha256, patch: build.patch, sources: build.preparation.sources,
        klibSourceLockSha256: build.klibSourceLockSha256, klibPatch: build.klibPatch, klibSources: build.klibPreparation.sources,
        observerSources: build.observerSources, buildScriptSha256: build.buildScriptSha256, browserProbeSha256: hash(await readFile(fileURLToPath(import.meta.url))),
        buildReceiptSha256: hash(buildBytes), hostLibraryPathSha256: build.hostLibraryPathSha256, bootstrapVersion: build.bootstrapVersion,
        sourceBuildFlags: build.sourceBuildFlags,
        bootstrapCompilerSourceCommit: build.bootstrapCompilerSourceCommit, bootstrapArtifacts: build.bootstrapArtifacts,
        commands: build.commands, browserCommand: [process.execPath, ...process.argv.slice(1)], targetStdlib: build.targetStdlib, outputs: build.outputs,
        corpus: { required: 1 + build.jvmComparison.jarCases + guards.length, realStdlibWriterSnapshots: 1, jarManifestCases: build.jvmComparison.jarCases, guards: guards.length,
            failed: 0, skipped: 0, notRun: 0 },
        comparison: { originalJvmPortableJvmEveryByteEqual: true, originalJvmBrowserEveryByteEqual: true,
            snapshotBytes: observed.snapshotBytes, snapshotSha256: observed.snapshotSha256,
            coverage: 'All emitted manifest/metadata/main-IR/inlinable-IR files and explicit directories; sorted path and nullable-table rules; JAR main version continuation semantics.' },
        guards, environment: { browser: 'Chromium', browserVersion: browser.version(), headless: true },
        network: { offlineAfterStaticPreparation: true, requestsDuringProbe, externalRequests, preparedAssetRequests: assetRequests.length },
        elapsedMs: observed.elapsedMs, languageReadiness: false, limitations: [...build.limitations,
            'Only this headless Chromium configuration was run; this unit timing includes hashing/copying and is not compiler performance.',
            'Static input and expected output assets are ready before offline begins; app-shell restart and persistent caches are not tested.'],
    };
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ evidence: evidencePath, status: evidence.status, corpus: evidence.corpus, snapshotBytes: observed.snapshotBytes, browser: browser.version() }));
} finally { await browser.close(); }
