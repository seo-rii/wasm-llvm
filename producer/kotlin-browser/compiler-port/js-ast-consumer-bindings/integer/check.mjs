#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../../scripts/source.mjs';
import { verifyBootstrap } from '../../../build/bootstrap.mjs';
import { verifyEvidence } from '../../js-ast/verify.mjs';
import { observeAstInChromium } from '../../js-ast/browser.mjs';
import { prepareAstIntegerConsumer } from './prepare.mjs';
import { extracts, inputSource, verifyExtracts, writerSource } from './extract.mjs';
import { compareLiteralProfile } from './compare-profile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../../..');
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const parent = path.join(REPO, 'out/kotlin-js-ast-integer-consumer'); await mkdir(parent, { recursive: true, mode: 0o700 });
const output = await mkdtemp(path.join(parent, 'run-')); const run = promisify(execFile); const commands = [];
const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
const astReceipt = JSON.parse(verifyFile(await readRegular(path.join(HERE, lock.astEvidence.path)), lock.astEvidence));
const baseline = path.resolve(REPO, 'out/kotlin-js-ast/differential-WViAyC'); await verifyEvidence(astReceipt, { artifactRoot: baseline });
const selectedArgs = verifyFile(await readRegular(path.join(HERE, lock.selectedBaseline.arguments.path)), lock.selectedBaseline.arguments);
const selectedRoot = path.dirname(path.join(HERE, lock.selectedBaseline.arguments.path));
const selectedFiles = selectedArgs.toString().split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(value => !value.startsWith('-') && value.endsWith('.kt'));
assert.equal(selectedFiles.length, lock.selectedBaseline.sourceCount);
const retainedSources = selectedFiles.map(filename => ({ filename,
    path: filename.startsWith(path.join(selectedRoot, 'sources') + path.sep) ? path.relative(path.join(selectedRoot, 'sources'), filename)
        : path.relative(selectedRoot, filename) }));
const prepared = await prepareAstIntegerConsumer({ sourceRoot, outputRoot: path.join(output, 'consumer'), retainedSources });
const originals = await Promise.all(lock.sources.map(pin => readRegular(path.join(sourceRoot, pin.path))));
const parts = extracts(...originals); verifyExtracts(parts, lock.extracts);
const observers = [];
for (const pin of lock.observers) {
    const bytes = verifyFile(await readRegular(path.join(HERE, pin.path)), pin); const target = path.join(output, pin.path);
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); observers.push(target);
}
const generated = [];
for (const [name, text] of Object.entries({ 'OriginalInput.kt': inputSource(parts, false), 'PortableInput.kt': inputSource(parts, true), 'ActualLiteralWriter.kt': writerSource(parts) })) {
    const target = path.join(output, name); await writeFile(target, text, { flag: 'wx', mode: 0o600 }); generated.push(target);
}
const bootstrap = await verifyBootstrap(), stdlib = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path;
const flagsBytes = await readRegular(path.join(HERE, '../../build-flags.json')), flags = JSON.parse(flagsBytes);
async function execute(phase, executable, args) {
    console.log('phase: ' + phase);
    const result = await run(executable, args, { timeout: 300000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
    if (result.stderr) process.stderr.write(result.stderr); commands.push({ phase, command: [executable, ...args], exitCode: 0 });
    return result.stdout;
}
const java = ['-Xmx768m', '-cp', bootstrap.classPath];
const jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17',
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
const local = name => path.join(output, name), shared = [local('Probe.kt'), local('ActualLiteralWriter.kt')];
const originalAst = [path.join(baseline, 'original-kotlin.jar'), path.join(baseline, 'original-java'), path.join(baseline, 'oracle-dependencies.jar')];
const originalClasspath = [stdlib, ...originalAst].join(path.delimiter), portableClasspath = [stdlib, path.join(baseline, 'portable.jar')].join(path.delimiter);
await execute('actual-original-literal-caller-jvm-build', 'java', [...jvm, '-classpath', originalClasspath, '-d', local('original.jar'),
    ...shared, local('OriginalSupport.kt'), local('OriginalInput.kt'), local('JvmEntry.kt')]);
await execute('common-literal-caller-jvm-build', 'java', [...jvm, '-classpath', portableClasspath, '-d', local('portable.jar'),
    ...shared, local('PortableSupport.kt'), local('PortableInput.kt'), local('JvmEntry.kt')]);
const original = JSON.parse(await execute('actual-original-literal-caller-jvm-observe', 'java', ['-ea', '-cp', [local('original.jar'), originalClasspath].join(path.delimiter), 'org.jetbrains.kotlin.js.astintegerprobe.JvmEntryKt']));
const portable = JSON.parse(await execute('common-literal-caller-jvm-observe', 'java', ['-ea', '-cp', [local('portable.jar'), portableClasspath].join(path.delimiter), 'org.jetbrains.kotlin.js.astintegerprobe.JvmEntryKt']));
await writeJson(local('original-jvm.json'), original); await writeJson(local('portable-jvm.json'), portable);
assert.deepEqual(portable.records, original.records);
const common = [...astReceipt.preparation.files.map(pin => path.join(baseline, 'common', pin.path)),
    ...astReceipt.preparation.commonDependencies.map(pin => pin.filename), path.join(baseline, 'probe-support/JoinToWithBuffer.kt'),
    ...shared, local('PortableSupport.kt'), local('PortableInput.kt')];
await mkdir(local('klib')); await mkdir(local('wasm'));
const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-language-version', flags.languageVersion,
    '-api-version', flags.apiVersion, ...flags.compilerFlags, '-libraries', bootstrap.wasmJsStdlib];
await execute('common-literal-caller-wasm-klib', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','),
    '-ir-output-dir', local('klib'), '-ir-output-name', 'integer-consumer', ...common, local('WasmEntry.kt')]);
