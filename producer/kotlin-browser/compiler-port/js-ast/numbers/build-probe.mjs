#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { verifyBootstrap } from '../../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../../..');
const execute = promisify(execFile);
export const defaultReferenceCache = path.join(repository, 'out/kotlin-js-ast-number-reference');

export function compareRawText(expected, actual, label) {
    if (actual === expected) return;
    const a = expected.split('\n'), b = actual.split('\n');
    const index = a.findIndex((line, i) => line !== b[i]);
    throw new Error(`${label} raw text differs at ${index}: original=${a[index]?.slice(0, 160)} portable=${b[index]?.slice(0, 160)}`);
}

export async function verifyNumberSources({ referenceCache = defaultReferenceCache } = {}) {
    referenceCache = path.resolve(referenceCache);
    const lockBytes = await readRegular(path.join(here, 'source.lock.json'));
    const lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1);
    assert.equal(lock.source.commit, '162dbac82cf31c6948414944af836187aff9e6ca');
    assert.equal(lock.consumerSource.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    assert.equal(lock.hostFormatterFallback, false); assert.equal(lock.rawComparisonRequired, true);
    assert.equal(lock.entry, 'javaDoubleToString(value: Double): String');
    assert.equal(new Set(lock.references.map(pin => pin.path)).size, 3);
    assert.deepEqual(lock.references.map(pin => pin.path), ['FloatingDecimal.java', 'FDBigInteger.java', 'Double.java']);
    assert.equal(lock.portedSource.path, '../portable/org/jetbrains/kotlin/js/util/AstDoubleFormat.kt');
    const portedPath = path.resolve(here, lock.portedSource.path);
    await assertNoSymlink(portedPath); const ported = verifyFile(await readRegular(portedPath), lock.portedSource);
    verifyFile(await readRegular(path.join(here, 'LICENSE.OpenJDK')), lock.license);
    for (const pin of lock.references) {
        assert.equal(pin.path, path.basename(pin.path));
        verifyFile(await readRegular(path.join(referenceCache, pin.path)), pin);
    }
    const closureBytes = await readRegular(path.join(here, '../../closure.lock.json'));
    assert.equal(sha256(closureBytes), lock.primaryClosureSha256);
    const closure = JSON.parse(closureBytes);
    for (const pin of lock.consumerOriginals) assert.deepEqual(pin, closure.files.find(item => item.path === pin.path));
    const double = (await readRegular(path.join(referenceCache, 'Double.java'))).toString('utf8');
    assert(/public static String toString\(double d\)\s*\{\s*return FloatingDecimal\.toJavaFormatString\(d\);\s*\}/.test(double), 'Original Double formatter delegation changed');
    return { lock, lockBytes, ported, referenceCache };
}

async function observeInChromium(outputRoot, expected) {
    const assets = new Map();
    for (const item of await readdir(path.join(outputRoot, 'wasm'), { withFileTypes: true })) {
        assert(item.isFile()); assets.set(item.name, await readRegular(path.join(outputRoot, 'wasm', item.name)));
    }
    const origin = 'https://kotlin-double-text.invalid';
    const workerSource = `import * as module from '${origin}/assets/double-text.mjs';
self.onmessage=()=>{try{self.postMessage({value:module.doubleTextObservation()});}catch(error){self.postMessage({error:String(error)});}};
self.postMessage({ready:true});`;
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext(); const assetRequests = [], externalRequests = [], offlineRequests = [];
        await context.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.origin === origin && url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Double text comparison</title>' });
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
                const worker = new Worker(url, { type: 'module' }); window.doubleWorker = worker;
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('Number Worker initialization deadline')), 30000);
                    worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
                    worker.onmessage = ({ data }) => { clearTimeout(timer); data.ready ? resolve() : reject(new Error(data.error)); };
                });
            } finally { URL.revokeObjectURL(url); }
        }, workerSource);
        await context.setOffline(true); context.on('request', request => offlineRequests.push(request.url()));
        const actual = await page.evaluate(() => new Promise((resolve, reject) => {
            const worker = window.doubleWorker;
            const timer = setTimeout(() => { worker.terminate(); reject(new Error('Offline number observation deadline')); }, 120000);
            worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
            worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); data.error ? reject(new Error(data.error)) : resolve(data.value); };
            worker.postMessage({ observe: true });
        }));
        compareRawText(expected, actual, 'Original JVM/offline Chromium');
        assert.deepEqual(externalRequests, []); assert.deepEqual(offlineRequests, []);
        return { engine: 'Chromium', version: browser.version(), moduleWorker: true, offlineAfterInitialization: true,
            assetRequests, externalRequests, offlineRequests, observationSha256: sha256(Buffer.from(actual)) };
    } finally { await browser.close(); }
}

