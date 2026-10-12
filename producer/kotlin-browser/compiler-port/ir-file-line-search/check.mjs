import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { TARGET } from './transform.mjs';
import { prepareIrFileLineSearch, verifyIrFileLineSearch, verifyFinalIrFileLineSearch } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), execute = promisify(execFile);
assert.equal(process.argv.length, 3, 'Usage: check.mjs NEW_OUTPUT_ROOT');
const output = path.resolve(process.argv[2]); assert(output.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(output, { mode: 0o700 });
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources'), local = name => path.join(output, name);
const prepared = await prepareIrFileLineSearch({ sourceRoot, outputRoot: local('prepared') });
const options = { sourceRoot, outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256 };
await verifyIrFileLineSearch(options);
const bytes = await readRegular(prepared.commonSources[0]);
const finalReceipt = await verifyFinalIrFileLineSearch({ ...options, retainedSources: [{ path: TARGET, filename: prepared.commonSources[0], bytes: bytes.length, sha256: sha256(bytes) }] });
const bootstrap = await verifyBootstrap(), commands = [], inputs = [];
async function store(name, bytes) { const filename = local(name); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename; }
for (const name of ['Probe.kt', 'JvmEntry.kt', 'WasmEntry.kt', 'check.mjs', 'prepare.mjs', 'transform.mjs', 'sources.lock.json']) {
    const bytes = await readRegular(path.join(HERE, name)); inputs.push({ path: path.join(HERE, name), bytes: bytes.length, sha256: sha256(bytes) });
    if (name.endsWith('.kt')) await store(name, bytes);
}
const originalBytes = await readRegular(path.join(sourceRoot, TARGET));
inputs.push({ path: path.join(sourceRoot, TARGET), bytes: originalBytes.length, sha256: sha256(originalBytes) });
const original = await store('original/IrFileEntry.kt', originalBytes);
for (const dir of ['jvm', 'klib', 'wasm']) await mkdir(local(dir));
async function run(phase, binary, args) {
    console.log('phase: ' + phase);
    await store(phase + '.arguments.json', Buffer.from(JSON.stringify([binary, ...args], null, 2) + '\n'));
    try {
        const result = await execute(binary, args, { cwd: output, timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
        commands.push({ phase, command: [binary, ...args], argumentFileSha256: sha256(await readRegular(local(phase + '.arguments.json'))), exitCode: 0 });
        if (result.stderr) process.stderr.write(result.stderr); return result.stdout;
    } catch (error) {
        await writeJson(local('failure.json'), { phase, exitCode: error.code, stderr: String(error.stderr ?? '').slice(-12000), commands });
        if (error.stderr) process.stderr.write(String(error.stderr).slice(-12000)); throw new Error(phase + ' failed');
    }
}
const flagsBytes = await readRegular(path.join(HERE, '../build-flags.json')), flags = JSON.parse(flagsBytes);
inputs.push({ path: path.join(HERE, '../build-flags.json'), bytes: flagsBytes.length, sha256: sha256(flagsBytes) });
const compilerFlags = ['-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
const java = ['-Xmx768m', '-cp', bootstrap.classPath], stdlib = bootstrap.artifacts.find(pin => pin.id === 'stdlib-jvm').path;
const jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', ...compilerFlags];
const observed = {};
for (const [label, source] of [['original', original], ['common', prepared.commonSources[0]]]) {
    await run(label + '-full-file-jvm-build', 'java', [...jvm, '-classpath', stdlib, '-d', local('jvm/' + label + '.jar'), source, local('Probe.kt'), local('JvmEntry.kt')]);
    observed[label] = await run(label + '-full-file-jvm-observe', 'java', ['-ea', '-cp', [local('jvm/' + label + '.jar'), stdlib].join(path.delimiter), 'org.jetbrains.kotlin.portable.irlines.probe.JvmEntryKt']);
    await store(label + '-observations.txt', Buffer.from(observed[label]));
}
assert.equal(observed.common, observed.original, 'Full original/common IR file observations differ');
const wasmStdlib = bootstrap.wasmJsStdlib;
const sources = [prepared.commonSources[0], local('Probe.kt'), local('WasmEntry.kt')];
await run('full-common-file-wasm-klib', 'java', [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js',
    '-Xmulti-platform', '-Xcommon-sources=' + sources.join(','), '-libraries', wasmStdlib, '-ir-output-dir', local('klib'), '-ir-output-name', 'ir-file-line-search', ...compilerFlags, ...sources]);
await run('full-common-file-wasm-link', 'java', [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js',
    '-Xir-produce-js', '-Xinclude=' + local('klib/ir-file-line-search.klib'), '-libraries', wasmStdlib,
    '-ir-output-dir', local('wasm'), '-ir-output-name', 'ir-file-line-search', ...compilerFlags]);
observed.wasm = await run('full-common-file-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const m=await import(process.argv[1]);process.stdout.write(m.run());', pathToFileURL(local('wasm/ir-file-line-search.mjs')).href]);
await store('wasm-observations.txt', Buffer.from(observed.wasm));
assert.equal(observed.wasm, observed.original, 'Full original JVM/common Node-Wasm raw IR file observations differ');
await verifyIrFileLineSearch(options);
for (const pin of inputs) { const bytes = await readRegular(pin.path); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'IR file proof input changed'); }
const artifacts = [];
async function collect(directory) {
    for (const entry of await readdir(local(directory), { withFileTypes: true })) {
        const name = directory ? directory + '/' + entry.name : entry.name;
        if (entry.isDirectory()) await collect(name);
        else { const bytes = await readRegular(local(name), 32 * 1024 * 1024); artifacts.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
    }
}
await collect(''); const records = observed.original.trimEnd().split('\n'); assert(records.length > 40000);
const receipt = { schemaVersion: 1, kind: 'genuine-ir-file-line-search-jvm-wasm-differential', result: 'pass',
    source: prepared.receipt.source, preparation: prepared.receipt, finalReceipt, inputs, artifacts, commands,
    buildFlagsSha256: sha256(flagsBytes), bootstrap: { version: bootstrap.lock.version, sourceCommit: null,
        artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    comparison: { records: records.length, originalJvmEqualsCommonJvm: true, originalJvmEqualsNodeWasm: true,
        completeConsumerBodyPreserved: true, normalizedText: false, rawSha256: sha256(Buffer.from(observed.original)) },
    scope: 'Complete IrFileEntry/AbstractIrFileEntry, source range and line/column data classes; every method, boundary offsets, duplicates, getter effects, mutable and replaced offset arrays, serialization live views, equality/hash.',
    limitations: ['No unrelated IR class dependency projections are used. Whole IR pipeline and browser execution remain unverified.',
        'The default whole-array search gains one live list view per query; allocation/throughput parity is unmeasured.',
        'General concurrent mutation of offset arrays during a search and non-default binary-search range overloads are not claimed.'],
    fullCommonClassWasmExecuted: true, fullCompilerBuilt: false, languageReadiness: false };
await writeJson(local('receipt.json'), receipt); console.log(JSON.stringify({ output, comparison: receipt.comparison }));
