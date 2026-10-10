#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { readRegular, responseBytes, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { observeAstInChromium } from '../js-ast/browser.mjs';
import { verifyNumberSources } from '../js-ast/numbers/build-probe.mjs';
import { prepareSourceMapJsonReferences, prepareSourceMapJson, verifySourceMapJson } from './prepare.mjs';
import { verifySourceMapTestLibraries } from './tools.mjs';
import { bindTestDiscovery } from './transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
await mkdir(path.join(REPO, 'out/kotlin-source-map-json'), { recursive: true, mode: 0o700 });
const output = await mkdtemp(path.join(REPO, 'out/kotlin-source-map-json/run-')), local = name => path.join(output, name);
const reference = await prepareSourceMapJsonReferences();
const prepared = await prepareSourceMapJson({ sourceRoot: reference.sourceRoot, outputRoot: local('common') });
await verifySourceMapJson({ sourceRoot: reference.sourceRoot, outputRoot: local('common'), receiptPath: prepared.receiptPath });
const formatter = await verifyNumberSources(); verifyFile(formatter.ported, lock.numberSource);
const numberPath = path.join(HERE, '../js-ast', lock.numberSource.path);
const testLibraries = await verifySourceMapTestLibraries(); const bootstrap = await verifyBootstrap();
assert.equal(testLibraries.version, bootstrap.lock.version);
const testSources = [], testMethods = [], originalTestInputs = [];
for (const pin of lock.tests) {
    const filename = path.join(reference.sourceRoot, pin.path); let original, origin = 'verified-reference-cache';
    try { original = await readRegular(filename, pin.bytes); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!original) {
        origin = 'pinned-primary-upstream-fetch';
        original = verifyFile(await responseBytes(`https://raw.githubusercontent.com/JetBrains/kotlin/${lock.source.commit}/${pin.path}`,
            pin.bytes, fetch), pin);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, original, { flag: 'wx', mode: 0o600 });
    }
    verifyFile(original, pin);
    const originalPath = 'original-tests/' + pin.path;
    await mkdir(path.dirname(local(originalPath)), { recursive: true, mode: 0o700 });
    await writeFile(local(originalPath), original, { flag: 'wx', mode: 0o600 });
    originalTestInputs.push({ path: originalPath, origin, bytes: original.length, sha256: sha256(original), gitBlob: pin.gitBlob });
    const bound = bindTestDiscovery(original);
    const name = path.basename(pin.path); await writeFile(local(name), bound.bytes, { flag: 'wx', mode: 0o600 }); testSources.push(local(name));
    if (bound.methods.length) testMethods.push({ class: name.slice(0, -3), methods: bound.methods });
}
assert.deepEqual(testMethods.map(value => value.methods.length), [22, 16]);
const runner = 'package org.jetbrains.kotlin.sourcemaps\nfun runPinnedTests():List<String> {\nval records=ArrayList<String>()\n' +
    testMethods.flatMap(value => value.methods.map(method => `${value.class}().${method}();records.add("${value.class}.${method}")`)).join('\n') + '\nreturn records\n}\n';
await writeFile(local('OriginalTestsRunner.kt'), runner, { flag: 'wx', mode: 0o600 }); testSources.push(local('OriginalTestsRunner.kt'));
for (const pin of lock.observers) await writeFile(local(pin.path), verifyFile(await readRegular(path.join(HERE, pin.path)), pin), { flag: 'wx', mode: 0o600 });
const flagsBytes = await readRegular(path.join(HERE, '../build-flags.json')), flags = JSON.parse(flagsBytes);
const executeFile = promisify(execFile), commands = [];
async function execute(phase, executable, args) {
    console.log('phase: ' + phase); const result = await executeFile(executable, args, { timeout: 240000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });
    if (result.stderr) process.stderr.write(result.stderr); commands.push({ phase, command: [executable, ...args], exitCode: 0 }); return result.stdout;
}
const stdlib = bootstrap.artifacts.find(pin => pin.id === 'stdlib-jvm').path;
const java = ['-Xmx768m', '-cp', bootstrap.classPath];
const jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17',
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags, '-classpath', [stdlib, testLibraries.jvm].join(path.delimiter)];
const original = lock.sources.map(pin => path.join(reference.sourceRoot, pin.path)), observer = [local('Probe.kt'), ...testSources];
await execute('genuine-json-ecma-original-jvm-build', 'java', [...jvm, '-d', local('original.jar'), ...original, ...observer, local('JvmEntry.kt')]);
const common = [...prepared.commonSources, numberPath, ...observer];
await execute('genuine-json-ecma-common-jvm-build', 'java', [...jvm, '-d', local('portable.jar'), ...common, local('JvmEntry.kt')]);
async function observe(name) {
    return JSON.parse(await execute(name + '-observe', 'java', ['-ea', '-cp', [local(name === 'original' ? 'original.jar' : 'portable.jar'), stdlib, testLibraries.jvm].join(path.delimiter),
        'org.jetbrains.kotlin.sourcemapsprobe.JvmEntryKt']));
}
const jdk = await observe('original'), portable = await observe('common');
await writeJson(local('original-jvm.json'), jdk); await writeJson(local('portable-jvm.json'), portable);
assert.deepEqual(portable.records, jdk.records); assert.deepEqual(portable.rawFailures, jdk.rawFailures);
await mkdir(local('klib')); await mkdir(local('wasm'));
const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-language-version', flags.languageVersion,
    '-api-version', flags.apiVersion, ...flags.compilerFlags, '-libraries', [bootstrap.wasmJsStdlib, testLibraries.wasm].join(path.delimiter)];
