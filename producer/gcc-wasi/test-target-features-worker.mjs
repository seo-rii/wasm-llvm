#!/usr/bin/env node
// Real SDK GCC/assembler/linker Workers. Enabling SIMD and actually emitting
// SIMD are deliberately separate assertions (the scalar-enabled regression).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { identity, readNativeTree } from '../clang-browser/cross/package.mjs';
import { cases } from './target-features-fixtures.mjs';
import { inspectTargetFeatures } from './inspect-target-features.mjs';
import { verifyWabtAssemblerReceipt } from './package.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  assert(['sdk-root', 'bundle', 'native-qualification', 'work', 'output'].includes(key) && process.argv[i + 1] && !options[key], `Invalid argument ${process.argv[i]}`);
  options[key] = path.resolve(process.argv[i + 1]);
}
for (const key of ['sdk-root', 'bundle', 'native-qualification', 'work', 'output']) assert(options[key], `Required --${key}`);
const { bundle, work, output } = options, sdkRoot = options['sdk-root'];
await fs.mkdir(output);
const require = createRequire(path.join(sdkRoot, 'package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')));
const { chromium } = require('playwright-core');
const inputs = new Map();
async function readInput(file) { const bytes = await fs.readFile(file); inputs.set(file, identity(bytes)); return bytes; }
const lock = JSON.parse(await readInput(path.join(here, 'sources.lock.json')));
const proof = JSON.parse(await readInput(options['native-qualification']));
assert.equal(proof.status, 'passed'); assert.equal(proof.inputsUnchanged, true);
assert.deepEqual(proof.cases.map(entry => entry.id), cases.map(fixture => fixture.id));
const manifestBytes = await readInput(path.join(bundle, 'gcc-toolchain.v2.json')), manifest = JSON.parse(manifestBytes);
assert.deepEqual(manifest.provenance.gccSource, proof.compilerSource, 'Native and browser GCC sources differ');
const assemblerReceipt = JSON.parse(await readInput(path.join(work, 'wabt-browser/provenance.json')));
const recipes = Object.fromEntries(await Promise.all(['build-wabt.sh', 'prepare-source.py', 'sources.lock.json'].map(async name => [name, identity(await readInput(path.join(here, name)))])));
verifyWabtAssemblerReceipt(assemblerReceipt, lock.wabt, recipes);
assert.deepEqual(assemblerReceipt.source, proof.assemblerSource);
const assets = new Map([['gcc-toolchain.v2.json', manifestBytes]]);
for (const asset of Object.values(manifest.assets)) {
  assert(!path.isAbsolute(asset.path) && !asset.path.split('/').includes('..'));
  const bytes = await readInput(path.join(bundle, asset.path));
  assert.deepEqual(identity(bytes), { bytes: asset.bytes, sha256: asset.sha256 }); assets.set(asset.path, bytes);
}
for (const [key, name] of [['asJs', 'as.mjs'], ['asWasm', 'as.wasm']]) assert.deepEqual(identity(assets.get(manifest.assets[key].path)), assemblerReceipt.files[name]);
await readInput(fileURLToPath(import.meta.url));
for (const name of ['target-features-fixtures.mjs', 'inspect-target-features.mjs', 'package.mjs']) await readInput(path.join(here, name));
const sdkInputs = {};
for (const directory of ['packages/gcc/dist', 'packages/core/dist', 'node_modules/@bjorn3/browser_wasi_shim'])
  for (const file of await readNativeTree(path.join(sdkRoot, directory))) sdkInputs[`${directory}/${file.path}`] = identity(file.bytes);
