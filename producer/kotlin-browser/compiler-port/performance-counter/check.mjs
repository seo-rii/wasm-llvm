import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { COUNTER } from './transform.mjs';
import { preparePerformanceCounter, verifyPerformanceCounter, verifyFinalPerformanceCounter } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), execute = promisify(execFile);
assert.equal(process.argv.length, 3, 'Usage: check.mjs NEW_OUTPUT_ROOT');
const output = path.resolve(process.argv[2]); assert(output.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(output, { mode: 0o700 });
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources'), local = name => path.join(output, name);
const prepared = await preparePerformanceCounter({ sourceRoot, outputRoot: local('prepared') });
await verifyPerformanceCounter({ sourceRoot, outputRoot: prepared.outputRoot });
const selected = [];
for (const filename of prepared.commonSources) { const bytes = await readRegular(filename); selected.push({ path: path.relative(prepared.outputRoot, filename), filename, bytes: bytes.length, sha256: sha256(bytes) }); }
const finalReceipt = await verifyFinalPerformanceCounter({ sourceRoot, outputRoot: prepared.outputRoot, retainedSources: selected });
const bootstrap = await verifyBootstrap(), commands = [], inputs = [];
async function store(name, bytes) { const filename = local(name); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename; }
for (const name of ['Probe.kt', 'JvmEntry.kt', 'WasmEntry.kt', 'PerformanceCounterHost.kt', 'OriginalSupport.kt', 'CommonSupport.kt', 'check.mjs', 'prepare.mjs', 'transform.mjs', 'sources.lock.json']) {
    const bytes = await readRegular(path.join(HERE, name)); inputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    if (name.endsWith('.kt')) await store(name, bytes);
}
const original = await readRegular(path.join(sourceRoot, COUNTER));
const clockCall = 'System.nanoTime()', clockAlias = 'org.jetbrains.kotlin.util.portable.performanceCounterNanoTime()';
assert.equal(original.toString().split(clockCall).length, 2);
const originalFilename = await store('Original.kt', Buffer.from(original.toString().replace(clockCall, clockAlias)));
const commonBytes = await readRegular(prepared.commonSources[0]);
const commonFilename = await store('Common.kt', commonBytes);
const assertedCommon = await store('CommonWasm.kt', Buffer.from(commonBytes.toString().replace('package org.jetbrains.kotlin.util\n',
    'package org.jetbrains.kotlin.util\nimport org.jetbrains.kotlin.portable.assertions.compilerAssert as assert\n')));
const assertions = await store('CompilerAssertions.kt', await readRegular(path.join(HERE, '../assertions/CompilerAssertions.kt')));
for (const directory of ['jvm', 'klib', 'wasm']) await mkdir(local(directory));
async function run(phase, binary, args) {
    console.log('phase: ' + phase);
    try { const result = await execute(binary, args, { cwd: output, timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
        commands.push({ phase, command: [binary, ...args], exitCode: 0 }); if (result.stderr) process.stderr.write(result.stderr); return result.stdout;
    } catch (error) { await writeJson(local('failure.json'), { phase, exitCode: error.code, stderr: String(error.stderr ?? '').slice(-12000), commands });
        if (error.stderr) process.stderr.write(String(error.stderr).slice(-12000)); throw new Error(phase + ' failed'); }
}
const java = ['-Xmx768m', '-cp', bootstrap.classPath], stdlib = bootstrap.artifacts.find(pin => pin.id === 'stdlib-jvm').path;
const flags = JSON.parse(await readRegular(path.join(HERE, '../build-flags.json')));
const compilerFlags = ['-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
const jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', ...compilerFlags, '-classpath', stdlib];
const observed = {};
for (const [label, source] of [['original', originalFilename], ['common', commonFilename]]) {
    await run(label + '-complete-counter-jvm-build', 'java', [...jvm, '-d', local('jvm/' + label + '.jar'), source, local(label === 'original' ? 'OriginalSupport.kt' : 'CommonSupport.kt'), local('PerformanceCounterHost.kt'), local('Probe.kt'), local('JvmEntry.kt')]);
    observed[label] = await run(label + '-complete-counter-jvm-observe', 'java', ['-ea', '-cp', [local('jvm/' + label + '.jar'), stdlib].join(path.delimiter), 'org.jetbrains.kotlin.util.portable.probe.JvmEntryKt']);
    await store(label + '-observations.txt', Buffer.from(observed[label]));
}
assert.equal(observed.common, observed.original, 'Full original/common JVM counter observations differ');
const common = [assertedCommon, assertions, local('CommonSupport.kt'), local('PerformanceCounterHost.kt'), local('Probe.kt')];
const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-libraries', bootstrap.wasmJsStdlib, ...compilerFlags];
await run('complete-counter-wasm-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-ir-output-dir', local('klib'), '-ir-output-name', 'performance-counter', ...common, local('WasmEntry.kt')]);
await run('complete-counter-wasm-module-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + local('klib/performance-counter.klib'), '-ir-output-dir', local('wasm'), '-ir-output-name', 'performance-counter', '-main', 'noCall', '-Xwasm-enable-asserts']);
observed.wasm = await run('complete-counter-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const m=await import(process.argv[1]);process.stdout.write(m.performanceCounterObservation());', pathToFileURL(local('wasm/performance-counter.mjs')).href]);
await store('wasm-observations.txt', Buffer.from(observed.wasm)); assert.equal(observed.wasm, observed.original, 'Full original JVM/Node Wasm counter observations differ');
await verifyPerformanceCounter({ sourceRoot, outputRoot: prepared.outputRoot });
for (const pin of inputs) { const bytes = await readRegular(path.join(HERE, pin.path)); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'Proof input changed during run'); }
const artifacts = [];
async function collect(directory) {
    for (const entry of await readdir(local(directory), { withFileTypes: true })) {
        const name = directory ? directory + '/' + entry.name : entry.name;
        if (entry.isDirectory()) await collect(name);
        else { const bytes = await readRegular(local(name)); artifacts.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
    }
}
await collect('');
const receipt = { schemaVersion: 1, kind: 'full-genuine-performance-counter-jvm-wasm-differential', artifactRoot: path.relative(REPO, output),
    source: prepared.receipt.source, sourceLockSha256: prepared.receipt.sourceLockSha256, preparation: prepared.receipt, finalReceipt,
    originalClockSubstitution: { original: clockCall, replacement: clockAlias, occurrences: 1, otherOriginalBytesUnchanged: true },
    inputs, artifacts, commands, bootstrap: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    comparison: { records: observed.original.trimEnd().split('\n').length, originalJvmEqualsCommonJvm: true, originalJvmEqualsFullNodeWasm: true,
        fullSourceExecuted: true, methodProjection: false, normalizedText: false, rawSha256: sha256(Buffer.from(observed.original)) },
    scope: 'Simple, reentrant, excluded and nested throw timing; exact clock reads, count/reset/report snapshot; signed milliseconds and Long wrap; nested/throw clock restoration.',
    timingHost: 'Deterministic injected clock only, not browser real-clock precision validation.',
    singleWorkerOnly: true, browserExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
await writeJson(local('receipt.json'), receipt); console.log(JSON.stringify({ output, comparison: receipt.comparison }));
