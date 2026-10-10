#!/usr/bin/env node
/** Actual source-pinned mapping on JVM, common JVM, Node Wasm and offline Chromium Worker. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareHostSources } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);
export const mappingPath = 'compiler/frontend.common/src/org/jetbrains/kotlin/KtSourceFileLinesMapping.kt';

export function originalJvmMapping(original) {
    // Only relocate the two official IntelliJ imports to the actual bootstrap distribution.
    // The original complete JVM file, including stream reader and PSI declarations, is compiled.
    assert.equal(original.split('import com.intellij.').length, 3);
    return original.replaceAll('import com.intellij.', 'import org.jetbrains.kotlin.com.intellij.');
}

export function assertMappingBodyPreserved(original, portable) {
    const normalize = portable
        .replace('    // Official common List search over a live array view; no copied offsets or per-query view.\n    private val lineStartOffsetsView: List<Int> = lineStartOffsets.asList()\n\n', '')
        .replace('lineStartOffsetsView.binarySearch(offset)', 'lineStartOffsets.binarySearch(offset)');
    const mapping = text => text.slice(text.indexOf('open class KtSourceFileLinesMappingFromLineStartOffsets('), text.indexOf('\n/**', text.indexOf('open class KtSourceFileLinesMappingFromLineStartOffsets(')));
    assert.equal(mapping(normalize), mapping(original), 'Official mapping methods changed beyond the audited common receiver');
    const textMapping = text => text.slice(text.indexOf('fun CharSequence.toSourceLinesMapping()'));
    assert.equal(textMapping(normalize), textMapping(original), 'Official UTF-16/LF offset construction changed');
}

async function chromiumObservation(outputRoot, expected) {
    const assets = new Map();
    for (const entry of await readdir(path.join(outputRoot, 'wasm'), { withFileTypes: true })) {
        assert(entry.isFile()); assets.set(entry.name, await readRegular(path.join(outputRoot, 'wasm', entry.name)));
    }
    const origin = 'https://kotlin-source-lines.invalid';
    const workerSource = `import * as module from '${origin}/assets/source-lines.mjs';
self.onmessage = () => { try { self.postMessage({ value: module.sourceLinesObservation() }); } catch (error) { self.postMessage({ error: String(error) }); } };
self.postMessage({ ready: true });`;
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext();
        const assetRequests = [], externalRequests = [], offlineRequests = [];
        await context.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.origin === origin && url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Source mapping probe</title>' });
            const name = url.pathname.startsWith('/assets/') ? url.pathname.slice('/assets/'.length) : '';
            if (url.origin === origin && assets.has(name)) {
                assetRequests.push(name); return route.fulfill({ status: 200, contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: assets.get(name) });
            }
            externalRequests.push(route.request().url()); return route.abort();
        });
        const page = await context.newPage(); await page.goto(origin);
        await page.evaluate(async source => {
            const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
            try {
                const worker = new Worker(url, { type: 'module' }); window.sourceLinesWorker = worker;
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('Worker initialization deadline')), 30000);
                    worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
                    worker.onmessage = ({ data }) => { clearTimeout(timer); data.ready ? resolve() : reject(new Error(data.error)); };
                });
            } finally { URL.revokeObjectURL(url); }
        }, workerSource);
        await context.setOffline(true); context.on('request', request => offlineRequests.push(request.url()));
        const value = await page.evaluate(() => new Promise((resolve, reject) => {
            const worker = window.sourceLinesWorker;
            const timer = setTimeout(() => { worker.terminate(); reject(new Error('Offline observation deadline')); }, 30000);
            worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
            worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); data.error ? reject(new Error(data.error)) : resolve(data.value); };
            worker.postMessage({ observe: true });
        }));
        assert.equal(value, expected, 'Original JVM/offline Chromium mapping differs');
        assert.deepEqual(externalRequests, []); assert.deepEqual(offlineRequests, []);
        return { engine: 'Chromium', version: browser.version(), moduleWorker: true, offlineAfterInitialization: true,
            assetRequests, externalRequests, offlineRequests, observationSha256: sha256(Buffer.from(value)) };
    } finally { await browser.close(); }
}

export async function buildSourceLinesProbe({ sourceRoot, outputRoot,
    stdlibSourceRoot = path.join(repository, 'out/kotlin-stdlib-probe/builds/run-c4fcdcdc/sources') } = {}) {
    assert(sourceRoot && outputRoot); sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    await assertNoSymlink(outputRoot); await mkdir(path.dirname(outputRoot), { recursive: true }); await mkdir(outputRoot, { mode: 0o700 });
    await execute('git', ['init', '--quiet', outputRoot], { timeout: 10000 });
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
    const mappingPin = lock.sources.find(pin => pin.path === mappingPath); assert(mappingPin);
    const original = verifyFile(await readRegular(path.join(sourceRoot, mappingPath)), { ...mappingPin, gitBlob: mappingPin.gitBlobSha1 });
    const prepared = await prepareHostSources({ sourceRoot, outputRoot });
    const mapping = path.join(outputRoot, mappingPath); const portable = await readRegular(mapping);
    assertMappingBodyPreserved(original.toString('utf8'), portable.toString('utf8'));
    for (const pin of lock.sourceLinesSearch.references) verifyFile(await readRegular(path.join(stdlibSourceRoot, pin.path)), pin);
    const reference = path.join(outputRoot, 'OriginalJvmMapping.kt');
    await writeFile(reference, originalJvmMapping(original.toString('utf8')), { flag: 'wx', mode: 0o600 });
    const observers = [];
    for (const name of ['SourceLinesProbe.kt', 'SourceLinesJvm.kt', 'SourceLinesWasm.kt']) {
        const bytes = await readRegular(path.join(here, name)); await writeFile(path.join(outputRoot, name), bytes, { flag: 'wx', mode: 0o600 });
        observers.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    for (const directory of ['jvm', 'klib', 'wasm']) await mkdir(path.join(outputRoot, directory));
    const bootstrap = await verifyBootstrap(); const commands = [];
    async function run(phase, args) {
        console.log('phase: ' + phase);
        const value = await execute('java', args, { cwd: outputRoot, timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
        if (value.stderr) process.stderr.write(value.stderr); commands.push({ phase, command: ['java', ...args], exitCode: 0 }); return value.stdout;
    }
    const java = ['-Xmx512m', '-cp', bootstrap.classPath];
    const stdlib = bootstrap.artifacts.find(pin => pin.id === 'stdlib-jvm').path;
    const probe = path.join(outputRoot, 'SourceLinesProbe.kt'), jvmEntry = path.join(outputRoot, 'SourceLinesJvm.kt');
    const originalJar = path.join(outputRoot, 'jvm/original.jar'), commonJar = path.join(outputRoot, 'jvm/common.jar');
    const jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', '2.5', '-api-version', '2.5'];
    await run('pinned-original-jvm-source-build', [...jvm, '-classpath', bootstrap.classPath, '-d', originalJar, reference, probe, jvmEntry]);
    await run('portable-common-jvm-source-build', [...jvm, '-classpath', stdlib, '-Xmulti-platform', '-Xcommon-sources=' + [mapping, probe].join(','), '-d', commonJar, mapping, probe, jvmEntry]);
    const main = 'org.jetbrains.kotlin.portable.source.lines.probe.SourceLinesJvmKt';
    const observedOriginal = await run('pinned-original-jvm-observe', ['-ea', '-cp', [originalJar, bootstrap.classPath].join(path.delimiter), main]);
    const observedJvm = await run('portable-common-jvm-observe', ['-ea', '-cp', [commonJar, stdlib].join(path.delimiter), main]);
    assert.equal(observedJvm, observedOriginal, 'Original JVM/portable common mapping differs');
    const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-libraries', bootstrap.wasmJsStdlib, '-language-version', '2.5', '-api-version', '2.5'];
    await run('portable-common-wasmjs-klib-build', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + [mapping, probe].join(','), '-Xir-produce-klib-file', '-ir-output-dir', path.join(outputRoot, 'klib'), '-ir-output-name', 'source-lines', mapping, probe, path.join(outputRoot, 'SourceLinesWasm.kt')]);
    await run('portable-common-wasmjs-module-build', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/source-lines.klib'), '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'source-lines', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
    const moduleUrl = pathToFileURL(path.join(outputRoot, 'wasm/source-lines.mjs')).href;
    const nodeArgs = ['--experimental-wasm-exnref', '--input-type=module', '-e', 'const m = await import(process.argv[1]); process.stdout.write(m.sourceLinesObservation());', moduleUrl];
    const observedWasm = (await execute(process.execPath, nodeArgs, { cwd: outputRoot, timeout: 30000, maxBuffer: 8 * 1024 * 1024 })).stdout;
    commands.push({ phase: 'portable-node-wasmjs-observe', command: [process.execPath, ...nodeArgs], exitCode: 0 });
    assert.equal(observedWasm, observedOriginal, 'Original JVM/Node Wasm mapping differs');
    console.log('phase: offline-chromium-worker-observe');
    const browser = await chromiumObservation(outputRoot, observedOriginal);
    const observationFiles = [['original-jvm.txt', observedOriginal], ['portable-jvm.txt', observedJvm], ['portable-wasmjs.txt', observedWasm]];
    for (const [name, text] of observationFiles) await writeFile(path.join(outputRoot, name), text, { flag: 'wx', mode: 0o600 });
    const names = ['OriginalJvmMapping.kt', 'jvm/original.jar', 'jvm/common.jar', 'klib/source-lines.klib', ...observationFiles.map(([name]) => name)];
    for (const name of await readdir(path.join(outputRoot, 'wasm'))) names.push('wasm/' + name);
    const outputs = [];
    for (const name of names.sort()) { const bytes = await readRegular(path.join(outputRoot, name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
    const receipt = { schemaVersion: 1, kind: 'official-kotlin-source-lines-jvm-common-wasm-chromium-differential', source: lock.source,
        sourceLockSha256: sha256(lockBytes), preparationReceiptSha256: sha256(await readRegular(prepared.receiptPath)), originalMapping: mappingPin,
        buildToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), observers, sourceLinesSearch: lock.sourceLinesSearch,
        originalJvmBoundary: 'Whole original source with only the two IntelliJ imports relocated to the genuine bootstrap distribution; JVM reader and PSI declarations compiled but unexecuted',
        bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
        commands, outputs, browser, comparison: { observations: observedOriginal.trimEnd().split('\n').length,
            observationSha256: sha256(Buffer.from(observedOriginal)), originalJvmEqualsCommonJvm: true, originalJvmEqualsNodeWasm: true, originalJvmEqualsOfflineChromium: true,
            rawCrLfPreserved: true, utf16Offsets: true, duplicateOffsetMidpointPreserved: true, liveArrayMutationPreserved: true },
        fullCompilerBuilt: false, actualFirDiagnosticExecution: 'not-run', publicLanguageSupport: false };
    await writeJson(path.join(outputRoot, 'source-lines-receipt.json'), receipt); return { outputRoot, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        assert.equal(process.argv.length, 4, 'Usage: source-lines-probe.mjs SOURCE_ROOT OUTPUT_ROOT');
        const result = await buildSourceLinesProbe({ sourceRoot: process.argv[2], outputRoot: process.argv[3] });
        console.log(JSON.stringify({ outputRoot: result.outputRoot, observations: result.receipt.comparison.observations, comparison: result.receipt.comparison }));
    } catch (error) { console.error(error); process.exitCode = 1; }
}
