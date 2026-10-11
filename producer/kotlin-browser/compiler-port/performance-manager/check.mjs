import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { applyRecipe } from './transform.mjs';
import { preparePerformanceManager, verifyPerformanceManager, verifyFinalPerformanceManager } from './prepare.mjs';
import { preparePerformanceCounter, verifyPerformanceCounter } from '../performance-counter/prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), execute = promisify(execFile);
assert.equal(process.argv.length, 3, 'Usage: check.mjs NEW_OUTPUT_ROOT');
const output = path.resolve(process.argv[2]); assert(output.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(output, { mode: 0o700 });
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources'), local = name => path.join(output, name);
const lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
const prepared = await preparePerformanceManager({ sourceRoot, outputRoot: local('prepared') });
await verifyPerformanceManager({ sourceRoot, outputRoot: prepared.outputRoot });
const counter = await preparePerformanceCounter({ sourceRoot, outputRoot: local('counter') });
const selected = [];
for (const filename of prepared.commonSources) { const bytes = await readRegular(filename); selected.push({ path: path.relative(prepared.outputRoot, filename), filename, bytes: bytes.length, sha256: sha256(bytes) }); }
const finalReceipt = await verifyFinalPerformanceManager({ sourceRoot, outputRoot: prepared.outputRoot, retainedSources: selected });
const bootstrap = await verifyBootstrap(), commands = [], inputs = [];
async function store(name, bytes) { const filename = local(name); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename; }
for (const name of ['Probe.kt', 'JvmEntry.kt', 'WasmEntry.kt', 'JvmHost.kt', 'WasmHost.kt', 'PerformanceManagerHost.kt', 'PerformanceCollections.kt', 'check.mjs', 'prepare.mjs', 'transform.mjs', 'sources.lock.json']) {
    const bytes = await readRegular(path.join(HERE, name)); inputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    if (name.endsWith('.kt')) await store(name, bytes);
}
const platform = [];
for (const pin of lock.probeSources) {
    const bytes = verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin);
    if (pin.path === lock.probeProjection.path) {
        const projection = lock.probeProjection; assert.equal(bytes.toString().slice(projection.start), projection.before);
        platform.push(await store('platform/PlatformDescription.kt', verifyFile(Buffer.from('package org.jetbrains.kotlin.platform\n\n' + projection.before), projection.output)));
    } else platform.push(await store('platform/' + path.basename(pin.path), bytes));
}
const originals = [];
for (const source of lock.sources) {
    const bytes = verifyFile(await readRegular(path.join(sourceRoot, source.original.path)), source.original);
    originals.push(await store('original/' + path.basename(source.original.path), applyRecipe(bytes, source.referenceHostRecipe)));
}
const counterOriginal = verifyFile(await readRegular(path.join(sourceRoot, counter.receipt.original.path)), counter.receipt.original);
assert.equal(counterOriginal.toString().split('System.nanoTime()').length, 2);
originals.push(await store('original/PerformanceCounter.kt', Buffer.from(counterOriginal.toString().replace('System.nanoTime()', 'org.jetbrains.kotlin.util.portable.performanceCounterNanoTime()'))));
const supportHeader = 'package org.jetbrains.kotlin.util.portable.probe\nimport org.jetbrains.kotlin.util.UnitStats\nimport org.jetbrains.kotlin.stats.TimestampReportsData\n';
const originalSupport = await store('OriginalSupport.kt', Buffer.from(supportHeader + `
internal fun timestampReports(name: String, values: List<UnitStats>, reverse: Boolean): TimestampReportsData {
    val comparator = if (reverse) compareByDescending<UnitStats> { it.timeStampMs } else compareBy<UnitStats> { it.timeStampMs }
    return TimestampReportsData(name, java.util.TreeSet<UnitStats>(comparator).also { it.addAll(values) })
}
internal fun probeReportBytes(text: String): ByteArray = text.toByteArray()
`));
const commonSupport = await store('CommonSupport.kt', Buffer.from(supportHeader + 'import org.jetbrains.kotlin.util.portable.performanceReportBytes\n' + `
internal fun timestampReports(name: String, values: List<UnitStats>, reverse: Boolean): TimestampReportsData {
    val comparator = if (reverse) compareByDescending<UnitStats> { it.timeStampMs } else compareBy<UnitStats> { it.timeStampMs }
    val sorted = values.distinctBy { it.timeStampMs }.sortedWith(comparator).toCollection(linkedSetOf())
    val view = object : org.jetbrains.kotlin.util.portable.PerformanceReportSortedSet<UnitStats>, Set<UnitStats> by sorted {}
    return TimestampReportsData(name, view)
}
internal fun probeReportBytes(text: String): ByteArray = text.performanceReportBytes()
`));
const assertions = await store('CompilerAssertions.kt', await readRegular(path.join(HERE, '../assertions/CompilerAssertions.kt')));
const commonWasm = [];
for (const filename of [...prepared.commonSources, ...counter.commonSources]) {
    const bytes = await readRegular(filename);
    commonWasm.push(await store('wasm-input/' + path.basename(filename), Buffer.from(bytes.toString().replace(/(^package[^\r\n]+)\n/m,
        '$1\nimport org.jetbrains.kotlin.portable.assertions.compilerAssert as assert\n'))));
}
for (const directory of ['jvm', 'klib', 'wasm']) await mkdir(local(directory));
async function run(phase, binary, args) {
    console.log('phase: ' + phase);
    try { const result = await execute(binary, args, { cwd: output, timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
        commands.push({ phase, command: [binary, ...args], exitCode: 0 }); if (result.stderr) process.stderr.write(result.stderr); return result.stdout;
    } catch (error) { await writeJson(local('failure.json'), { phase, exitCode: error.code, stderr: String(error.stderr ?? '').slice(-14000), commands });
        if (error.stderr) process.stderr.write(String(error.stderr).slice(-14000)); throw new Error(phase + ' failed'); }
}
const java = ['-Xmx768m', '-cp', bootstrap.classPath], stdlib = bootstrap.artifacts.find(pin => pin.id === 'stdlib-jvm').path;
const flags = JSON.parse(await readRegular(path.join(HERE, '../build-flags.json')));
const compilerFlags = ['-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
const jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', ...compilerFlags, '-classpath', stdlib];
const observed = {};
for (const label of ['original', 'common']) {
    const sources = label === 'original' ? [...originals, local('PerformanceManagerHost.kt'), local('PerformanceCollections.kt'), counter.commonSources[1], originalSupport]
        : [...prepared.commonSources, ...counter.commonSources, commonSupport];
    await run(label + '-full-manager-family-jvm-build', 'java', [...jvm, '-d', local('jvm/' + label + '.jar'), ...sources, ...platform, local('JvmHost.kt'), local('Probe.kt'), local('JvmEntry.kt')]);
    observed[label] = await run(label + '-full-manager-family-jvm-observe', 'java', ['-ea', '-cp', [local('jvm/' + label + '.jar'), stdlib].join(path.delimiter), 'org.jetbrains.kotlin.util.portable.probe.JvmEntryKt', local(label + '-HostOracle.kt')]);
    await store(label + '-observations.txt', Buffer.from(observed[label]));
}
assert.equal(observed.common, observed.original, 'Full original/common JVM performance observations differ');
assert.deepEqual(await readRegular(local('common-HostOracle.kt')), await readRegular(local('original-HostOracle.kt')), 'Host request/response trace differs');
const common = [...commonWasm, ...platform, assertions, commonSupport, local('WasmHost.kt'), local('original-HostOracle.kt'), local('Probe.kt')];
const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-libraries', bootstrap.wasmJsStdlib, ...compilerFlags];
await run('full-manager-family-wasm-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-ir-output-dir', local('klib'), '-ir-output-name', 'performance-manager', ...common, local('WasmEntry.kt')]);
await run('full-manager-family-wasm-module-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + local('klib/performance-manager.klib'), '-ir-output-dir', local('wasm'), '-ir-output-name', 'performance-manager', '-main', 'noCall', '-Xwasm-enable-asserts']);
observed.wasm = await run('full-manager-family-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const m=await import(process.argv[1]);process.stdout.write(m.performanceManagerObservation());', pathToFileURL(local('wasm/performance-manager.mjs')).href]);
await store('wasm-observations.txt', Buffer.from(observed.wasm)); assert.equal(observed.wasm, observed.original, 'Full original JVM/Node Wasm manager observations differ');
await verifyPerformanceManager({ sourceRoot, outputRoot: prepared.outputRoot });
await verifyPerformanceCounter({ sourceRoot, outputRoot: counter.outputRoot });
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
const receipt = { schemaVersion: 1, kind: 'full-genuine-performance-manager-family-jvm-wasm-differential', artifactRoot: path.relative(REPO, output),
    source: prepared.receipt.source, sourceLockSha256: prepared.receipt.sourceLockSha256, preparation: prepared.receipt, finalReceipt,
    referenceHostRecipes: lock.sources.map(source => ({ path: source.original.path, recipe: source.referenceHostRecipe })),
    dependencyScope: { fullPlatformSources: lock.probeSources.filter(pin => pin.path !== lock.probeProjection.path), exactPlatformDescriptionProjection: lock.probeProjection,
        counterPreparation: counter.receipt, originalCounterClockSubstitutions: 1 },
    inputs, artifacts, commands, bootstrap: { version: bootstrap.lock.version, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    comparison: { rawLines: observed.original.trimEnd().split('\n').length, originalJvmEqualsCommonJvm: true, originalJvmEqualsFullNodeWasm: true,
        fullSixSourceFamilyExecuted: true, measuredAlgorithmProjection: false, normalizedText: false, rawSha256: sha256(Buffer.from(observed.original)) },
    hostOracle: 'Original JVM executes Java Formatter and SimpleDateFormat at explicit host seams. Common JVM repeats and compares the entire request/response trace. Wasm replays only these recorded formatting/date host responses, checking exact ordered typed requests and exhaustion. Measurements, stats, file naming, reports and heap algorithms execute in Wasm.',
    scope: 'All phases; side/dynamic throws and finally; child/aggregate/error finalization; K1 counters; CPU/GC/JIT capability values; sorted outputs; heap ties and bounds; plain/JSON/markdown; report filenames/bytes/write failure; host restoration.',
    singleWorkerOnly: true, browserExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
await writeJson(local('receipt.json'), receipt); console.log(JSON.stringify({ output, comparison: receipt.comparison }));
