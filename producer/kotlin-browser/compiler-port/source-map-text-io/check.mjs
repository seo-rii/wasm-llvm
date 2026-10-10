#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { prepareCompilerTextSources, verifyCompilerTextPreparation } from '../text/prepare.mjs';
import { observeAstInChromium } from '../js-ast/browser.mjs';
import { prepareSourceMapTextIo, verifySourceMapTextIo } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
const parent = path.join(REPO, 'out/kotlin-source-map-text-io'); await mkdir(parent, { recursive: true, mode: 0o700 });
const output = await mkdtemp(path.join(parent, 'run-')), local = name => path.join(output, name);
const prepared = await prepareSourceMapTextIo({ outputRoot: local('common') }); await verifySourceMapTextIo({ outputRoot: local('common'), receiptPath: prepared.receiptPath });
const text = await prepareCompilerTextSources({ sourceRoot: path.join(REPO, 'out/kotlin-compiler-port/sources'), outputRoot: local('text') });
await verifyCompilerTextPreparation(path.dirname(text.receiptPath));
const textLock = JSON.parse(await readRegular(path.join(HERE, '../text/sources.lock.json')));
const utf8 = text.commonSources.filter(filename => [textLock.generatedAlgorithm, textLock.api].some(pin => path.basename(filename) === pin.path)); assert.equal(utf8.length, 2);
const observer = verifyFile(await readRegular(path.join(HERE, 'Probe.kt')), lock.observers.find(pin => pin.path === 'Probe.kt')).toString();
for (const common of [false, true]) {
    const name = common ? 'CommonSupport.kt' : 'OriginalSupport.kt'; const pin = lock.observers.find(pin => pin.path === name);
    const support = verifyFile(await readRegular(path.join(HERE, name)), pin).toString();
    await writeFile(local(common ? 'CommonProbe.kt' : 'OriginalProbe.kt'), support + '\n' + observer.replace(/^package[^\n]*\n/, ''), { flag: 'wx', mode: 0o600 });
}
for (const name of ['JvmEntry.kt', 'WasmEntry.kt']) {
    const pin = lock.observers.find(pin => pin.path === name); await writeFile(local(name), verifyFile(await readRegular(path.join(HERE, name)), pin), { flag: 'wx', mode: 0o600 });
}
const bootstrap = await verifyBootstrap(), stdlib = bootstrap.artifacts.find(pin => pin.id === 'stdlib-jvm').path;
const flagsBytes = await readRegular(path.join(HERE, '../build-flags.json')), flags = JSON.parse(flagsBytes), run = promisify(execFile), commands = [];
async function execute(phase, executable, args) {
    console.log('phase: ' + phase);
    const started = Date.now(), timeoutMs = 240000;
    try { const result = await run(executable, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
        if (result.stderr) process.stderr.write(result.stderr); commands.push({ phase, command: [executable, ...args], exitCode: 0, durationMs: Date.now() - started }); return result.stdout;
    } catch (error) {
        const failure = { phase, command: [executable, ...args], code: error.code ?? null, signal: error.signal ?? null,
            killed: error.killed ?? false, durationMs: Date.now() - started, timeoutMs, stderr: String(error.stderr ?? '').slice(-20000) };
        await writeJson(local(phase + '-failure.json'), failure); process.stderr.write(failure.stderr);
        throw new Error(phase + ' failed: ' + JSON.stringify({ code: failure.code, signal: failure.signal, killed: failure.killed, durationMs: failure.durationMs }));
    }
}
const java = ['-Xmx768m', '-cp', bootstrap.classPath];
const jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17',
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags, '-classpath', stdlib];
const oracleVersion = await execute('actual-jdk-version', 'java', ['--version']);
assert(oracleVersion.startsWith('openjdk 17.0.20.1 '), 'This profile pins the actual JDK17.0.20.1 close protocol; update references and rerun before using another oracle.');
await execute('actual-jdk-text-io-oracle-build', 'java', [...jvm, '-d', local('original.jar'), local('OriginalProbe.kt'), local('JvmEntry.kt')]);
const shared = [path.join(HERE, '../js-ast/portable/org/jetbrains/kotlin/js/util/AstSourceReader.kt'),
    path.join(HERE, '../js-ast-consumer-bindings/output-stream/JsAstStreamOutput.kt'), ...utf8];
