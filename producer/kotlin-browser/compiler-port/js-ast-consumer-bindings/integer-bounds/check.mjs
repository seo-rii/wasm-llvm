#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { readRegular, sha256, verifyFile, writeJson } from '../../../scripts/source.mjs';
import { verifyBootstrap } from '../../../build/bootstrap.mjs';
import { verifyEvidence } from '../../js-ast/verify.mjs';
import { observeAstInChromium } from '../../js-ast/browser.mjs';
import { prepareAstIntegerConsumer } from '../integer/prepare.mjs';
import { extracts, inputSource, verifyExtracts, writerSource } from '../integer/extract.mjs';
import { prepareAstIntegerBounds, verifyAstIntegerBounds } from './prepare.mjs';
import { boundReadBytes } from './transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../../..');
const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
const integerLock = JSON.parse(await readRegular(path.join(HERE, '../integer/sources.lock.json')));
const parent = path.join(REPO, 'out/kotlin-js-ast-integer-bounds'); await mkdir(parent, { recursive: true, mode: 0o700 });
const output = await mkdtemp(path.join(parent, 'run-')), local = name => path.join(output, name);
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const preparedInteger = await prepareAstIntegerConsumer({ sourceRoot, outputRoot: local('integer') });
const prepared = await prepareAstIntegerBounds({ sourceRoot, outputRoot: local('guarded'), preparedInteger });
await verifyAstIntegerBounds({ sourceRoot, outputRoot: local('guarded'), preparedInteger, receiptPath: prepared.receiptPath });
const astReceipt = JSON.parse(verifyFile(await readRegular(path.join(HERE, '../integer/' + integerLock.astEvidence.path)), integerLock.astEvidence));
const baseline = path.join(REPO, 'out/kotlin-js-ast/differential-WViAyC'); await verifyEvidence(astReceipt, { artifactRoot: baseline });
const originals = await Promise.all(lock.sources.map(pin => readRegular(path.join(sourceRoot, pin.path))));
const parts = extracts(...originals); verifyExtracts(parts, integerLock.extracts);
assert.equal(parts.readBytes, lock.originalReadBytes);
const bounded = { ...parts, readBytes: boundReadBytes(parts.readBytes) };
for (const pin of [...integerLock.observers.filter(pin => !['JvmEntry.kt', 'WasmEntry.kt'].includes(pin.path)).map(pin => ({ ...pin, filename: path.join(HERE, '../integer', pin.path) })),
    ...lock.observers.map(pin => ({ ...pin, filename: path.join(HERE, pin.path) }))]) {
    await writeFile(local(pin.path), verifyFile(await readRegular(pin.filename), pin), { flag: 'wx', mode: 0o600 });
}
function withCallbackProbe(text) { return text.replace('    fun position(): Int', '    var calls: Int = 0\n    fun transformed(): Int = readBytes { _, length -> calls++; length }\n    fun position(): Int'); }
for (const [name, text] of Object.entries({ 'OriginalInput.kt': withCallbackProbe(inputSource(bounded, false)), 'PortableInput.kt': withCallbackProbe(inputSource(bounded, true)), 'ActualLiteralWriter.kt': writerSource(parts) }))
    await writeFile(local(name), text, { flag: 'wx', mode: 0o600 });
