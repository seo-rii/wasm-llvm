import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { validateTargetReceipt } from '../baseline.mjs';
import { loadRecipe } from '../prepare.mjs';
import { readRegular, sha256, verifyFile, writeJson, assertNoSymlink } from '../../scripts/source.mjs';
import { observeInChromium } from './browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
assert.equal(process.argv.length, 3);
const output = path.resolve(process.argv[2]); assert(output.startsWith(path.join(REPO, 'out') + path.sep));
await assertNoSymlink(output); await mkdir(output, { mode: 0o700 });
const recipe = await loadRecipe(), recipeBytes = await readRegular(path.join(HERE, '../recipe.json'));
const sealed = JSON.parse(await readRegular(path.join(HERE, '../../evidence/stdlib-source-build.json')));
const stdlibBuild = path.resolve(sealed.outputBundle); assert(stdlibBuild.startsWith(path.join(REPO, 'out') + path.sep));
const buildReceiptBytes = await readRegular(path.join(stdlibBuild, 'stdlib-receipt.json')), buildReceipt = JSON.parse(buildReceiptBytes);
for (const key of Object.keys(buildReceipt)) assert.deepEqual(sealed[key], buildReceipt[key]);
validateTargetReceipt(buildReceipt, recipe, sha256(recipeBytes));
const bootstrap = await verifyBootstrap(); assert.equal(buildReceipt.compiler.jarSha256, bootstrap.artifacts.find(pin => pin.id === 'compiler').sha256);
const stdlibFile = path.join(stdlibBuild, buildReceipt.stdlib.path), stdlibBytes = await readRegular(stdlibFile);
assert.equal(stdlibBytes.length, buildReceipt.stdlib.bytes); assert.equal(sha256(stdlibBytes), buildReceipt.stdlib.sha256);
const metadata = JSON.parse(await readRegular(path.join(HERE, '../../patches/wasi-preview1-io.json')));
assert.equal(metadata.abi.subscriptionBytes, 48); assert.equal(metadata.abi.eventBytes, 32); assert.equal(metadata.abi.alignment, 8);
const references = [];
for (const pin of [metadata.patched, ...metadata.sourceDependencies]) {
    const filename = path.join(stdlibBuild, 'sources', pin.path); verifyFile(await readRegular(filename), pin);
    references.push({ filename, ...pin });
}
const headerFile = path.join(REPO, 'out/kotlin-stdlib-probe/prepared-a4a1fd62/abi/wasip1.h');
const header = verifyFile(await readRegular(headerFile), metadata.abi.header).toString();
assert(header.includes('#define __WASI_ERRNO_AGAIN (UINT16_C(6))'));
assert(header.includes('#define __WASI_EVENTTYPE_FD_WRITE (UINT8_C(2))'));
const sourceFile = path.join(output, 'AllocatorCanary.kt'), hostFile = path.join(output, 'host.mjs');
await writeFile(sourceFile, await readRegular(path.join(HERE, 'AllocatorCanary.kt')), { flag: 'wx', mode: 0o600 });
await writeFile(hostFile, await readRegular(path.join(HERE, 'host.mjs')), { flag: 'wx', mode: 0o600 });
const commands = [], execute = promisify(execFile);
async function run(phase, command, args) {
    console.log('phase: ' + phase); const start = performance.now();
    try {
        const result = await execute(command, args, { cwd: output, timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
        await writeFile(path.join(output, phase + '.stdout'), result.stdout, { flag: 'wx', mode: 0o600 });
        await writeFile(path.join(output, phase + '.stderr'), result.stderr, { flag: 'wx', mode: 0o600 });
        commands.push({ phase, command: [command, ...args], exitCode: 0, elapsedMs: performance.now() - start }); return result.stdout;
    } catch (error) {
        await writeJson(path.join(output, 'failure.json'), { phase, code: error.code, stderr: String(error.stderr ?? ''), commands });
        process.stderr.write(String(error.stderr ?? '').slice(-6000)); throw error;
    }
}
const compiler = ['-Xmx1g', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler'];
const flags = ['-Xwasm-target=wasm-wasi', '-libraries', stdlibFile, '-main', 'call',
    '-language-version', recipe.languageVersion, '-api-version', recipe.apiVersion,
    '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts', '-Xwasm-use-new-exception-proposal'];
await mkdir(path.join(output, 'klib')); await mkdir(path.join(output, 'program'));
await run('source', 'java', [...compiler, ...flags, '-ir-output-dir', path.join(output, 'klib'), '-ir-output-name', 'allocator-canary', sourceFile]);
await run('binary', 'java', [...compiler, ...flags, '-Xir-produce-js', '-Xinclude=' + path.join(output, 'klib/allocator-canary.klib'),
    '-ir-output-dir', path.join(output, 'program'), '-ir-output-name', 'allocator-canary']);
const wasmFile = path.join(output, 'program/allocator-canary.wasm'), wasm = await readRegular(wasmFile, 16 * 1024 * 1024);
await writeFile(path.join(output, 'run-node.mjs'), `import {readFile} from 'node:fs/promises';\nimport {observeAllocatorCanary} from './host.mjs';\nconsole.log(JSON.stringify(await observeAllocatorCanary(await readFile(new URL('./program/allocator-canary.wasm',import.meta.url)))));\n`, { flag: 'wx', mode: 0o600 });
const node = JSON.parse(await run('node', process.execPath, ['--experimental-wasm-exnref', path.join(output, 'run-node.mjs')]));
await writeJson(path.join(output, 'node.json'), node);
console.log('phase: fresh-offline-chromium-workers');
const chromium = await observeInChromium((await readRegular(hostFile)).toString(), wasm);
assert.deepEqual(chromium.observations[0], node); await writeJson(path.join(output, 'chromium.json'), chromium);
const artifacts = [];
async function inventory(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, item.name);
        if (item.isDirectory()) await inventory(filename);
        else { const bytes = await readRegular(filename, 16 * 1024 * 1024); artifacts.push({ path: path.relative(output, filename), bytes: bytes.length, sha256: sha256(bytes) }); }
    }
}
await inventory(output);
const localTools = [];
for (const name of ['AllocatorCanary.kt', 'host.mjs', 'browser.mjs', 'check.mjs']) {
    const bytes = await readRegular(path.join(HERE, name)); localTools.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
}
const receipt = { schemaVersion: 1, kind: 'selected-source-wasi-allocator-and-poll-canaries', status: 'pass', outputRoot: output,
    source: recipe.source, stdlib: buildReceipt.stdlib, stdlibFile, stdlibBuildReceipt: { filename: path.join(stdlibBuild, 'stdlib-receipt.json'), sha256: sha256(buildReceiptBytes) },
    compiler: { version: bootstrap.lock.version, sourceCommit: null, role: 'official-bootstrap', artifacts: bootstrap.artifacts },
    abi: { ...metadata.abi, filename: headerFile }, sourceReferences: references, commands, artifacts, localTools,
    allocations: node.allocations.length, realPatchedPollCallsPerRun: node.polls.length, executions: 3,
    rawNodeEqualsBothChromiumWorkers: true, normalization: false, browser: chromium.browser,
    originalSizeProbeIsPatchedAllocator: true, unpatchedStdlibExecuted: false, actualUnpatchedCorruptionClaimed: false,
    fullWasiAcceptance: false, compilerR0R1: false, browserKotlinCompilation: false, languageReadiness: false };
await writeJson(path.join(output, 'receipt.json'), receipt);
console.log(JSON.stringify({ result: 'pass', outputRoot: output, allocationsPerRun: receipt.allocations, realPollCallsPerRun: receipt.realPatchedPollCallsPerRun, executions: receipt.executions }));
