import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { TARGET } from './transform.mjs';
import { prepareIrInterning, verifyIrInterning, verifyFinalIrInterning } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), execute = promisify(execFile);
assert.equal(process.argv.length, 3, 'Usage: check.mjs NEW_OUTPUT_ROOT');
const output = path.resolve(process.argv[2]); assert(output.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(output, { mode: 0o700 });
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources'), local = name => path.join(output, name);
const prepared = await prepareIrInterning({ sourceRoot, outputRoot: local('prepared') });
const options = { sourceRoot, outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256 };
await verifyIrInterning(options);
const selected = [];
for (const filename of prepared.commonSources) { const bytes = await readRegular(filename); selected.push({ path: path.relative(prepared.outputRoot, filename), filename, bytes: bytes.length, sha256: sha256(bytes) }); }
const finalReceipt = await verifyFinalIrInterning({ ...options, retainedSources: selected });
const bootstrap = await verifyBootstrap(), commands = [], inputs = [], adapters = [];
async function store(name, bytes) { const filename = local(name); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename; }
for (const name of ['Probe.kt', 'JvmEntry.kt', 'WasmEntry.kt', 'PrimitiveSearchBoundary.kt', 'CanonicalInterningSet.kt', 'check.mjs', 'prepare.mjs', 'transform.mjs', 'sources.lock.json']) {
    const bytes = await readRegular(path.join(HERE, name)); inputs.push({ path: path.join(HERE, name), bytes: bytes.length, sha256: sha256(bytes) });
    if (name.endsWith('.kt')) await store(name, bytes);
}
const originalBytes = await readRegular(path.join(sourceRoot, TARGET));
const commonBytes = await readRegular(prepared.commonSources[0]);
await store('reference-original.kt', originalBytes);
const compiler = bootstrap.artifacts.find(pin => pin.id === 'compiler').path;
for (const directory of ['jvm', 'klib', 'wasm']) await mkdir(local(directory));
async function run(phase, binary, args) {
    console.log('phase: ' + phase);
    const argName = phase + '.arguments.json'; await store(argName, Buffer.from(JSON.stringify([binary, ...args], null, 2) + '\n'));
    try {
        const result = await execute(binary, args, { cwd: output, timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
        commands.push({ phase, command: [binary, ...args], argumentFileSha256: sha256(await readRegular(local(argName))), exitCode: 0 });
        if (result.stderr) process.stderr.write(result.stderr); return result.stdout;
    } catch (error) {
        await writeJson(local('failure.json'), { phase, exitCode: error.code, stderr: String(error.stderr ?? '').slice(-12000), commands });
        if (error.stderr) process.stderr.write(String(error.stderr).slice(-12000)); throw new Error(phase + ' failed');
    }
}
const java = ['-Xmx768m', '-cp', bootstrap.classPath], stdlib = bootstrap.artifacts.find(pin => pin.id === 'stdlib-jvm').path;
const flagsBytes = await readRegular(path.join(HERE, '../build-flags.json')), flags = JSON.parse(flagsBytes);
inputs.push({ path: path.join(HERE, '../build-flags.json'), bytes: flagsBytes.length, sha256: sha256(flagsBytes) });
const compilerFlags = ['-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
const jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', ...compilerFlags];
const observed = {};
const sourceLock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
for (const pin of sourceLock.callerAndDependencySources) {
    const filename = path.join(sourceRoot, pin.path), bytes = await readRegular(filename);
    inputs.push({ path: filename, bytes: bytes.length, sha256: sha256(bytes) });
}
const irFilePin = sourceLock.callerAndDependencySources.find(pin => pin.path.endsWith('/IrFileEntry.kt'));
const fileEntry = await store('IrFileEntry.kt', await readRegular(path.join(sourceRoot, irFilePin.path)));
const additional = sourceLock.callerAndDependencySources.find(pin => pin.path.endsWith('/AdditionalIrUtils.kt'));
const additionalBytes = await readRegular(path.join(sourceRoot, additional.path));
const additionalText = additionalBytes.toString(), start = additionalText.indexOf('const val SYNTHETIC_OFFSET = -2'), end = additionalText.indexOf('// This declaration accesses IrDeclarationContainer.declarations', start);
assert(start > 0 && end > start); const naiveBody = additionalText.slice(start, end);
assert(naiveBody.includes('class NaiveSourceBasedFileEntryImpl('));
const naive = await store('NaiveSourceBasedFileEntryImpl.kt', Buffer.from('package org.jetbrains.kotlin.ir.util\n\nimport org.jetbrains.kotlin.ir.*\n\n' + naiveBody));
adapters.push({ kind: 'complete-genuine-naive-class-and-constant-extraction', originalPath: additional.path,
    originalSha256: sha256(additionalBytes), byteStart: Buffer.byteLength(additionalText.slice(0, start)), byteEnd: Buffer.byteLength(additionalText.slice(0, end)),
    exactBodySha256: sha256(Buffer.from(naiveBody)), alteredClassBody: false });
const nameOriginal = sourceLock.callerAndDependencySources.find(pin => pin.path.endsWith('/Name.java'));
const nameJava = await store('original-java/org/jetbrains/kotlin/name/Name.java', await readRegular(path.join(sourceRoot, nameOriginal.path)));
const nameCommonBytes = await readRegular(path.join(HERE, '../core/Name.kt'));
inputs.push({ path: path.join(HERE, '../core/Name.kt'), bytes: nameCommonBytes.length, sha256: sha256(nameCommonBytes) });
const nameCommon = await store('Name.kt', nameCommonBytes);
const annotations = bootstrap.artifacts.find(pin => pin.id === 'annotations').path;
await mkdir(local('jvm/original-java'));
await run('genuine-original-name-java-build', 'javac', ['-cp', annotations, '-d', local('jvm/original-java'), nameJava]);
const originalService = await store('original-service.kt', Buffer.from(originalBytes.toString().replaceAll('import it.unimi.dsi.fastutil.', 'import org.jetbrains.kotlin.it.unimi.dsi.fastutil.')));
adapters.push({ kind: 'embeddable-fastutil-import-relocation-only', originalSha256: sha256(originalBytes), adaptedSha256: sha256(await readRegular(originalService)) });
const probeBytes = await readRegular(local('Probe.kt'));
const originalProbe = await store('OriginalProbe.kt', Buffer.from(probeBytes.toString()
    .replace('import org.jetbrains.kotlin.portable.interning.Hash', 'import org.jetbrains.kotlin.it.unimi.dsi.fastutil.Hash')
    .replace('import org.jetbrains.kotlin.portable.interning.ObjectOpenCustomHashSet', 'import org.jetbrains.kotlin.it.unimi.dsi.fastutil.objects.ObjectOpenCustomHashSet')
    .replace('import org.jetbrains.kotlin.portable.interning.ObjectOpenHashSet', 'import org.jetbrains.kotlin.it.unimi.dsi.fastutil.objects.ObjectOpenHashSet')));
for (const [label, service, probe, helpers] of [
    ['original', originalService, originalProbe, []],
    ['common', prepared.commonSources[0], local('Probe.kt'), [prepared.commonSources[1], nameCommon]],
]) {
    const classpath = [stdlib, compiler, ...(label === 'original' ? [local('jvm/original-java')] : [])].join(path.delimiter);
    await run(label + '-complete-service-and-genuine-types-jvm-build', 'java', [...jvm, '-classpath', classpath, '-d', local('jvm/' + label + '.jar'),
        service, probe, fileEntry, naive, local('JvmEntry.kt'), ...helpers]);
    observed[label] = await run(label + '-complete-service-jvm-observe', 'java', ['-ea', '-cp', [local('jvm/' + label + '.jar'), local('jvm/original-java'), stdlib, compiler].join(path.delimiter),
        'org.jetbrains.kotlin.portable.interning.probe.JvmEntryKt']);
    await store(label + '-observations.txt', Buffer.from(observed[label]));
}
assert.equal(observed.common, observed.original, 'Original Fastutil/common raw observations differ');
const wasmFileEntryBytes = Buffer.from((await readRegular(fileEntry)).toString().replace('package org.jetbrains.kotlin.ir',
    'package org.jetbrains.kotlin.ir\n\nimport org.jetbrains.kotlin.portable.interning.probe.binarySearch'));
const wasmFileEntry = await store('wasm-IrFileEntry.kt', wasmFileEntryBytes);
adapters.push({ kind: 'proof-only-wasm-primitive-search-import', originalPath: irFilePin.path, originalSha256: irFilePin.sha256,
    adaptedSha256: sha256(wasmFileEntryBytes), alteredClassBodies: false, shippingSourceChanged: false });
const common = [prepared.commonSources[0], prepared.commonSources[1], nameCommon, wasmFileEntry, naive, local('Probe.kt'), local('PrimitiveSearchBoundary.kt')];
const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-libraries', bootstrap.wasmJsStdlib, ...compilerFlags];
await run('complete-service-wasm-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-ir-output-dir', local('klib'), '-ir-output-name', 'ir-interning', ...common, local('WasmEntry.kt')]);
await run('complete-service-wasm-module-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + local('klib/ir-interning.klib'), '-ir-output-dir', local('wasm'), '-ir-output-name', 'ir-interning', '-main', 'noCall', '-Xwasm-enable-asserts']);
observed.wasm = await run('complete-service-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const m=await import(process.argv[1]);process.stdout.write(m.irInterningObservation());', pathToFileURL(local('wasm/ir-interning.mjs')).href]);
await store('wasm-observations.txt', Buffer.from(observed.wasm));
assert.equal(observed.wasm, observed.original, 'Original JVM/common Node-Wasm raw observations differ');
await verifyIrInterning(options);
for (const pin of inputs) { const bytes = await readRegular(pin.path); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'Interning proof input changed during run'); }
const artifacts = [];
async function collect(directory) {
    for (const entry of await readdir(local(directory), { withFileTypes: true })) {
        const name = directory ? directory + '/' + entry.name : entry.name;
        if (entry.isDirectory()) await collect(name);
        else { const bytes = await readRegular(local(name), 32 * 1024 * 1024); artifacts.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
    }
}
await collect(''); const records = observed.original.trimEnd().split('\n'); assert(records.length > 30000);
assert.equal(new Set(records.map(line => line.split('|')[0])).size, records.length);
const receipt = { schemaVersion: 1, kind: 'genuine-complete-ir-interning-jvm-wasm-differential', artifactRoot: path.relative(REPO, output),
    source: prepared.receipt.source, sourceLockSha256: prepared.receipt.sourceLockSha256, preparation: prepared.receipt, finalReceipt,
    inputs, artifacts, commands, adapters, buildFlagsSha256: sha256(flagsBytes),
    bootstrap: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    comparison: { records: records.length, originalJvmEqualsCommonJvm: true, originalJvmEqualsNodeWasm: true,
        completeConsumerBodyPreserved: true, genuineNameAndIrFileEntriesExecuted: true, normalizedText: false, rawSha256: sha256(Buffer.from(observed.original)) },
    scope: 'Complete IrInterningService, genuine full IrFileEntry/AbstractIrFileEntry, complete extracted NaiveSourceBasedFileEntryImpl, original Java/common Name; canonical identities, lazy/reset lifecycle, all structural fields, polymorphic equality and hash collisions, open-addressed rehash, null-equivalent strategy bucket.',
    limitations: ['NaiveSourceBasedFileEntryImpl and its SYNTHETIC_OFFSET are extracted as complete byte-identical declarations from pinned AdditionalIrUtils.kt; unrelated IR utility declarations are not executed.',
        'Full IR deserialization/linking, whole compiler Wasm integration, browser/offline compile behavior, Fastutil iteration/removal/serialization interfaces and memory or throughput parity are not verified.',
        'Inherited anonymous strategy identity-hash seed is preserved in the complete source; raw identity-hash integers differ per process and are not compared.',
        'The pinned Wasm stdlib lacks IntArray.binarySearch. Wasm proof imports a default-range search boundary outside compiler packages into the otherwise untouched full IrFileEntry source; it is not a shipping compiler fix.'],
    browserExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
await writeJson(local('receipt.json'), receipt); console.log(JSON.stringify({ output, comparison: receipt.comparison }));