await execute('genuine-json-ecma-common-wasm-klib', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','),
    '-ir-output-dir', local('klib'), '-ir-output-name', 'source-map-json', ...common, local('WasmEntry.kt')]);
await execute('genuine-json-ecma-common-wasm-module', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + local('klib/source-map-json.klib'),
    '-ir-output-dir', local('wasm'), '-ir-output-name', 'js-ast', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const node = JSON.parse(await execute('genuine-json-ecma-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const m=await import(process.argv[1]);console.log(m.astProbeJson());', pathToFileURL(local('wasm/js-ast.mjs')).href]));
await writeJson(local('portable-wasm.json'), node); assert.deepEqual(node.records, jdk.records); assert.deepEqual(node.rawFailures, jdk.rawFailures);
const browser = await observeAstInChromium(output, jdk.records); await writeFile(local('portable-chromium.json'), browser.raw, { flag: 'wx', mode: 0o600 });
assert.deepEqual(browser.observation.rawFailures, jdk.rawFailures);
const outputs = [];
async function collect(directory) {
    for (const entry of await readdir(local(directory), { withFileTypes: true })) {
        const name = directory ? directory + '/' + entry.name : entry.name;
        if (entry.isDirectory()) await collect(name); else { const bytes = await readRegular(local(name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
    }
}
await collect('');
const receipt = { schemaVersion: 1, kind: 'genuine-source-map-json-ecma-original-common-four-host-profile', source: lock.source,
    sourceLockSha256: sha256(lockBytes), checkToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), buildFlagsSha256: sha256(flagsBytes),
    preparation: prepared.receipt, originalTests: { pins: lock.tests, inputs: originalTestInputs, classes: testMethods, passed: 38, failed: 0, skipped: 0,
        assertionLibrary: testLibraries, methodsUnchanged: true, onlyJUnitDiscoveryRemoved: true },
    numericDependency: { path: lock.numberSource.outputPath, bytes: formatter.ported.length, sha256: sha256(formatter.ported), sourceVerified: true },
    commands, outputs, comparison: { observations: jdk.records.length, originalJvmEqualsCommonJvm: true, originalJvmEqualsNodeWasm: true,
        originalJvmEqualsOfflineChromium: true, rawFailuresEqual: true, skipped: 0, normalization: false, recordsSha256: sha256(Buffer.from(JSON.stringify(jdk.records))) },
    rawFailures: { originalJvm: jdk.rawFailures, commonJvm: portable.rawFailures, nodeWasm: node.rawFailures, offlineChromium: browser.observation.rawFailures }, browser: browser.receipt,
    originalIndexSectionsSupported: false, originalIndexSectionsFailurePreserved: true, originalMethodsRemoved: false,
    algorithmLimits: 'Original JSON recursion and ECMA parser algorithms retained. Finite deterministic corpus; no deep-recursion/maximum allocation or whole-compiler resource acceptance claim.',
    parserRuntimeBuilt: false, sourceMapBuilderBuilt: false, fullCompilerBuilt: false, languageReadiness: false };
await writeJson(local('receipt.json'), receipt); console.log(JSON.stringify({ output, comparison: receipt.comparison, originalTests: receipt.originalTests.passed }));
