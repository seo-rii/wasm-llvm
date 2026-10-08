#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { prepareCommonJavaSources } from './prepare.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const execute = promisify(execFile), sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources');
const parent = path.join(repository, 'out/kotlin-compiler-common-java/checks');
await mkdir(parent, { recursive: true });
const output = await mkdtemp(path.join(parent, 'run-'));
const prepared = await prepareCommonJavaSources({ sourceRoot, outputRoot: output });
const bootstrap = await verifyBootstrap();
const originals = path.join(output, 'original-classes'); await mkdir(originals);
const commands = [];
async function command(phase, binary, args) {
    const started = performance.now();
    const result = await execute(binary, args, { timeout: 180000, maxBuffer: 1024 * 1024 });
    if (result.stderr) process.stderr.write(result.stderr);
    commands.push({ phase, command: [binary, ...args], exitCode: 0, elapsedMs: performance.now() - started });
    return result.stdout;
}
await command('original-java-sources', 'javac', ['-J-Xmx512m', '-cp', bootstrap.classPath, '-d', originals,
    ...prepared.receipt.originals.map((pin) => path.join(sourceRoot, pin.path))]);
const observer = path.join(here, 'CommonJavaProbe.kt'), jvmMain = path.join(output, 'JvmMain.kt'), wasmExport = path.join(output, 'WasmExport.kt');
await writeFile(jvmMain, 'package org.jetbrains.kotlin.portable.commoncheck\nfun main() = print(observeCommonJava())\n', { flag: 'wx', mode: 0o600 });
await writeFile(wasmExport, 'package org.jetbrains.kotlin.portable.commoncheck\nimport kotlin.js.JsExport\n@JsExport fun commonJavaProbe(): String = observeCommonJava()\n', { flag: 'wx', mode: 0o600 });
const compiler = ['-Xmx768m', '-cp', bootstrap.classPath];
const originalJvm = path.join(output, 'original.jar');
await command('original-jvm-observer', 'java', [...compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
    '-language-version', '2.5', '-api-version', '2.5', '-classpath', [originals, bootstrap.classPath].join(path.delimiter),
    '-d', originalJvm, path.join(here, 'CommonJavaProperties.kt'), observer, jvmMain]);
const original = await command('original-jvm-run', 'java', ['-cp', [originalJvm, originals, bootstrap.classPath].join(path.delimiter),
    'org.jetbrains.kotlin.portable.commoncheck.JvmMainKt']);
const portableJvm = path.join(output, 'portable.jar');
await command('portable-jvm-source', 'java', [...compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
    '-language-version', '2.5', '-api-version', '2.5', '-classpath', bootstrap.classPath, '-d', portableJvm,
    ...prepared.commonSources, observer, jvmMain]);
const portable = await command('portable-jvm-run', 'java', ['-cp', [portableJvm, bootstrap.classPath].join(path.delimiter),
    'org.jetbrains.kotlin.portable.commoncheck.JvmMainKt']);
assert.equal(portable, original, 'Common JVM helpers differ from the exact original Java');
const klib = path.join(output, 'klib'), wasm = path.join(output, 'wasm'); await mkdir(klib); await mkdir(wasm);
const wasmCompiler = [...compiler, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js',
    '-language-version', '2.5', '-api-version', '2.5', '-libraries', bootstrap.wasmJsStdlib];
await command('portable-wasmjs-klib', 'java', [...wasmCompiler, '-ir-output-dir', klib, '-ir-output-name', 'common-java',
    ...prepared.commonSources, observer, wasmExport]);
await command('portable-wasmjs-binary', 'java', [...wasmCompiler, '-Xir-produce-js', '-Xinclude=' + path.join(klib, 'common-java.klib'),
    '-ir-output-dir', wasm, '-ir-output-name', 'common-java', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const loader = pathToFileURL(path.join(wasm, 'common-java.mjs')).href;
const node = await command('portable-node-wasm-run', 'node', ['--experimental-wasm-exnref', '--input-type=module', '-e',
    `const module = await import(${JSON.stringify(loader)}); process.stdout.write(module.commonJavaProbe());`]);
assert.equal(node, original, 'Common Wasm helpers differ from the exact original Java');
const receipt = { schemaVersion: 1, kind: 'official-compiler-small-java-differential', source: prepared.receipt.source,
    sourcePreparation: prepared.receipt, commands, observerSha256: sha256(await readRegular(observer)),
    comparisons: { cases: original.split('\n').length, originalJvm: sha256(Buffer.from(original)),
        portableJvm: sha256(Buffer.from(portable)), wasmNode: sha256(Buffer.from(node)), mismatches: 0 },
    observedOutput: original, browserExecution: 'not-run', fullBrowserCompiler: false };
await writeJson(path.join(output, 'common-java-evidence.json'), receipt);
console.log(JSON.stringify({ output, comparisons: receipt.comparisons, fullBrowserCompiler: false }));
