import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { TARGET } from './transform.mjs';
import { prepareFirPredicateCollections, verifyFirPredicateCollections, verifyFinalFirPredicateCollections } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), execute = promisify(execFile);
assert.equal(process.argv.length, 3, 'Usage: check.mjs NEW_OUTPUT_ROOT');
const output = path.resolve(process.argv[2]); assert(output.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(output, { mode: 0o700 });
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources'), local = name => path.join(output, name);
const prepared = await prepareFirPredicateCollections({ sourceRoot, outputRoot: local('prepared') });
const options = { sourceRoot, outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256 };
await verifyFirPredicateCollections(options);
const selected = [];
for (const filename of prepared.commonSources) { const bytes = await readRegular(filename); selected.push({ path: path.relative(prepared.outputRoot, filename), filename, bytes: bytes.length, sha256: sha256(bytes) }); }
const finalReceipt = await verifyFinalFirPredicateCollections({ ...options, retainedSources: selected });
const bootstrap = await verifyBootstrap(), commands = [], inputs = [], adapters = [];
async function store(name, bytes) { const filename = local(name); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename; }
for (const name of ['Probe.kt', 'JvmEntry.kt', 'WasmEntry.kt', 'Boundary.kt', 'FirPredicateMultimap.kt', 'check.mjs', 'prepare.mjs', 'transform.mjs', 'sources.lock.json']) {
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
function relocateEmbeddable(bytes) {
    let text = bytes.toString();
    for (const [before, after] of [['import com.google.common.collect.', 'import org.jetbrains.kotlin.com.google.common.collect.'],
        ['import kotlinx.collections.immutable.', 'import org.jetbrains.kotlin.kotlinx.collections.immutable.']]) text = text.replaceAll(before, after);
    return Buffer.from(text);
}
// Entire shipping provider bodies typecheck against genuine bootstrap FIR dependencies, adapting only their relocated imports.
for (const [label, bytes] of [['original', originalBytes], ['common', commonBytes]]) {
    const filename = await store('full-' + label + '.kt', relocateEmbeddable(bytes));
    const sources = [filename, ...(label === 'common' ? [prepared.commonSources[1]] : [])];
    await run(label + '-full-provider-jvm-typecheck', 'java', [...jvm, '-classpath', [stdlib, compiler].join(path.delimiter),
        '-Xfriend-paths=' + compiler, '-d', local('jvm/full-' + label + '.jar'), ...sources]);
}
const boundaryPackage = 'org.jetbrains.kotlin.portable.predicate.boundary';
// Proof namespace/import adapters only; every class/function body is identical to its complete source.
function boundaryProvider(bytes, guava) {
    const text = bytes.toString(), start = text.indexOf('@NoMutableState'); assert(start > 0);
    const header = 'package ' + boundaryPackage + '\n\nimport ' + boundaryPackage + '.predicate.*\n'
        + (guava ? 'import org.jetbrains.kotlin.com.google.common.collect.LinkedHashMultimap\nimport org.jetbrains.kotlin.com.google.common.collect.Multimap\n'
            : 'import org.jetbrains.kotlin.portable.predicate.LinkedHashMultimap\nimport org.jetbrains.kotlin.portable.predicate.Multimap\n');
    const result = Buffer.from(header + '\n' + text.slice(start));
    assert.equal(result.toString().slice(result.toString().indexOf('@NoMutableState')), text.slice(start));
    adapters.push({ kind: 'provider-namespace-and-host-imports', originalSha256: sha256(bytes), preservedBodySha256: sha256(Buffer.from(text.slice(start))), guava });
    return result;
}
const predicates = [];
for (const pin of prepared.receipt.callerAndPredicateSources.filter(pin => pin.path.includes('/predicate/'))) {
    const bytes = await readRegular(path.join(sourceRoot, pin.path)); inputs.push({ path: path.join(sourceRoot, pin.path), bytes: bytes.length, sha256: sha256(bytes) });
    const text = bytes.toString().replace('package org.jetbrains.kotlin.fir.extensions.predicate', 'package ' + boundaryPackage + '.predicate')
        .replaceAll('import org.jetbrains.kotlin.fir.extensions.AnnotationFqn', 'import ' + boundaryPackage + '.AnnotationFqn')
        .replaceAll('import org.jetbrains.kotlin.fir.extensions.FirPredicateBasedProvider', 'import ' + boundaryPackage + '.FirPredicateBasedProvider');
    predicates.push(await store('predicates/' + path.basename(pin.path), Buffer.from(text)));
    adapters.push({ kind: 'predicate-namespace-and-type-imports', originalPath: pin.path, originalSha256: sha256(bytes), adaptedSha256: sha256(Buffer.from(text)) });
}
const originalBoundary = await store('boundary-original.kt', boundaryProvider(originalBytes, true));
const commonBoundary = await store('boundary-common.kt', boundaryProvider(commonBytes, false));
const probeBytes = await readRegular(local('Probe.kt'));
const originalProbe = await store('OriginalProbe.kt', Buffer.from(probeBytes.toString().replace('import org.jetbrains.kotlin.portable.predicate.LinkedHashMultimap',
    'import org.jetbrains.kotlin.com.google.common.collect.LinkedHashMultimap')));
const observed = {};
for (const [label, provider, probe, helpers] of [['original', originalBoundary, originalProbe, []], ['common', commonBoundary, local('Probe.kt'), [prepared.commonSources[1]]]]) {
    await run(label + '-full-provider-body-boundary-jvm-build', 'java', [...jvm, '-classpath', [stdlib, compiler].join(path.delimiter), '-d', local('jvm/' + label + '.jar'),
        provider, probe, local('Boundary.kt'), local('JvmEntry.kt'), ...predicates, ...helpers]);
    observed[label] = await run(label + '-provider-boundary-jvm-observe', 'java', ['-ea', '-cp', [local('jvm/' + label + '.jar'), stdlib, compiler].join(path.delimiter), 'org.jetbrains.kotlin.portable.predicate.probe.JvmEntryKt']);
    await store(label + '-observations.txt', Buffer.from(observed[label]));
}
assert.equal(observed.common, observed.original, 'Original Guava/common provider raw observations differ');
const common = [commonBoundary, prepared.commonSources[1], local('Probe.kt'), local('Boundary.kt'), ...predicates];
const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-libraries', bootstrap.wasmJsStdlib, ...compilerFlags];
await run('full-provider-body-boundary-wasm-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-ir-output-dir', local('klib'), '-ir-output-name', 'fir-predicate', ...common, local('WasmEntry.kt')]);
await run('full-provider-body-boundary-wasm-module-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + local('klib/fir-predicate.klib'), '-ir-output-dir', local('wasm'), '-ir-output-name', 'fir-predicate', '-main', 'noCall', '-Xwasm-enable-asserts']);
observed.wasm = await run('provider-boundary-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const m=await import(process.argv[1]);process.stdout.write(m.firPredicateObservation());', pathToFileURL(local('wasm/fir-predicate.mjs')).href]);
await store('wasm-observations.txt', Buffer.from(observed.wasm)); assert.equal(observed.wasm, observed.original, 'Original JVM/common Node Wasm provider raw observations differ');
await verifyFirPredicateCollections(options);
for (const pin of inputs) { const bytes = await readRegular(pin.path); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'Predicate proof input changed during run'); }
const artifacts = [];
async function collect(directory) {
    for (const entry of await readdir(local(directory), { withFileTypes: true })) {
        const name = directory ? directory + '/' + entry.name : entry.name;
        if (entry.isDirectory()) await collect(name);
        else { const bytes = await readRegular(local(name), 32 * 1024 * 1024); artifacts.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
    }
}
await collect(''); const records = observed.original.trimEnd().split('\n'); assert(records.length > 2000);
assert.equal(new Set(records.map(line => line.split('|')[0])).size, records.length);
const receipt = { schemaVersion: 1, kind: 'genuine-fir-predicate-full-body-host-boundary-jvm-wasm-differential', artifactRoot: path.relative(REPO, output),
    source: prepared.receipt.source, sourceLockSha256: prepared.receipt.sourceLockSha256, preparation: prepared.receipt, finalReceipt,
    inputs, artifacts, commands, adapters, buildFlagsSha256: sha256(flagsBytes),
    bootstrap: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    comparison: { records: records.length, originalJvmEqualsCommonJvm: true, originalJvmEqualsNodeWasm: true,
        completeProviderAndPredicateBodiesPreserved: true, realFirObjectsExecuted: false, normalizedText: false, rawSha256: sha256(Buffer.from(observed.original)) },
    scope: 'Genuine Guava versus portable multimap; eight complete cache maps; registration order/repetition, owners, file markers, seven lookup/combinator predicates, origins/local matching, source-session delegation and meta-annotation recursion/cycles with explicit proof-only FIR data/callback boundaries.',
    limitations: ['Runtime FIR/session/type/annotation/lookup/resolve data and callbacks are proof-only adapters outside compiler packages; genuine complete provider source separately JVM typechecks with real bootstrap dependencies.',
        'Full FIR resolution, compiler Wasm integration, browser/offline behavior and compiler plugin end-to-end execution are not verified.',
        'Portable helper implements only pinned provider-used get/put/putAll. Guava collection mutations, global entries ordering/removal and iterator mutation/concurrent modification are not exposed or claimed.'],
    browserExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
await writeJson(local('receipt.json'), receipt); console.log(JSON.stringify({ output, comparison: receipt.comparison }));
