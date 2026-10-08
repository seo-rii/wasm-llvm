#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { prepareAssertionSources } from './prepare.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);
const parent = path.join(repository, 'out/kotlin-compiler-assertions/checks');
await mkdir(parent, { recursive: true });
const output = await mkdtemp(path.join(parent, 'run-'));
const prepared = await prepareAssertionSources({ outputRoot: output });
const bootstrap = await verifyBootstrap();
const flagsBytes = await readRegular(path.join(here, '../build-flags.json'));
const flags = JSON.parse(flagsBytes);
assert.equal(flags.source.commit, prepared.receipt.source.commit);
const observerBytes = await readRegular(path.join(here, 'AssertionProbe.kt'));
const observer = path.join(output, 'OriginalObserver.kt');
const portableObserver = path.join(output, 'PortableObserver.kt');
assert.equal(observerBytes.toString().split('import kotlin.assert').length, 2);
await writeFile(observer, observerBytes, { flag: 'wx', mode: 0o600 });
await writeFile(portableObserver, observerBytes.toString().replace('import kotlin.assert', 'import ' + prepared.assertionImport), { flag: 'wx', mode: 0o600 });
const jvmMain = path.join(output, 'JvmMain.kt'), wasmExport = path.join(output, 'WasmExport.kt');
await writeFile(jvmMain, 'package org.jetbrains.kotlin.portable.assertioncheck\nfun main() = print(observeAssertions())\n', { flag: 'wx', mode: 0o600 });
await writeFile(wasmExport, 'package org.jetbrains.kotlin.portable.assertioncheck\nimport kotlin.js.JsExport\n@JsExport fun assertionProbe(): String = observeAssertions()\n', { flag: 'wx', mode: 0o600 });
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
    '-language-version', '2.5', '-api-version', '2.5', ...flags.compilerFlags, '-classpath', bootstrap.classPath];
const originalJvm = path.join(output, 'original.jar');
await command('original-jvm-observer', 'java', [...jvmCompiler, '-d', originalJvm, observer, jvmMain]);
const original = await command('original-jvm-run-enabled-assertions', 'java', ['-ea', '-cp', [originalJvm, bootstrap.classPath].join(path.delimiter),
    'org.jetbrains.kotlin.portable.assertioncheck.JvmMainKt']);
const portableJvm = path.join(output, 'portable.jar');
await command('portable-jvm-source', 'java', [...jvmCompiler, '-d', portableJvm, ...prepared.commonSources, portableObserver, jvmMain]);
const portable = await command('portable-jvm-run', 'java', ['-ea', '-cp', [portableJvm, bootstrap.classPath].join(path.delimiter),
    'org.jetbrains.kotlin.portable.assertioncheck.JvmMainKt']);
assert.equal(portable, original, 'Compiler invariant assertions differ from the enabled JVM reference');
const klib = path.join(output, 'klib'), wasm = path.join(output, 'wasm'); await mkdir(klib); await mkdir(wasm);
const wasmCompiler = [...compiler, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js',
    '-language-version', '2.5', '-api-version', '2.5', ...flags.compilerFlags, '-libraries', bootstrap.wasmJsStdlib];
await command('portable-wasmjs-klib', 'java', [...wasmCompiler, '-ir-output-dir', klib, '-ir-output-name', 'compiler-assertions',
    ...prepared.commonSources, portableObserver, wasmExport]);
await command('portable-wasmjs-binary', 'java', [...wasmCompiler, '-Xir-produce-js', '-Xinclude=' + path.join(klib, 'compiler-assertions.klib'),
    '-ir-output-dir', wasm, '-ir-output-name', 'compiler-assertions', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const loader = pathToFileURL(path.join(wasm, 'compiler-assertions.mjs')).href;
const node = await command('portable-node-wasm-run', 'node', ['--experimental-wasm-exnref', '--input-type=module', '-e',
    `const module = await import(${JSON.stringify(loader)}); process.stdout.write(module.assertionProbe());`]);
assert.equal(node, original, 'Compiler invariant assertions differ on the Wasm host');
const receipt = { schemaVersion: 1, kind: 'official-compiler-enabled-assertion-differential', source: prepared.receipt.source,
    sourcePreparation: prepared.receipt, buildFlags: { sha256: sha256(flagsBytes), compilerFlags: flags.compilerFlags }, commands,
    observerSha256: sha256(observerBytes), comparisons: { cases: 16, originalJvm: sha256(Buffer.from(original)),
        portableJvm: sha256(Buffer.from(portable)), wasmNode: sha256(Buffer.from(node)), mismatches: 0 },
    observedOutput: original, browserExecution: 'not-run', fullBrowserCompiler: false };
await writeJson(path.join(output, 'assertions-evidence.json'), receipt);
console.log(JSON.stringify({ output, comparisons: receipt.comparisons, fullBrowserCompiler: false }));
