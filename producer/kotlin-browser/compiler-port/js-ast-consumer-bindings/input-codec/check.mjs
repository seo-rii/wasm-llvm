#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { readRegular, sha256, verifyFile, writeJson } from '../../../scripts/source.mjs';
import { verifyBootstrap } from '../../../build/bootstrap.mjs';
import { prepareCompilerTextSources, verifyCompilerTextPreparation } from '../../text/prepare.mjs';
import { observeAstInChromium } from '../../js-ast/browser.mjs';
import { prepareJsAstInput, verifyJsAstInput } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../../..');
const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
const parent = path.join(REPO, 'out/kotlin-js-ast-input'); await mkdir(parent, { recursive: true, mode: 0o700 });
const output = await mkdtemp(path.join(parent, 'run-')), local = name => path.join(output, name);
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const prepared = await prepareJsAstInput({ sourceRoot, outputRoot: local('input') });
await verifyJsAstInput({ sourceRoot, outputRoot: local('input'), receiptPath: prepared.receiptPath });
const text = await prepareCompilerTextSources({ sourceRoot, outputRoot: local('text') });
await verifyCompilerTextPreparation(path.dirname(text.receiptPath));
const sharedText = text.commonSources.filter(filename => lock.sharedDependencies.some(pin => pin.path === path.basename(filename)));
assert.equal(sharedText.length, 2);
for (const pin of lock.observers) await writeFile(local(pin.path), verifyFile(await readRegular(path.join(HERE, pin.path)), pin), { flag: 'wx', mode: 0o600 });
const bootstrap = await verifyBootstrap(), stdlib = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path;
const flagsBytes = await readRegular(path.join(HERE, '../../build-flags.json')), flags = JSON.parse(flagsBytes);
const run = promisify(execFile), commands = [];
async function execute(phase, executable, args) { console.log('phase: ' + phase); const result = await run(executable, args, { timeout: 240000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
    if (result.stderr) process.stderr.write(result.stderr); commands.push({ phase, command: [executable, ...args], exitCode: 0 }); return result.stdout; }
const java = ['-Xmx768m', '-cp', bootstrap.classPath];
const jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', flags.languageVersion,
    '-api-version', flags.apiVersion, ...flags.compilerFlags, '-classpath', stdlib];
await execute('actual-jdk-input-jvm-build', 'java', [...jvm, '-d', local('original.jar'), local('Probe.kt'), local('OriginalSupport.kt'), local('JvmEntry.kt')]);
const common = [...prepared.commonSources, ...sharedText, local('Probe.kt'), local('CommonSupport.kt')];
await execute('common-input-jvm-build', 'java', [...jvm, '-d', local('portable.jar'), ...common, local('JvmEntry.kt')]);
const original = JSON.parse(await execute('actual-jdk-input-jvm-observe', 'java', ['-ea', '-cp', [local('original.jar'), stdlib].join(path.delimiter), 'org.jetbrains.kotlin.js.inputprobe.JvmEntryKt']));
const portable = JSON.parse(await execute('common-input-jvm-observe', 'java', ['-ea', '-cp', [local('portable.jar'), stdlib].join(path.delimiter), 'org.jetbrains.kotlin.js.inputprobe.JvmEntryKt']));
await writeJson(local('original-jvm.json'), original); await writeJson(local('portable-jvm.json'), portable); assert.deepEqual(portable.records, original.records);
await mkdir(local('klib')); await mkdir(local('wasm'));
const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-language-version', flags.languageVersion,
    '-api-version', flags.apiVersion, ...flags.compilerFlags, '-libraries', bootstrap.wasmJsStdlib];
await execute('common-input-wasm-klib', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-ir-output-dir', local('klib'), '-ir-output-name', 'ast-input', ...common, local('WasmEntry.kt')]);
await execute('common-input-wasm-module', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + local('klib/ast-input.klib'), '-ir-output-dir', local('wasm'), '-ir-output-name', 'js-ast', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const node = JSON.parse(await execute('common-input-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const module=await import(process.argv[1]);console.log(module.astProbeJson());', pathToFileURL(local('wasm/js-ast.mjs')).href]));
await writeJson(local('portable-wasm.json'), node); assert.deepEqual(node.records, original.records);
const browser = await observeAstInChromium(output, original.records); await writeFile(local('portable-chromium.json'), browser.raw, { flag: 'wx', mode: 0o600 });
const outputs = [];
async function collect(directory) { for (const item of await readdir(local(directory), { withFileTypes: true })) { const name = directory ? directory + '/' + item.name : item.name;
    if (item.isDirectory()) await collect(name); else { const bytes = await readRegular(local(name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); } } }
await collect('');
const receipt = { schemaVersion: 1, kind: 'selected-js-ast-input-real-jdk-common-profile', source: lock.source,
    sourceLockSha256: sha256(lockBytes), checkToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), buildFlagsSha256: sha256(flagsBytes),
    preparation: prepared.receipt, textPreparation: text.receipt, commands, outputs,
    comparison: { observations: original.records.length, originalJvmEqualsCommonJvm: true, originalJvmEqualsNodeWasm: true, originalJvmEqualsOfflineChromium: true,
        skipped: 0, recordsSha256: sha256(Buffer.from(JSON.stringify(original.records))) },
    rawFailures: { originalJvm: original.failures, commonJvm: portable.failures, nodeWasm: node.failures, offlineChromium: browser.observation.failures },
    failureBoundary: 'Atomic underflow contract compares actual JDK BufferUnderflowException with explicit JsAstInputUnderflow; Java exception class and seek-message identity are not emulated. Raw failures retained.',
    browser: browser.receipt, javaFacadeIntroduced: false, consumerIntegrated: false, fullDeserializerBuilt: false, fullCompilerBuilt: false, languageReadiness: false };
await writeJson(local('receipt.json'), receipt); console.log(JSON.stringify({ output, comparison: receipt.comparison }));
