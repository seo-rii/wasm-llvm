import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { TARGET } from './transform.mjs';
import { prepareTowerGroup, verifyTowerGroup, verifyFinalTowerGroup } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), execute = promisify(execFile);
assert.equal(process.argv.length, 3, 'Usage: check.mjs NEW_OUTPUT_ROOT');
const output = path.resolve(process.argv[2]); assert(output.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(output, { mode: 0o700 });
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources'), local = name => path.join(output, name);
const prepared = await prepareTowerGroup({ sourceRoot, outputRoot: local('prepared') });
const options = { sourceRoot, outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256 };
await verifyTowerGroup(options);
const selected = [];
for (const filename of prepared.commonSources) { const bytes = await readRegular(filename); selected.push({ path: path.relative(prepared.outputRoot, filename), filename, bytes: bytes.length, sha256: sha256(bytes) }); }
const finalReceipt = await verifyFinalTowerGroup({ ...options, retainedSources: selected });
const bootstrap = await verifyBootstrap(), commands = [], inputs = [];
async function store(name, bytes) { const filename = local(name); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename; }
for (const name of ['Probe.kt', 'JvmEntry.kt', 'WasmEntry.kt', 'TowerGroupNumbers.kt', 'check.mjs', 'prepare.mjs', 'transform.mjs', 'sources.lock.json']) {
    const bytes = await readRegular(path.join(HERE, name)); inputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    if (name.endsWith('.kt')) await store(name, bytes);
}
const original = await store('Original.kt', await readRegular(path.join(sourceRoot, TARGET)));
for (const directory of ['jvm', 'klib', 'wasm']) await mkdir(local(directory));
async function run(phase, binary, args) {
    console.log('phase: ' + phase);
    try {
        const result = await execute(binary, args, { cwd: output, timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
        commands.push({ phase, command: [binary, ...args], exitCode: 0 }); if (result.stderr) process.stderr.write(result.stderr); return result.stdout;
    } catch (error) {
        await writeJson(local('failure.json'), { phase, exitCode: error.code, stderr: String(error.stderr ?? '').slice(-12000), commands });
        if (error.stderr) process.stderr.write(String(error.stderr).slice(-12000)); throw new Error(phase + ' failed');
    }
}
const java = ['-Xmx768m', '-cp', bootstrap.classPath], stdlib = bootstrap.artifacts.find(pin => pin.id === 'stdlib-jvm').path;
const flagsBytes = await readRegular(path.join(HERE, '../build-flags.json')), flags = JSON.parse(flagsBytes);
const compilerFlags = ['-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
const jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', ...compilerFlags, '-classpath', stdlib];
const observed = {};
for (const [label, sources] of [['original', [original]], ['common', prepared.commonSources]]) {
    await run(label + '-complete-tower-jvm-build', 'java', [...jvm, '-d', local('jvm/' + label + '.jar'), ...sources, local('Probe.kt'), local('JvmEntry.kt')]);
    observed[label] = await run(label + '-complete-tower-jvm-observe', 'java', ['-ea', '-cp', [local('jvm/' + label + '.jar'), stdlib].join(path.delimiter), 'org.jetbrains.kotlin.portable.tower.probe.JvmEntryKt']);
    await store(label + '-observations.txt', Buffer.from(observed[label]));
}
assert.equal(observed.common, observed.original, 'Full original/common JVM tower observations differ');
const common = [...prepared.commonSources, local('Probe.kt')];
const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-libraries', bootstrap.wasmJsStdlib, ...compilerFlags];
await run('complete-tower-wasm-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-ir-output-dir', local('klib'), '-ir-output-name', 'tower-group', ...common, local('WasmEntry.kt')]);
await run('complete-tower-wasm-module-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + local('klib/tower-group.klib'), '-ir-output-dir', local('wasm'), '-ir-output-name', 'tower-group', '-main', 'noCall', '-Xwasm-enable-asserts']);
observed.wasm = await run('complete-tower-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const m=await import(process.argv[1]);process.stdout.write(m.towerGroupObservation());', pathToFileURL(local('wasm/tower-group.mjs')).href]);
await store('wasm-observations.txt', Buffer.from(observed.wasm)); assert.equal(observed.wasm, observed.original, 'Full original JVM/Node Wasm tower observations differ');
await verifyTowerGroup(options);
for (const pin of inputs) { const bytes = await readRegular(path.join(HERE, pin.path)); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'Tower proof input changed during run'); }
const artifacts = [];
async function collect(directory) {
    for (const entry of await readdir(local(directory), { withFileTypes: true })) {
        const name = directory ? directory + '/' + entry.name : entry.name;
        if (entry.isDirectory()) await collect(name);
        else { const bytes = await readRegular(local(name), 32 * 1024 * 1024); artifacts.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
    }
}
await collect(''); const records = observed.original.trimEnd().split('\n'); assert(records.length > 6000);
assert.equal(new Set(records.map(line => line.split('|')[0])).size, records.length);
const receipt = { schemaVersion: 1, kind: 'full-genuine-fir-tower-group-jvm-wasm-differential', artifactRoot: path.relative(REPO, output),
    source: prepared.receipt.source, sourceLockSha256: prepared.receipt.sourceLockSha256, preparation: prepared.receipt, finalReceipt,
    inputs, artifacts, commands, buildFlagsSha256: sha256(flagsBytes),
    bootstrap: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    comparison: { records: records.length, originalJvmEqualsCommonJvm: true, originalJvmEqualsFullNodeWasm: true,
        fullSourceExecuted: true, methodProjection: false, normalizedText: false, rawSha256: sha256(Buffer.from(observed.original)) },
    scope: 'Complete priority/encoding/equality APIs, all kind pairs including subclass classifier identity, signed depths, invoke receiver pairs, overflow rejection and exact messages, binary strings and public debug-kind comparator.',
    limitations: ['Native enum hash integers are host-specific; only within-host stability is observed, not raw enum hash parity.',
        'The genuine DEBUG=false source is executed unchanged; private DEBUG=true dispatch and full FIR resolution are not executed.',
        'Upstream negative depths and asymmetric null receiver equality are retained, not repaired.'],
    browserExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
await writeJson(local('receipt.json'), receipt); console.log(JSON.stringify({ output, comparison: receipt.comparison }));
