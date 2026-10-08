#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { prepareConfigurationSources } from './prepare.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);
const sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources');
const parent = path.join(repository, 'out/kotlin-compiler-configuration/checks');
await mkdir(parent, { recursive: true });
const output = await mkdtemp(path.join(parent, 'run-'));
const bootstrap = await verifyBootstrap();
const prepared = await prepareConfigurationSources({ sourceRoot, outputRoot: output });
const lock = JSON.parse(await readRegular(path.join(here, 'sources.lock.json')));
const flags = JSON.parse(await readRegular(path.join(here, '../build-flags.json'))).compilerFlags;
const originalRoot = path.join(output, 'original');
await mkdir(originalRoot);
const originals = [], referenceAdapters = [];
for (const pin of lock.sources) {
    const original = verifyFile(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), pin);
    // The hash-verified bootstrap JAR relocates IntelliJ. Only this JVM import
    // changes; the reference configuration and collection algorithms stay exact.
    const bytes = Buffer.from(original.toString().replace('import com.intellij.openapi.util.Key',
        'import org.jetbrains.kotlin.com.intellij.openapi.util.Key'));
    const filename = path.join(originalRoot, path.basename(pin.path));
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    originals.push(filename);
    referenceAdapters.push({ path: pin.path, originalSha256: pin.sha256, sha256: sha256(bytes),
        rule: 'bootstrap-JAR-IntelliJ-package-relocation-only' });
}
const observer = path.join(here, 'ConfigurationProbe.kt');
const jvmMain = path.join(output, 'JvmMain.kt');
const wasmExport = path.join(output, 'WasmExport.kt');
await writeFile(jvmMain, 'package org.jetbrains.kotlin.portable.configcheck\nfun main(args: Array<String>) = print(if (args.isEmpty()) observeConfiguration() else observeStaleEntry())\n', { flag: 'wx', mode: 0o600 });
await writeFile(wasmExport, 'package org.jetbrains.kotlin.portable.configcheck\nimport kotlin.js.JsExport\n@JsExport fun configurationProbe(): String = observeConfiguration()\n@JsExport fun staleEntryProbe(): String = observeStaleEntry()\n', { flag: 'wx', mode: 0o600 });
const commands = [];
async function command(phase, binary, args) {
    const started = performance.now();
    const result = await execute(binary, args, { timeout: 180000, maxBuffer: 1024 * 1024 });
    if (result.stderr) process.stderr.write(result.stderr);
    commands.push({ phase, command: [binary, ...args], exitCode: 0, elapsedMs: performance.now() - started });
    return result.stdout;
}
const compiler = ['-Xmx768m', '-cp', bootstrap.classPath];
const jvmCompiler = [...compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
    '-language-version', '2.5', '-api-version', '2.5', ...flags, '-classpath', bootstrap.classPath];
const originalJvm = path.join(output, 'original.jar');
await command('original-jvm-source', 'java', [...jvmCompiler, '-d', originalJvm, ...originals, observer, jvmMain]);
const original = await command('original-jvm-run', 'java', ['-cp', [originalJvm, bootstrap.classPath].join(path.delimiter),
    'org.jetbrains.kotlin.portable.configcheck.JvmMainKt']);
const portableJvm = path.join(output, 'portable.jar');
await command('portable-jvm-source', 'java', [...jvmCompiler, '-Xmulti-platform',
    '-Xcommon-sources=' + prepared.commonSources.join(','), '-d', portableJvm, ...prepared.commonSources, observer, jvmMain]);
const portable = await command('portable-jvm-run', 'java', ['-cp', [portableJvm, bootstrap.classPath].join(path.delimiter),
    'org.jetbrains.kotlin.portable.configcheck.JvmMainKt']);
assert.equal(portable, original, 'Portable configuration differs from original JVM configuration');
const klib = path.join(output, 'klib'), wasm = path.join(output, 'wasm');
await mkdir(klib); await mkdir(wasm);
const wasmCompiler = [...compiler, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js',
    '-language-version', '2.5', '-api-version', '2.5', ...flags, '-libraries', bootstrap.wasmJsStdlib];
await command('portable-wasmjs-klib', 'java', [...wasmCompiler, '-Xmulti-platform',
    '-Xcommon-sources=' + prepared.commonSources.join(','), '-ir-output-dir', klib, '-ir-output-name', 'configuration',
    ...prepared.commonSources, observer, wasmExport]);
await command('portable-wasmjs-binary', 'java', [...wasmCompiler, '-Xir-produce-js', '-Xinclude=' + path.join(klib, 'configuration.klib'),
    '-ir-output-dir', wasm, '-ir-output-name', 'configuration', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const loader = pathToFileURL(path.join(wasm, 'configuration.mjs')).href;
const node = await command('portable-node-wasm-run', 'node', ['--experimental-wasm-exnref', '--input-type=module', '-e',
    `const module = await import(${JSON.stringify(loader)}); process.stdout.write(module.configurationProbe());`]);
assert.equal(node, original, 'Wasm configuration differs from original JVM configuration');
const originalStale = await command('original-jvm-undefined-entry-lifetime', 'java',
    ['-cp', [originalJvm, bootstrap.classPath].join(path.delimiter), 'org.jetbrains.kotlin.portable.configcheck.JvmMainKt', 'stale']);
const portableStale = await command('portable-jvm-undefined-entry-lifetime', 'java',
    ['-cp', [portableJvm, bootstrap.classPath].join(path.delimiter), 'org.jetbrains.kotlin.portable.configcheck.JvmMainKt', 'stale']);
const wasmStale = await command('portable-wasm-undefined-entry-lifetime', 'node',
    ['--experimental-wasm-exnref', '--input-type=module', '-e',
        `const module = await import(${JSON.stringify(loader)}); process.stdout.write(module.staleEntryProbe());`]);
const receipt = { schemaVersion: 1, kind: 'official-compiler-configuration-differential', source: lock.source,
    sourcePreparation: prepared.receipt, referenceAdapters, commands, observerSha256: sha256(await readRegular(observer)),
    comparisons: { cases: original.split('\n').length, originalJvm: sha256(Buffer.from(original)),
        portableJvm: sha256(Buffer.from(portable)), wasmNode: sha256(Buffer.from(node)), mismatches: 0 },
    observedOutput: original, hostDifferences: [{ case: 'retained-Map.Entry-after-backing-map-modification',
        originalJvm: originalStale, portableJvm: portableStale, wasmNode: wasmStale,
        contract: 'undefined; not included in equivalence count',
        source: 'https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/Map.Entry.html' }],
    browserExecution: 'not-run', fullBrowserCompiler: false };
await writeJson(path.join(output, 'configuration-evidence.json'), receipt);
console.log(JSON.stringify({ output, comparisons: receipt.comparisons, fullBrowserCompiler: false }));