await execute('common-literal-caller-wasm-module', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + local('klib/integer-consumer.klib'),
    '-ir-output-dir', local('wasm'), '-ir-output-name', 'js-ast', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const node = JSON.parse(await execute('common-literal-caller-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const module=await import(process.argv[1]);console.log(module.astProbeJson());', pathToFileURL(local('wasm/js-ast.mjs')).href]));
await writeJson(local('portable-wasmjs.json'), node);
const browser = await observeAstInChromium(output, node.records); await writeFile(local('portable-chromium.json'), browser.raw, { flag: 'wx', mode: 0o600 });
const comparison = compareLiteralProfile(original, portable, node, browser.observation);
const outputs = [];
async function collect(directory) {
    for (const item of await readdir(path.join(output, directory), { withFileTypes: true })) {
        const name = directory ? directory + '/' + item.name : item.name;
        if (item.isDirectory()) await collect(name); else { const bytes = await readRegular(local(name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
    }
}
await collect('');
const receipt = { schemaVersion: 1, kind: 'pinned-actual-bigint-literal-byte-caller-differential', source: lock.source,
    sourceLockSha256: sha256(lockBytes), checkToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    buildFlagsSha256: sha256(flagsBytes), preparation: prepared.receipt, extracts: lock.extracts, commands, outputs,
    astEvidence: lock.astEvidence, astExecution: baseline,
    comparison,
    rawFailures: { originalJvm: original.failures, commonJvm: portable.failures, nodeWasm: node.failures, offlineChromium: browser.observation.failures },
    prefixBounds: 'Actual JDK BufferUnderflow and the observer-only bounded cursor compare under explicit prefix-underflow contract; raw categories/messages retained. This does not port shipping ByteBuffer.',
    actualAlgorithm: 'Signed literal constructor, readBytes/readByteArray, writer methods and bigint visitor body extracted verbatim from exact pinned sources; only integer import differs.',
    browser: browser.receipt, fullDeserializerBuilt: false, byteBufferPorted: false, fullCompilerBuilt: false, languageReadiness: false };
await writeJson(local('receipt.json'), receipt); console.log(JSON.stringify({ output, comparison: receipt.comparison }));
