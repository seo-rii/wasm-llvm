import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { validateTargetReceipt } from '../baseline.mjs';
import { loadRecipe } from '../prepare.mjs';
import { readRegular, sha256, writeJson, assertNoSymlink } from '../../scripts/source.mjs';
import { cases, verifyResults } from './cases.mjs';
import { observeBrowser } from './browser.mjs';

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
const sourceFile = path.join(output, 'ConsoleRuntime.kt');
await writeFile(sourceFile, await readRegular(path.join(HERE, 'ConsoleRuntime.kt')), { flag: 'wx', mode: 0o600 });
await writeFile(path.join(output, 'cases.mjs'), await readRegular(path.join(HERE, 'cases.mjs')), { flag: 'wx', mode: 0o600 });
await writeJson(path.join(output, 'cases.json'), cases);
const consumer = path.resolve(REPO, '../wasm-idle'), require = createRequire(path.join(consumer, 'package.json'));
const ts = require('typescript'), compilerToolFile = require.resolve('typescript');
const compilerToolBytes = await readRegular(compilerToolFile, 16 * 1024 * 1024);
const modules = {}, consumerFiles = [];
await mkdir(path.join(output, 'consumer')); await writeJson(path.join(output, 'consumer/package.json'), { type: 'module' });
for (const name of ['wasi', 'program', 'program.worker']) {
    const filename = path.join(consumer, 'runtimes/wasm-kotlin/src/' + name + '.ts'), bytes = await readRegular(filename);
    const result = ts.transpileModule(bytes.toString(), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
    assert.deepEqual(result.diagnostics ?? [], []); modules[name] = result.outputText;
    await writeFile(path.join(output, 'consumer', name + '.ts'), bytes, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(output, 'consumer', name + '.js'), result.outputText, { flag: 'wx', mode: 0o600 });
    consumerFiles.push({ filename, bytes: bytes.length, sha256: sha256(bytes), generatedSha256: sha256(Buffer.from(result.outputText)) });
}
const commands = [], execute = promisify(execFile);
async function run(phase, command, args) {
    console.log('phase: ' + phase); const started = performance.now();
    try {
        const result = await execute(command, args, { cwd: output, timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
        await writeFile(path.join(output, phase + '.stdout'), result.stdout, { flag: 'wx', mode: 0o600 });
        await writeFile(path.join(output, phase + '.stderr'), result.stderr, { flag: 'wx', mode: 0o600 });
        commands.push({ phase, command: [command, ...args], exitCode: 0, elapsedMs: performance.now() - started }); return result.stdout;
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
await run('source', 'java', [...compiler, ...flags, '-ir-output-dir', path.join(output, 'klib'), '-ir-output-name', 'console-runtime', sourceFile]);
await run('binary', 'java', [...compiler, ...flags, '-Xir-produce-js', '-Xinclude=' + path.join(output, 'klib/console-runtime.klib'),
    '-ir-output-dir', path.join(output, 'program'), '-ir-output-name', 'console-runtime']);
const wasm = await readRegular(path.join(output, 'program/console-runtime.wasm'), 16 * 1024 * 1024);
await writeFile(path.join(output, 'run-node.mjs'), `import {readFile,writeFile} from 'node:fs/promises';
import {runKotlinWasiProgram} from './consumer/program.js';
import {cases,verifyResults} from './cases.mjs';
const bytes=new Uint8Array(await readFile(new URL('./program/console-runtime.wasm',import.meta.url))), results=[];
for(const test of cases) results.push({id:test.id,result:await runKotlinWasiProgram({bytes,stdin:new Uint8Array(test.stdin),maxProgramBytes:8388608,maxStdinBytes:8388608,maxOutputBytes:test.maxOutputBytes})});
await writeFile(new URL('./node.json',import.meta.url),JSON.stringify(results,null,2)+'\\n',{flag:'wx',mode:0o600});
verifyResults(results);console.log(JSON.stringify({cases:results.length,status:'pass'}));
`, { flag: 'wx', mode: 0o600 });
await run('node', process.execPath, ['--experimental-wasm-exnref', path.join(output, 'run-node.mjs')]);
const node = JSON.parse(await readRegular(path.join(output, 'node.json')));
console.log('phase: actual-consumer-offline-workers');
const chromium = await observeBrowser({ modules, wasm, cases });
await writeJson(path.join(output, 'chromium.json'), chromium);
const observations = chromium.results.map(({ id, result }) => ({ id, result })); verifyResults(observations);
assert.deepEqual(observations, node);
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
for (const name of ['ConsoleRuntime.kt', 'cases.mjs', 'browser.mjs', 'check.mjs']) {
    const bytes = await readRegular(path.join(HERE, name)); localTools.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
}
await writeJson(path.join(output, 'receipt.json'), { schemaVersion: 1, kind: 'actual-selected-target-kotlin-consumer-console-corpus', status: 'pass', outputRoot: output,
    source: recipe.source, stdlib: buildReceipt.stdlib, stdlibFile, stdlibBuildReceipt: { filename: path.join(stdlibBuild, 'stdlib-receipt.json'), sha256: sha256(buildReceiptBytes) },
    compiler: { version: bootstrap.lock.version, sourceCommit: null, role: 'official-bootstrap', artifacts: bootstrap.artifacts },
    consumerFiles, typescript: { version: ts.version, filename: compilerToolFile, bytes: compilerToolBytes.length, sha256: sha256(compilerToolBytes) },
    commands, artifacts, localTools, cases: cases.length, rawNodeEqualsChromium: true, normalization: false, browser: chromium.browser,
    fullWasiAcceptance: false, compilerR0R1: false, browserKotlinCompilation: false, languageReadiness: false,
    cancellation: 'not-run', streamingStdin: 'unsupported', hardMemoryLimit: 'not-established' });
console.log(JSON.stringify({ status: 'pass', outputRoot: output, cases: cases.length, offlineWorkers: cases.length }));
