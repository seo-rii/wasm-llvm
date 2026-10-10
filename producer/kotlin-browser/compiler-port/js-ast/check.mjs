#!/usr/bin/env node
/** Compile the actual pinned mixed Java/Kotlin AST, then common JVM and Wasm. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareJsAstSources } from './prepare.mjs';
import { verifyNumberSources } from './numbers/build-probe.mjs';
import { observeAstInChromium } from './browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const execute = promisify(execFile);
const parent = path.join(REPO, 'out/kotlin-js-ast'); await mkdir(parent, { recursive: true, mode: 0o700 });
const output = process.argv[2] ? path.resolve(process.argv[2]) : await mkdtemp(path.join(parent, 'differential-'));
assert(output.startsWith(path.join(REPO, 'out') + path.sep)); await assertNoSymlink(output);
if (process.argv[2]) await mkdir(output, { mode: 0o700 });
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const prepared = await prepareJsAstSources({ sourceRoot, outputRoot: path.join(output, 'common') });
const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
await verifyNumberSources();
const bootstrap = await verifyBootstrap(); const stdlib = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path;
const annotations = bootstrap.artifacts.find(item => item.id === 'annotations').path;
const compilerJar = bootstrap.artifacts.find(item => item.id === 'compiler').path;
const flagsBytes = await readRegular(path.join(HERE, '../build-flags.json')); const flags = JSON.parse(flagsBytes);
const commands = [], observers = [], originalInputs = [];
async function snapshot(name, bytes, details = {}) {
    const filename = path.join(output, name); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return { filename, path: name, bytes: bytes.length, sha256: sha256(bytes), ...details };
}
async function run(phase, command, args) {
    console.log('phase: ' + phase); const started = performance.now();
    try {
        const result = await execute(command, args, { timeout: 300000, maxBuffer: 12 * 1024 * 1024, encoding: 'utf8' });
        if (result.stderr) process.stderr.write(result.stderr);
        commands.push({ phase, command: [command, ...args], exitCode: 0, elapsedMs: performance.now() - started });
        await writeJson(path.join(output, `commands-${commands.length}.json`), commands); return result.stdout;
    } catch (error) {
        process.stderr.write(String(error.stderr ?? '').slice(-120000));
        commands.push({ phase, command: [command, ...args], exitCode: error.code ?? 1, elapsedMs: performance.now() - started });
        await writeJson(path.join(output, `commands-${commands.length}.json`), commands); throw new Error(phase + ' failed: ' + error.code);
    }
}
for (const pin of lock.observers) observers.push(await snapshot('observers/' + pin.path, verifyFile(await readRegular(path.join(HERE, pin.path)), pin)));
const local = name => path.join(output, 'observers', name);
const supportBytes = await readRegular(path.join(sourceRoot, lock.referenceDependencies[0].path));
verifyFile(supportBytes, lock.referenceDependencies[0]); const supportText = supportBytes.toString();
const start = supportText.indexOf('fun <T, A : Appendable> Iterable<T>.joinToWithBuffer(');
const end = supportText.indexOf('\nfun String.countOccurrencesOf(', start); assert(start >= 0 && end > start);
const joinSupport = await snapshot('probe-support/JoinToWithBuffer.kt', Buffer.from(supportText.slice(0, supportText.indexOf('@file:')) +
    'package org.jetbrains.kotlin.utils.addToStdlib\n\n' + supportText.slice(start, end)), { originalPath: lock.referenceDependencies[0].path });
const original = [], originalJava = [];
for (const pin of lock.sources) {
    const bytes = verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin);
    // Embeddable distribution relocation binds the real dependency classes;
    // every original AST algorithm and nullable Java API remains unchanged.
    const text = bytes.toString().replaceAll('import com.intellij.util.SmartList', 'import org.jetbrains.kotlin.com.intellij.util.SmartList')
        .replaceAll('import it.unimi.dsi.fastutil.objects.ObjectOpenHashSet', 'import org.jetbrains.kotlin.it.unimi.dsi.fastutil.objects.ObjectOpenHashSet');
    const input = await snapshot('original/' + pin.path, Buffer.from(text), { originalPath: pin.path, originalSha256: pin.sha256 });
    originalInputs.push(input); original.push(input.filename); if (pin.language === 'java') originalJava.push(input.filename);
}
const dependenciesJar = path.join(output, 'oracle-dependencies.jar');
const dependencies = JSON.parse(await run('extract-verified-host-dependencies', 'python3', [path.join(HERE, 'extract-oracle-dependencies.py'), compilerJar, dependenciesJar]));
await writeJson(path.join(output, 'oracle-dependencies.json'), dependencies);
for (const directory of ['original-java', 'klib', 'wasm']) await mkdir(path.join(output, directory));
const java = ['-Xmx768m', '-cp', bootstrap.classPath];
const jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17',
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
const originalJar = path.join(output, 'original-kotlin.jar'), portableJar = path.join(output, 'portable.jar');
const entry = 'org.jetbrains.kotlin.js.astprobe.JvmEntryKt';
await run('actual-original-mixed-kotlin-build', 'java', [...jvm, '-classpath', [stdlib, annotations, dependenciesJar].join(path.delimiter),
    '-d', originalJar, ...original, joinSupport.filename, local('AstProbe.kt'), local('OriginalProbeSupport.kt'), local('JvmEntry.kt')]);
await run('actual-original-java-build', 'javac', ['-encoding', 'UTF-8', '-source', '17', '-target', '17', '-cp',
    [originalJar, stdlib, annotations, dependenciesJar].join(path.delimiter), '-d', path.join(output, 'original-java'), ...originalJava]);
const common = [...prepared.commonSources, ...prepared.dependencySources, joinSupport.filename, local('AstProbe.kt'), local('PortableProbeSupport.kt')];
await run('portable-common-jvm-build', 'java', [...jvm, '-classpath', stdlib, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','),
    '-d', portableJar, ...common, local('JvmEntry.kt')]);
const originalRaw = await run('actual-original-jvm-observe', 'java', ['-ea', '-cp', [originalJar, path.join(output, 'original-java'), stdlib, dependenciesJar].join(path.delimiter), entry]);
await writeFile(path.join(output, 'original-jvm.json'), originalRaw, { flag: 'wx', mode: 0o600 });
const portableRaw = await run('portable-common-jvm-observe', 'java', ['-ea', '-cp', [portableJar, stdlib].join(path.delimiter), entry]);
await writeFile(path.join(output, 'portable-jvm.json'), portableRaw, { flag: 'wx', mode: 0o600 });
const expected = JSON.parse(originalRaw), portable = JSON.parse(portableRaw);
function compare(actual, label) {
    if (JSON.stringify(expected.records) !== JSON.stringify(actual.records)) {
        const index = expected.records.findIndex((value, i) => value !== actual.records[i]);
        throw new Error(label + ' differs at record ' + index + ': ' + expected.records[index] + ' <> ' + actual.records[index]);
    }
}
compare(portable, 'Common JVM');
const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-language-version', flags.languageVersion,
    '-api-version', flags.apiVersion, ...flags.compilerFlags, '-libraries', bootstrap.wasmJsStdlib];
await run('portable-common-wasmjs-klib', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-ir-output-dir',
    path.join(output, 'klib'), '-ir-output-name', 'js-ast', ...common, local('WasmEntry.kt')]);
await run('portable-common-wasmjs-module', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(output, 'klib/js-ast.klib'),
    '-ir-output-dir', path.join(output, 'wasm'), '-ir-output-name', 'js-ast', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const wasmRaw = await run('portable-node-wasmjs-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const module=await import(process.argv[1]);console.log(module.astProbeJson());', pathToFileURL(path.join(output, 'wasm/js-ast.mjs')).href]);
await writeFile(path.join(output, 'portable-wasmjs.json'), wasmRaw, { flag: 'wx', mode: 0o600 }); const actualWasm = JSON.parse(wasmRaw); compare(actualWasm, 'Node Wasm');
console.log('phase: offline-chromium-module-worker-observe');
const browser = await observeAstInChromium(output, expected.records);
await writeFile(path.join(output, 'portable-chromium.json'), browser.raw, { flag: 'wx', mode: 0o600 });
const outputs = [];
async function collect(directory) {
    for (const item of await readdir(path.join(output, directory), { withFileTypes: true })) {
        const name = directory ? directory + '/' + item.name : item.name;
        if (item.isDirectory()) await collect(name);
        else { const bytes = await readRegular(path.join(output, name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
    }
}
await collect('');
const receipt = { schemaVersion: 1, kind: 'pinned-full-js-ast-original-jvm-common-wasm-differential', source: lock.source,
    sourceLockSha256: sha256(lockBytes), preparation: prepared.receipt, originalInputs, observers, commands, outputs,
    bootstrap: { version: bootstrap.lock.version, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    buildFlagsSha256: sha256(flagsBytes), checkToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    comparison: { observations: expected.records.length, originalJvmEqualsCommonJvm: true, originalJvmEqualsNodeWasm: true, originalJvmEqualsOfflineChromium: true, skipped: 0,
        successfulAndFailureCategoryRecordsSha256: sha256(Buffer.from(JSON.stringify(expected.records))) },
    rawFailures: { originalJvm: expected.failures, commonJvm: portable.failures, nodeWasm: actualWasm.failures, offlineChromium: browser.observation.failures },
    exceptionBoundary: 'Failure categories compared; JVM enhanced null messages, Kotlin messages and frames retained without normalization and not claimed equal.',
    readerBoundary: 'Closed source reader explicitly maps IOException/AstReaderClosedException to its closed-reader contract; UTF16 reads and text compare directly.',
    listBoundary: 'Explicit supplied-list getter identity compares directly. Readonly synthetic mutable-property view identity differs; reads and unsupported mutation compare using the same explicit AbstractList readonly fixture. Mutable synthetic properties retain identity. Kotlin/Wasm listOf factories can be physically mutable unlike JVM singleton/fixed lists; factory mutability is not claimed equal and the rejected earlier trace is retained.',
    runtimeClasspath: 'Actual compiled original107 sources plus verified stdlib and extracted genuine host support. No compiler JAR or existing compiler AST classes in application runtime.',
    dependencies, browser: browser.receipt, fullCompilerBuilt: false, languageReadiness: false };
await writeJson(path.join(output, 'receipt.json'), receipt);
console.log(JSON.stringify({ output, comparison: receipt.comparison, languageReadiness: false }));