const bootstrap = await verifyBootstrap(), stdlib = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path;
const flagsBytes = await readRegular(path.join(HERE, '../../build-flags.json')), flags = JSON.parse(flagsBytes);
const commands = [], run = promisify(execFile);
async function execute(phase, executable, args) {
    console.log('phase: ' + phase); const result = await run(executable, args, { timeout: 300000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
    if (result.stderr) process.stderr.write(result.stderr); commands.push({ phase, command: [executable, ...args], exitCode: 0 }); return result.stdout;
}
const java = ['-Xmx768m', '-cp', bootstrap.classPath];
const jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', flags.languageVersion,
    '-api-version', flags.apiVersion, ...flags.compilerFlags];
const shared = [local('Probe.kt'), local('BoundsProbe.kt'), local('ActualLiteralWriter.kt')];
const originalClasspath = [stdlib, path.join(baseline, 'original-kotlin.jar'), path.join(baseline, 'original-java'), path.join(baseline, 'oracle-dependencies.jar')].join(path.delimiter);
const portableClasspath = [stdlib, path.join(baseline, 'portable.jar')].join(path.delimiter);
await execute('guarded-actual-jvm-build', 'java', [...jvm, '-classpath', originalClasspath, '-d', local('original.jar'), ...shared, local('OriginalSupport.kt'), local('OriginalInput.kt'), local('JvmEntry.kt')]);
await execute('guarded-common-jvm-build', 'java', [...jvm, '-classpath', portableClasspath, '-d', local('portable.jar'), ...shared, local('PortableSupport.kt'), local('PortableInput.kt'), local('JvmEntry.kt')]);
const original = JSON.parse(await execute('guarded-actual-jvm-observe', 'java', ['-ea', '-cp', [local('original.jar'), originalClasspath].join(path.delimiter), 'org.jetbrains.kotlin.js.astintegerprobe.JvmEntryKt']));
const portable = JSON.parse(await execute('guarded-common-jvm-observe', 'java', ['-ea', '-cp', [local('portable.jar'), portableClasspath].join(path.delimiter), 'org.jetbrains.kotlin.js.astintegerprobe.JvmEntryKt']));
await writeJson(local('guarded-original-jvm.json'), original); await writeJson(local('guarded-portable-jvm.json'), portable);
assert.deepEqual(portable.records, original.records); assert.deepEqual(portable.bounds, original.bounds);
const previous = JSON.parse(await readRegular(path.join(HERE, '../integer/evidence/receipt.json')));
const unguarded = JSON.parse(await readRegular(path.join(previous.sealedExecution.artifactRoot, 'original-jvm.json')));
assert.deepEqual(original.records.slice(0, 2700), unguarded.records.slice(0, 2700));
for (const index of [5, 6, 7, 8]) { assert.equal(original.records[2700 + index * 2], `malformed.${index}.failure=IllegalArgumentException`); assert.equal(original.records[2701 + index * 2], `malformed.${index}.position=4`); }
const common = [...astReceipt.preparation.files.map(pin => path.join(baseline, 'common', pin.path)), ...astReceipt.preparation.commonDependencies.map(pin => pin.filename),
    path.join(baseline, 'probe-support/JoinToWithBuffer.kt'), ...shared, local('PortableSupport.kt'), local('PortableInput.kt')];
await mkdir(local('klib')); await mkdir(local('wasm'));
const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-language-version', flags.languageVersion,
    '-api-version', flags.apiVersion, ...flags.compilerFlags, '-libraries', bootstrap.wasmJsStdlib];
await execute('guarded-common-wasm-klib', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-ir-output-dir', local('klib'), '-ir-output-name', 'integer-bounds', ...common, local('WasmEntry.kt')]);
await execute('guarded-common-wasm-module', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + local('klib/integer-bounds.klib'), '-ir-output-dir', local('wasm'), '-ir-output-name', 'js-ast', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const node = JSON.parse(await execute('guarded-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const module=await import(process.argv[1]);console.log(module.astProbeJson());', pathToFileURL(local('wasm/js-ast.mjs')).href]));
await writeJson(local('guarded-node-wasm.json'), node); assert.deepEqual(node.records, original.records); assert.deepEqual(node.bounds, original.bounds);
const browser = await observeAstInChromium(output, original.records); assert.deepEqual(browser.observation.bounds, original.bounds);
await writeFile(local('guarded-chromium.json'), browser.raw, { flag: 'wx', mode: 0o600 });
const outputs = [];
async function collect(directory) { for (const item of await readdir(local(directory), { withFileTypes: true })) {
    const name = directory ? directory + '/' + item.name : item.name;
    if (item.isDirectory()) await collect(name); else { const bytes = await readRegular(local(name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
} }
await collect('');
const receipt = { schemaVersion: 1, kind: 'pinned-actual-ast-byte-length-guard-profile', source: lock.source,
    sourceLockSha256: sha256(lockBytes), checkToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    buildFlagsSha256: sha256(flagsBytes), preparation: prepared.receipt, predecessor: preparedInteger.receipt, commands, outputs,
    comparison: { unchangedValidObservations: 2700, exactGuardedMalformedObservations: 18, transformCallbackObservations: 8,
        originalJvmEqualsCommonJvm: true, originalJvmEqualsNodeWasm: true, originalJvmEqualsOfflineChromium: true, skipped: 0 },
    rawFailures: { guardedOriginalJvm: original.failures, guardedCommonJvm: portable.failures, guardedNodeWasm: node.failures, guardedOfflineChromium: browser.observation.failures },
    previousMalformedNegative: '../integer/evidence/malformed-allocation-negative.json', intentionalMalformedContractChange: true,
    resourceBound: 'Reject length outside remaining input using subtraction before invoking transformation; no payload allocation beyond current input size.',
    browser: browser.receipt, fullDeserializerBuilt: false, byteBufferPorted: false, fullCompilerBuilt: false, languageReadiness: false };
await writeJson(local('receipt.json'), receipt); console.log(JSON.stringify({ output, comparison: receipt.comparison }));