export async function buildDoubleTextProbe({ outputRoot, referenceCache = defaultReferenceCache } = {}) {
    assert(outputRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    await assertNoSymlink(outputRoot); await mkdir(path.dirname(outputRoot), { recursive: true }); await mkdir(outputRoot, { mode: 0o700 });
    const input = await verifyNumberSources({ referenceCache }); const bootstrap = await verifyBootstrap();
    const observers = [];
    for (const name of ['DoubleProbe.kt', 'JvmDouble.kt', 'CommonDouble.kt', 'JvmEntry.kt', 'WasmDouble.kt']) {
        const bytes = await readRegular(path.join(here, name)); await writeFile(path.join(outputRoot, name), bytes, { flag: 'wx', mode: 0o600 });
        observers.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    await writeFile(path.join(outputRoot, 'AstDoubleFormat.kt'), input.ported, { flag: 'wx', mode: 0o600 });
    for (const directory of ['original-jdk', 'jvm', 'klib', 'wasm']) await mkdir(path.join(outputRoot, directory));
    const commands = [], stderrs = new Map();
    async function run(phase, command, args) {
        console.log('phase: ' + phase);
        const value = await execute(command, args, { cwd: outputRoot, timeout: 240000, maxBuffer: 20 * 1024 * 1024 });
        if (value.stderr) process.stderr.write(value.stderr); stderrs.set(phase, value.stderr);
        commands.push({ phase, command: [command, ...args], exitCode: 0 }); return value.stdout;
    }
    const originalJava = ['FloatingDecimal.java', 'FDBigInteger.java'].map(name => path.join(input.referenceCache, name));
    await run('pinned-openjdk17-formatter-build', 'javac', ['--patch-module', 'java.base=' + input.referenceCache, '-d', path.join(outputRoot, 'original-jdk'), ...originalJava]);
    const jdkVersion = await run('host-jdk-version', 'java', ['-version']) + stderrs.get('host-jdk-version');
    assert(/version "17\./.test(jdkVersion));
    const java = ['-Xmx512m', '-cp', bootstrap.classPath];
    const stdlib = bootstrap.artifacts.find(pin => pin.id === 'stdlib-jvm').path;
    const probe = path.join(outputRoot, 'DoubleProbe.kt'), helper = path.join(outputRoot, 'AstDoubleFormat.kt');
    const entry = path.join(outputRoot, 'JvmEntry.kt'), originalActual = path.join(outputRoot, 'JvmDouble.kt'), commonActual = path.join(outputRoot, 'CommonDouble.kt');
    const originalJar = path.join(outputRoot, 'jvm/original.jar'), commonJar = path.join(outputRoot, 'jvm/common.jar');
    const jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-language-version', '2.5', '-api-version', '2.5', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-classpath', stdlib];
    await run('original-jvm-observer-build', 'java', [...jvm, '-Xmulti-platform', '-Xcommon-sources=' + probe, '-d', originalJar, probe, originalActual, entry]);
    await run('portable-common-jvm-observer-build', 'java', [...jvm, '-Xmulti-platform', '-Xcommon-sources=' + [probe, helper].join(','), '-d', commonJar, probe, helper, commonActual, entry]);
    const main = 'org.jetbrains.kotlin.js.util.numbers.probe.JvmEntryKt';
    const original = await run('pinned-original-jvm-observe', 'java', ['--patch-module', 'java.base=' + path.join(outputRoot, 'original-jdk'), '-ea', '-cp', [originalJar, stdlib].join(path.delimiter), main]);
    const observedJvm = await run('portable-common-jvm-observe', 'java', ['-ea', '-cp', [commonJar, stdlib].join(path.delimiter), main]);
    compareRawText(original, observedJvm, 'Pinned original/common JVM');
    const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-language-version', '2.5', '-api-version', '2.5', '-libraries', bootstrap.wasmJsStdlib];
    await run('portable-common-wasmjs-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + [probe, helper].join(','), '-ir-output-dir', path.join(outputRoot, 'klib'), '-ir-output-name', 'double-text', probe, helper, commonActual, path.join(outputRoot, 'WasmDouble.kt')]);
    await run('portable-common-wasmjs-module-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/double-text.klib'), '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'double-text', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
    const moduleUrl = pathToFileURL(path.join(outputRoot, 'wasm/double-text.mjs')).href;
    const observedWasm = await run('portable-node-wasmjs-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e', 'const module=await import(process.argv[1]);process.stdout.write(module.doubleTextObservation());', moduleUrl]);
    compareRawText(original, observedWasm, 'Pinned original/Node Wasm');
    console.log('phase: offline-chromium-worker-observe');
    const browser = await observeInChromium(outputRoot, original);
    const texts = [['original-jvm.txt', original], ['portable-jvm.txt', observedJvm], ['portable-wasmjs.txt', observedWasm]];
    for (const [name, text] of texts) await writeFile(path.join(outputRoot, name), text, { flag: 'wx', mode: 0o600 });
    const names = ['AstDoubleFormat.kt', 'jvm/original.jar', 'jvm/common.jar', 'klib/double-text.klib', ...texts.map(([name]) => name)];
    async function addFiles(directory) {
        for (const item of await readdir(path.join(outputRoot, directory), { withFileTypes: true })) {
            const name = directory + '/' + item.name;
            if (item.isDirectory()) await addFiles(name); else { assert(item.isFile()); names.push(name); }
        }
    }
    await addFiles('wasm'); await addFiles('original-jdk'); const outputs = [];
    for (const name of names.sort()) { const bytes = await readRegular(path.join(outputRoot, name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
    const receipt = { schemaVersion: 1, kind: 'pinned-openjdk17-double-text-jvm-common-wasm-chromium-differential', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), portedSource: input.lock.portedSource, consumerSource: input.lock.consumerSource,
        referenceFiles: input.lock.references, buildToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), observers,
        originalJdk: { compiledSourceFiles: ['FloatingDecimal.java', 'FDBigInteger.java'],
            hostSupport: 'Recorded host JDK17 java.lang.Double delegates to the pinned patched FloatingDecimal; IEEE constant classes remain host support. No complete OpenJDK rebuild claimed.', version: jdkVersion },
        bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
        commands, outputs, browser, comparison: { observations: original.trimEnd().split('\n').length, observationSha256: sha256(Buffer.from(original)),
            originalJvmEqualsCommonJvm: true, originalJvmEqualsNodeWasm: true, originalJvmEqualsOfflineChromium: true,
            normalizedText: false, randomBitPatterns: 100000, everyExponent: true, bothSigns: true, decimalThresholdNeighbors: true,
            scope: 'Binary64-to-Java-text only; actual JS AST integration and full compiler execution remain separate acceptance checks' },
        fullCompilerBuilt: false, publicLanguageSupport: false };
    await writeJson(path.join(outputRoot, 'receipt.json'), receipt); return { outputRoot, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        assert.equal(process.argv.length, 3, 'Usage: build-probe.mjs OUTPUT_ROOT');
        const result = await buildDoubleTextProbe({ outputRoot: process.argv[2] });
        console.log(JSON.stringify({ outputRoot: result.outputRoot, comparison: result.receipt.comparison }));
    } catch (error) { console.error(error); process.exitCode = 1; }
}
