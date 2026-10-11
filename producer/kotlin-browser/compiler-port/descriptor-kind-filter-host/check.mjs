import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { TARGET, FILTER_FIELDS } from './transform.mjs';
import { prepareDescriptorKindFilterHost, verifyDescriptorKindFilterHost, verifyFinalDescriptorKindFilterHost } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), execute = promisify(execFile);
assert.equal(process.argv.length, 3, 'Usage: check.mjs NEW_OUTPUT_ROOT');
const output = path.resolve(process.argv[2]); assert(output.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(output, { mode: 0o700 });
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources'), local = name => path.join(output, name);
const prepared = await prepareDescriptorKindFilterHost({ sourceRoot, outputRoot: local('prepared') });
const options = { sourceRoot, outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256 };
await verifyDescriptorKindFilterHost(options);
const selected = [];
for (const filename of prepared.commonSources) { const bytes = await readRegular(filename); selected.push({ path: path.relative(prepared.outputRoot, filename), filename, bytes: bytes.length, sha256: sha256(bytes) }); }
const finalReceipt = await verifyFinalDescriptorKindFilterHost({ ...options, retainedSources: selected });
const bootstrap = await verifyBootstrap(), commands = [], inputs = [];
async function store(name, bytes) { const filename = local(name); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename; }
for (const name of ['Probe.kt', 'check.mjs', 'prepare.mjs', 'transform.mjs', 'sources.lock.json']) {
    const bytes = await readRegular(path.join(HERE, name)); inputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    if (name.endsWith('.kt')) await store(name, bytes);
}
const original = await store('Original.kt', await readRegular(path.join(sourceRoot, TARGET)));
await mkdir(local('jvm'));
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
const compiler = bootstrap.artifacts.find(pin => pin.id === 'compiler').path;
const flagsBytes = await readRegular(path.join(HERE, '../build-flags.json')), flags = JSON.parse(flagsBytes);
const jvm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
    '-jvm-target', '17', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags,
    '-Xfriend-paths=' + compiler, '-classpath', bootstrap.classPath];
const observed = {};
for (const [label, sources] of [['original', [original]], ['common', prepared.commonSources]]) {
    await run(label + '-complete-member-scope-jvm-build', 'java', [...jvm, '-d', local('jvm/' + label + '.jar'), ...sources, local('Probe.kt')]);
    observed[label] = await run(label + '-complete-member-scope-jvm-observe', 'java', ['-ea', '-cp', [local('jvm/' + label + '.jar'), bootstrap.classPath].join(path.delimiter), 'org.jetbrains.kotlin.portable.scopes.probe.ProbeKt']);
    await store(label + '-observations.txt', Buffer.from(observed[label]));
}
assert.equal(observed.common, observed.original, 'Full original/common JVM member-scope observations differ');
assert(observed.original.startsWith('public-filters|' + FILTER_FIELDS.join(',') + '\npublic-int-fields|\n'), 'Actual original reflected field schema changed');
await verifyDescriptorKindFilterHost(options);
for (const pin of inputs) { const bytes = await readRegular(path.join(HERE, pin.path)); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'Scope proof input changed'); }
const artifacts = [];
async function collect(directory) {
    for (const entry of await readdir(local(directory), { withFileTypes: true })) {
        const name = directory ? directory + '/' + entry.name : entry.name;
        if (entry.isDirectory()) await collect(name);
        else { const bytes = await readRegular(local(name), 32 * 1024 * 1024); artifacts.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
    }
}
await collect(''); const records = observed.original.trimEnd().split('\n'); assert(records.length > 10000);
assert.equal(new Set(records.map(line => line.split('|')[0])).size, records.length);
const receipt = { schemaVersion: 1, kind: 'full-genuine-member-scope-jvm-differential', artifactRoot: path.relative(REPO, output),
    source: prepared.receipt.source, sourceLockSha256: prepared.receipt.sourceLockSha256, preparation: prepared.receipt, finalReceipt,
    inputs, artifacts, commands, buildFlagsSha256: sha256(flagsBytes),
    bootstrap: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    comparison: { records: records.length, originalJvmEqualsCommonJvm: true, fullSourceCompiled: true, methodProjection: false,
        normalizedText: false, rawSha256: sha256(Buffer.from(observed.original)) },
    scope: 'All filter mask operations, debug rendering, class equality, empty-list raw hashes, builtin excludes and typed descriptor-kind decisions; public field schema and empty/synthetic scope helpers.',
    limitations: ['Proxy objects supply explicit descriptor kind/receiver/FqName contracts; this does not execute compiler descriptors or FIR resolution.',
        'Remaining MemberScope dependencies come from the verified bootstrap; candidate bootstrap source commit is unknown.',
        'JVM public field iteration is validated for this pinned source and runtime, not all JVM reflection implementations.',
        'Nonempty excludes use native object hashes; only within-host hash equality is compared, not raw identity integers.'],
    fullCommonClassWasmExecuted: false, browserExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
await writeJson(local('receipt.json'), receipt); console.log(JSON.stringify({ output, comparison: receipt.comparison }));