const browserHelper = path.join(sdkRoot, 'scripts/rust-browser-probe-lib.mjs');
await readInput(browserHelper);
const { resolveChromiumExecutable } = await import(pathToFileURL(browserHelper));
const validator = path.join(work, 'wabt-native/wasm-validate'), objdump = path.join(work, 'wabt-native/wasm-objdump');
await readInput(validator); await readInput(objdump);
const runner = path.join(output, 'run-wasi.mjs');
await fs.writeFile(runner, `import { WASI } from 'node:wasi';\nimport { readFile } from 'node:fs/promises';\nconst wasi = new WASI({version:'preview1',args:['program'],env:{},returnOnExit:true});\nconst module = await WebAssembly.compile(await readFile(process.argv[2]));\nprocess.exitCode = wasi.start(await WebAssembly.instantiate(module,{wasi_snapshot_preview1:wasi.wasiImport}));\n`);
const report = { kind: 'gcc-wasi-target-features-sdk-worker-qualification', status: 'running', execution: 'chromium-module-workers-and-node-wasi',
  manifest: identity(manifestBytes), compilerSource: proof.compilerSource, assemblerSource: proof.assemblerSource, sdkInputs, cases: [] };
let server, browser;
try {
  const aliases = [
    ['@wasm-idle/gcc', 'packages/gcc/dist/index.js'], ['@wasm-idle/core', 'packages/core/dist/index.js'],
    ['@wasm-idle/core/runtime-asset-loader', 'packages/core/dist/runtime-asset-loader.js'], ['@wasm-idle/core/runtime-tar', 'packages/core/dist/runtime-tar.js'],
  ];
  server = await createServer({ configFile: false, root: sdkRoot, cacheDir: path.join(output, 'vite-cache'), logLevel: 'error',
    optimizeDeps: { noDiscovery: true }, resolve: { alias: aliases.map(([name, file]) => ({ find: new RegExp(`^${name}$`), replacement: path.join(sdkRoot, file) })) },
    server: { host: '127.0.0.1', port: 0, watch: null, fs: { allow: [sdkRoot] } },
    plugins: [{ name: 'target-features-bundle', configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname === '/target-features-probe') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>GCC target features</title>'); return; }
        if (!url.pathname.startsWith('/bundle/')) { next(); return; }
        const name = url.pathname.slice('/bundle/'.length), bytes = assets.get(name);
        if (!bytes) { response.writeHead(404).end(); return; }
        response.setHeader('Content-Type', name.endsWith('.mjs') ? 'text/javascript' : name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
        response.setHeader('Cache-Control', 'no-store'); response.end(bytes);
      });
    } }] });
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: await resolveChromiumExecutable(process.env.WASM_IDLE_CHROMIUM_EXECUTABLE || '') });
  report.browser = await browser.version(); const page = await browser.newPage();
  await page.goto(`${origin}/target-features-probe`);
  report.identity = await page.evaluate(async ({ origin, sha256 }) => {
    const { createGccWorker } = await import(`${origin}/packages/gcc/dist/index.js`);
    globalThis.compiler = await createGccWorker({ target: 'wasm32-wasi', manifestUrl: `${origin}/bundle/gcc-toolchain.v2.json`, manifestSha256: sha256, signal: AbortSignal.timeout(300000) });
    return globalThis.compiler.identity;
  }, { origin, sha256: report.manifest.sha256 });
  assert.equal(report.identity.compilerCommit, lock.gcc.commit);
  assert.equal(report.identity.manifestSha256, report.manifest.sha256);
  for (const fixture of cases) {
    const entry = { id: fixture.id, status: 'running', fixture: identity(Buffer.from(JSON.stringify(fixture))), source: identity(Buffer.from(fixture.request.code)) };
    report.cases.push(entry);
    const actual = await page.evaluate(async fixture => {
      const captures = [];
      for (const emit of ['assembly', 'object', 'executable']) {
        const { artifact, ...compilation } = await globalThis.compiler.compile({ ...fixture.request, emit }, { signal: AbortSignal.timeout(600000) });
        if (!artifact) throw new Error(JSON.stringify(compilation));
        const chunks = []; for (let i = 0; i < artifact.bytes.length; i += 32768) chunks.push(String.fromCharCode(...artifact.bytes.subarray(i, i + 32768)));
        const capture = { emit, compilation, base64: btoa(chunks.join('')), inspection: artifact.wasm };
        if (emit === 'executable') capture.execution = await globalThis.compiler.run(artifact, { stdin: fixture.stdin, signal: AbortSignal.timeout(30000) });
        captures.push(capture);
      }
      return captures;
    }, fixture);
    entry.captures = [];
    for (const capture of actual) {
      assert.equal(capture.compilation.exitCode, 0);
      const tools = capture.emit === 'assembly' ? ['cc1'] : capture.emit === 'object' ? ['cc1', 'as'] : ['cc1', 'as', 'ld'];
      assert.deepEqual(capture.compilation.stages.map(stage => stage.tool), tools);
      for (const stage of capture.compilation.stages) assert.equal(stage.exitCode, 0);
      const argv = capture.compilation.stages[0].argv;
      assert.deepEqual(argv.filter(arg => /^-O/.test(arg)), [`-O${fixture.request.optimization}`]);
      assert.deepEqual(argv.filter(arg => /^-m(?:no-)?simd128$/.test(arg)), [fixture.request.simd ? '-msimd128' : '-mno-simd128']);
      assert.deepEqual(argv.filter(arg => arg.startsWith('-std=')), [`-std=${fixture.request.standard}`]);
      const bytes = Buffer.from(capture.base64, 'base64'), suffix = { assembly: 'wat', object: 'o', executable: 'wasm' }[capture.emit];
      const file = path.join(output, `${fixture.id}.${suffix}`); await fs.writeFile(file, bytes);
      const evidence = { emit: capture.emit, ...identity(bytes), compilation: capture.compilation, inspection: capture.inspection };
      if (capture.emit !== 'assembly') {
        const metadata = inspectTargetFeatures(bytes); evidence.metadata = metadata;
        assert.equal(metadata.features.simd128 === '+', fixture.usesSimd);
        assert.equal(metadata.sections.includes('linking'), capture.emit === 'object');
        if (capture.emit === 'object') {
          assert.deepEqual(metadata.features, fixture.usesSimd ? { simd128: '+' } : {});
          const disassembly = spawnSync(objdump, ['-d', file], { encoding: 'utf8' }); assert.equal(disassembly.status, 0, disassembly.stderr);
          assert.equal(/\b(?:v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\./u.test(disassembly.stdout), fixture.usesSimd);
          await fs.writeFile(path.join(output, `${fixture.id}.disassembly.txt`), disassembly.stdout);
          evidence.disassembly = identity(Buffer.from(disassembly.stdout));
        }
      }
      if (capture.emit === 'executable') {
        assert(capture.compilation.stages.at(-1).argv.includes('--fatal-warnings'));
        assert.equal(capture.inspection.features.simd128, fixture.usesSimd, 'SDK decoder must reflect actual use, not the enabled compiler flag');
        assert.equal(WebAssembly.validate(bytes), true);
        const restricted = spawnSync(validator, ['--disable-simd', file], { encoding: 'utf8' });
        assert.equal(restricted.status, fixture.usesSimd ? 1 : 0); evidence.simdDisabledValidation = { status: restricted.status, stderr: restricted.stderr };
        for (const field of ['exitCode', 'stdout', 'stderr']) assert.equal(capture.execution[field], { exitCode: 0, stdout: fixture.stdout, stderr: '' }[field]);
        const node = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', runner, file], { encoding: 'utf8', timeout: 30000 });
        assert.equal(node.status, 0, node.stderr); assert.equal(node.stdout, fixture.stdout); assert.equal(node.stderr, '');
        entry.chromiumWorker = capture.execution; entry.node = { exitCode: node.status, stdout: node.stdout, stderr: node.stderr };
      }
      entry.captures.push(evidence);
    }
    entry.status = 'passed';
  }
  await page.evaluate(() => globalThis.compiler.dispose());
  for (const [name, expected] of inputs) assert.deepEqual(identity(await fs.readFile(name)), expected, `Input changed: ${name}`);
  for (const [name, expected] of Object.entries(sdkInputs)) assert.deepEqual(identity(await fs.readFile(path.join(sdkRoot, name))), expected, `SDK input changed: ${name}`);
  report.inputsUnchanged = true; report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally { await browser?.close(); await server?.close(); }
report.inputs = Object.fromEntries(inputs);
await fs.writeFile(path.join(output, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, browser: report.browser, cases: report.cases.length, error: report.error, output }));
