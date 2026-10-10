import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { prepareImmutableDependency, verifyImmutableDependency } from './immutable.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const REPO = path.resolve(HERE, '../../../..');
const execute = promisify(execFile);

async function browserObservation(outputRoot, assets) {
    const { chromium } = createRequire(path.resolve(REPO, '../wasm-idle/package.json'))('playwright-core');
    const origin = 'https://compiler-immutable-unit.invalid';
    const browser = await chromium.launch({ headless: true }); const externalRequests = [], staticRequests = [], requestsDuringObservation = [];
    try {
        const context = await browser.newContext();
        await context.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.origin === origin && url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Immutable compiler dependency</title>' });
            const name = url.pathname.startsWith('/assets/') ? url.pathname.slice(8) : null;
            if (url.origin === origin && assets.has(name)) {
                staticRequests.push(name); return route.fulfill({ status: 200, contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: assets.get(name) });
            }
            externalRequests.push(route.request().url()); await route.abort();
        });
        const page = await context.newPage(); await page.goto(origin);
        const source = `import {immutableProbe} from '${origin}/assets/immutable-probe.mjs';
            self.onmessage=()=>{try{self.postMessage({kind:'observed',snapshot:immutableProbe(),repeated:immutableProbe()});}
            catch(error){self.postMessage({kind:'fatal',message:String(error)});}};self.postMessage({kind:'ready'});`;
        await page.evaluate(async source => {
            window.probeWorkerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
            window.probeWorker = new Worker(window.probeWorkerUrl, { type: 'module' });
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Immutable Worker initialization timeout')), 30000);
                window.probeWorker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
                window.probeWorker.onmessage = ({ data }) => { clearTimeout(timer); data.kind === 'ready' ? resolve() : reject(new Error(data.message)); };
            });
        }, source);
        await context.setOffline(true);
        const observeRequest = request => requestsDuringObservation.push(request.url()); context.on('request', observeRequest);
        let observation;
        try {
            observation = await page.evaluate(() => new Promise((resolve, reject) => {
                const timer = setTimeout(() => { window.probeWorker.terminate(); reject(new Error('Immutable observation timeout')); }, 30000);
                window.probeWorker.onmessage = ({ data }) => { clearTimeout(timer); data.kind === 'observed' ? resolve(data) : reject(new Error(data.message)); };
                window.probeWorker.postMessage('observe');
            }));
        } finally { context.off('request', observeRequest); await page.evaluate(() => { window.probeWorker.terminate(); URL.revokeObjectURL(window.probeWorkerUrl); }); }
        assert.deepEqual(externalRequests, []); assert.deepEqual(requestsDuringObservation, []);
        return { ...observation, browserVersion: browser.version(), staticRequests, externalRequests, requestsDuringObservation, offlineAfterInitialization: true };
    } finally { await browser.close(); }
}

export async function runImmutableProbe(outputRoot) {
    outputRoot = path.resolve(outputRoot); assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    await assertNoSymlink(outputRoot); await mkdir(path.dirname(outputRoot), { recursive: true, mode: 0o700 }); await mkdir(outputRoot, { mode: 0o700 });
    const prepared = await prepareImmutableDependency({ outputRoot });
    const checked = await verifyImmutableDependency(path.dirname(prepared.receiptPath)); const bootstrap = await verifyBootstrap();
    const observerBytes = await readRegular(path.join(HERE, 'ImmutableProbe.kt')); const observer = path.join(outputRoot, 'ImmutableProbe.kt');
    await writeFile(observer, observerBytes, { flag: 'wx', mode: 0o600 });
    for (const directory of ['klib', 'wasm']) await mkdir(path.join(outputRoot, directory), { mode: 0o700 });
    const commands = [];
    async function run(phase, command, args) {
        const result = await execute(command, args, { cwd: outputRoot, timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
        if (result.stderr) process.stderr.write(result.stderr); commands.push({ phase, command: [command, ...args], exitCode: 0 }); return result.stdout;
    }
    const compiler = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler',
        '-Xwasm-target=wasm-js', '-language-version', '2.5', '-api-version', '2.5',
        '-libraries', [bootstrap.wasmJsStdlib, checked.libraryPath].join(path.delimiter)];
    await run('actual-immutable-consumer-source-to-wasmjs-klib', 'java', [...compiler, '-Xir-produce-klib-file',
        '-ir-output-dir', path.join(outputRoot, 'klib'), '-ir-output-name', 'immutable-probe', observer]);
    await run('actual-immutable-consumer-wasmjs-link', 'java', [...compiler, '-Xir-produce-js',
        '-Xinclude=' + path.join(outputRoot, 'klib/immutable-probe.klib'), '-ir-output-dir', path.join(outputRoot, 'wasm'),
        '-ir-output-name', 'immutable-probe', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
    const nodeObserved = await run('actual-immutable-node-observation', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
        'const m=await import(process.argv[1]);const first=m.immutableProbe();const second=m.immutableProbe();if(first!==second)throw new Error("Unstable immutable snapshots");process.stdout.write(first);',
        pathToFileURL(path.join(outputRoot, 'wasm/immutable-probe.mjs')).href]);
    const assets = new Map(); const outputs = [];
    for (const item of await readdir(path.join(outputRoot, 'wasm'), { withFileTypes: true })) {
        assert(item.isFile()); const bytes = await readRegular(path.join(outputRoot, 'wasm', item.name));
        assets.set(item.name, bytes); outputs.push({ path: 'wasm/' + item.name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const browser = await browserObservation(outputRoot, assets); assert.equal(browser.snapshot, nodeObserved); assert.equal(browser.repeated, nodeObserved);
    const probeKlib = await readRegular(path.join(outputRoot, 'klib/immutable-probe.klib'));
    outputs.push({ path: 'klib/immutable-probe.klib', bytes: probeKlib.length, sha256: sha256(probeKlib) });
    const receipt = { schemaVersion: 1, kind: 'official-compiler-immutable-wasmjs-compatibility', result: 'pass',
        dependency: checked.receipt, dependencyReceiptSha256: checked.receiptSha256,
        buildToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
        observer: { path: 'ImmutableProbe.kt', bytes: observerBytes.length, sha256: sha256(observerBytes) },
        bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null,
            artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
        commands, outputs, observation: nodeObserved, nodeVersion: process.version, browser,
        acceptance: 'Actual declared persistent collection dependency compiles and executes with current bootstrap; not whole compiler acceptance',
        fullCompilerBuilt: false, freshBrowserSourceCompilation: 'not-run', languageReadiness: false };
    const receiptPath = path.join(outputRoot, 'compatibility.json'); await writeJson(receiptPath, receipt);
    return { receiptPath, observation: nodeObserved, browser: browser.browserVersion, result: 'pass' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2); assert.equal(args.length, 2); assert.equal(args[0], '--output');
    console.log(JSON.stringify(await runImmutableProbe(args[1])));
}