const common = [...prepared.commonSources, ...shared, local('CommonProbe.kt')];
await execute('common-source-map-text-io-build', 'java', [...jvm, '-d', local('portable.jar'), ...common, local('JvmEntry.kt')]);
await mkdir(local('raw-files'), { mode: 0o700 });
const original = JSON.parse(await execute('actual-jdk-text-io-observe', 'java', ['-ea', '-Djava.io.tmpdir=' + local('raw-files'), '-cp', [local('original.jar'), stdlib].join(path.delimiter), 'org.jetbrains.kotlin.js.sourcemaptextprobe.JvmEntryKt']));
const portable = JSON.parse(await execute('common-jvm-text-io-observe', 'java', ['-ea', '-cp', [local('portable.jar'), stdlib].join(path.delimiter), 'org.jetbrains.kotlin.js.sourcemaptextprobe.JvmEntryKt']));
await writeJson(local('original-jvm.json'), original); await writeJson(local('portable-jvm.json'), portable);
function compare(actual, host) {
    assert.equal(actual.records.length, original.records.length);
    const index = original.records.findIndex((value, index) => value !== actual.records[index]);
    if (index >= 0) throw new Error(host + ' differs at ' + index + ': ' + original.records[index].slice(0, 1000) + ' <> ' + actual.records[index].slice(0, 1000));
}
compare(portable, 'Common JVM');
await mkdir(local('klib')); await mkdir(local('wasm'));
const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-language-version', flags.languageVersion,
    '-api-version', flags.apiVersion, ...flags.compilerFlags, '-libraries', bootstrap.wasmJsStdlib];
await execute('common-text-io-wasm-klib', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-ir-output-dir', local('klib'), '-ir-output-name', 'source-map-text-io', ...common, local('WasmEntry.kt')]);
await execute('common-text-io-wasm-module', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + local('klib/source-map-text-io.klib'), '-ir-output-dir', local('wasm'), '-ir-output-name', 'js-ast', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const node = JSON.parse(await execute('common-text-io-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const m=await import(process.argv[1]);console.log(m.astProbeJson());', pathToFileURL(local('wasm/js-ast.mjs')).href]));
await writeJson(local('portable-wasm.json'), node); compare(node, 'Node Wasm');
const browser = await observeAstInChromium(output, original.records); await writeFile(local('portable-chromium.json'), browser.raw, { flag: 'wx', mode: 0o600 });
const outputs = [];
async function collect(directory) { for (const item of await readdir(local(directory), { withFileTypes: true })) {
    const name = directory ? directory + '/' + item.name : item.name;
    if (item.isDirectory()) await collect(name); else { const bytes = await readRegular(local(name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
} }
await collect('');
const receipt = { schemaVersion: 1, kind: 'request-source-map-text-io-genuine-jdk-four-host-profile', source: lock.source,
    sourceLockSha256: sha256(lockBytes), checkToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), buildFlagsSha256: sha256(flagsBytes),
    preparation: prepared.receipt, textPreparation: text.receipt, oracleVersion, pinnedJdkRuntimeRebuilt: false, commands, outputs,
    comparison: { observations: original.records.length, originalJvmEqualsCommonJvm: true, originalJvmEqualsNodeWasm: true,
        originalJvmEqualsOfflineChromium: true, skipped: 0, normalization: false, recordsSha256: sha256(Buffer.from(JSON.stringify(original.records))) },
    browser: browser.receipt, faultContract: 'Injected IO/runtime Throwable identities, message/cause for resource self-suppression, suppression graphs, byte effects and selected sink call order compare directly.',
    unclaimedBoundaries: ['Native path canonicalization/permissions/symlinks', 'Native concurrency/ThreadDeath/InterruptedIOException thread interruption',
        'Maximum allocation and exhaustion class', 'Unselected Writer API or charset', 'Complete SourceMap parser/remapper integration and request stdout'],
    fullParserRuntimeBuilt: false, requestStdoutInstalled: false, sourceMapBuilderBuilt: false, fullCompilerBuilt: false, languageReadiness: false };
await writeJson(local('receipt.json'), receipt); console.log(JSON.stringify({ output, comparison: receipt.comparison }));
