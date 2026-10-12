import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { assembleImports } from '../type-substitutor-getter/prepare.mjs';
import { lazyMutableImplementationFixture } from './fixture.mjs';
import { SUSPEND_FUNCTIONS, DESERIALIZED_PARAMETER, transformSuspendFunctions } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), execute = promisify(execFile);
const root = path.resolve(process.argv[2]); assert(root.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(root, { mode: 0o700 });
const fixture = await lazyMutableImplementationFixture(), bootstrap = await verifyBootstrap(), commands = [], filePins = [];
const flags = JSON.parse(await readRegular(path.join(HERE, '../build-flags.json')));
async function frozen(filename, pin) {
    const bytes = await readRegular(filename, 100 * 1024 * 1024);
    if (pin) { assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256); if (pin.gitBlob) verifyFile(bytes, pin); }
    filePins.push({ filename, bytes: bytes.length, sha256: sha256(bytes) }); return bytes;
}
async function put(name, bytes) {
    const filename = path.join(root, name); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename;
}
async function run(phase, command) {
    const start = performance.now(); let result, exitCode = 0;
    try { result = await execute(command[0], command.slice(1), { cwd: root, timeout: 300000, maxBuffer: 8 * 1024 * 1024 }); }
    catch (error) { result = error; exitCode = error.code; }
    await put(phase + '.stdout', Buffer.from(result.stdout ?? '')); await put(phase + '.stderr', Buffer.from(result.stderr ?? ''));
    commands.push({ phase, command, exitCode, elapsedMs: performance.now() - start });
    await writeFile(path.join(root, 'commands.json'), JSON.stringify(commands, null, 2) + '\n', { mode: 0o600 });
    assert.equal(exitCode, 0, phase + ': ' + String(result.stderr ?? '').slice(-9000)); return String(result.stdout ?? '');
}
const evidencePath = path.join(HERE, '../descriptor-class-implementations/evidence/runtime.json');
const parentBytes = await frozen(evidencePath), parent = JSON.parse(parentBytes);
assert.equal(parent.kind, 'genuine-descriptor-class-full-jvm-proof'); assert.equal(parent.result, 'pass'); assert(parent.commands.every(row => row.exitCode === 0));
const parentReceiptBytes = await frozen(path.join(parent.outputRoot, 'receipt.json')); assert(parentReceiptBytes.equals(parentBytes));
for (const pin of parent.filePins) await frozen(pin.filename, pin);
for (const pin of parent.artifacts) await frozen(path.join(parent.outputRoot, pin.path), pin);
const annotationsLock = JSON.parse(await frozen(path.join(HERE, '../descriptors/reference.lock.json')));
const annotations = path.join(REPO, 'out/kotlin-compiler-descriptors/reference-artifacts', annotationsLock.artifact.file); await frozen(annotations, annotationsLock.artifact);
const runtimeClasspath = bootstrap.classPath + path.delimiter + annotations;
const cp = (...items) => items.join(path.delimiter);
const originalParent = cp(path.join(parent.outputRoot, 'original-receivers.jar'), path.join(parent.outputRoot, 'original-consumer.jar'), path.join(parent.outputRoot, 'original'));
const commonParent = path.join(parent.outputRoot, 'common.jar');
const compiler = ['java', '-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
    '-jvm-target', '17', '-jvm-default=enable', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
const lock = JSON.parse(await frozen(path.join(HERE, 'sources.lock.json'))), closure = JSON.parse(await frozen(path.join(HERE, '../closure.lock.json')));
const consumerAssemblyImports = ['org.jetbrains.kotlin.portable.descriptors.*'];
assert(fixture.recordedPropertyImports.includes(consumerAssemblyImports[0]));
for (const name of ['probe.mjs', 'transform.mjs', 'fixture.mjs']) await frozen(path.join(HERE, name));
const original = path.join(root, 'original'), oracle = path.join(root, 'oracle'); await mkdir(original); await mkdir(oracle);
const javaSources = [...lock.implementations,
    'core/descriptors/src/org/jetbrains/kotlin/descriptors/impl/AbstractTypeParameterDescriptor.java',
    'core/descriptors/src/org/jetbrains/kotlin/descriptors/impl/TypeParameterDescriptorImpl.java',
    'core/descriptors/src/org/jetbrains/kotlin/types/DescriptorSubstitutor.java'];
const originalJavaFiles = [];
for (const logical of javaSources) originalJavaFiles.push(await put('original-source/' + logical, await frozen(path.join(fixture.sourceRoot, logical), closure.files.find(pin => pin.path === logical))));
await run('full-original-java-lazy-mutable-and-type-parameter-family', ['javac', '-cp', cp(originalParent, runtimeClasspath), '-d', original, ...originalJavaFiles]);
const originalConsumers = [], commonConsumers = [];
for (const logical of [SUSPEND_FUNCTIONS, DESERIALIZED_PARAMETER]) {
    const bytes = await frozen(path.join(fixture.sourceRoot, logical), closure.files.find(pin => pin.path === logical));
    originalConsumers.push(await put('original-consumer/' + logical, bytes));
    const common = logical === SUSPEND_FUNCTIONS ? transformSuspendFunctions(bytes) : bytes;
    commonConsumers.push(await put('common-consumer/' + logical, assembleImports(common, consumerAssemblyImports)));
}
const originalJar = path.join(root, 'original-consumers.jar'), commonJar = path.join(root, 'common.jar');
await run('both-complete-original-kotlin-consumers', [...compiler, '-classpath', cp(original, originalParent, runtimeClasspath), '-d', originalJar, ...originalConsumers]);
const commonSources = [];
for (const pin of lock.common) commonSources.push(await put('common-source/' + pin.path, await frozen(path.join(HERE, pin.path), pin)));
await run('both-complete-common-classes-and-kotlin-consumers', [...compiler, '-classpath', cp(commonParent, runtimeClasspath), '-d', commonJar, ...commonSources, ...commonConsumers]);
const observer = await put('LazyMutableBehaviorProbe.java', await frozen(path.join(HERE, 'proof/LazyMutableBehaviorProbe.java')));
await run('genuine-lazy-mutable-observer', ['javac', '-cp', cp(originalJar, original, originalParent, commonParent, runtimeClasspath), '-d', oracle, observer]);
const raw = {};
for (const [variant, classpath] of [['original', cp(oracle, originalJar, original, originalParent, commonParent, runtimeClasspath)],
    ['common', cp(oracle, commonJar, commonParent, runtimeClasspath)]]) raw[variant] = await run(variant + '-observe', ['java', '-ea', '-cp', classpath, 'lazymutabledescriptorproof.LazyMutableBehaviorProbe']);
const records = text => text.trimEnd().split('\n').filter(row => row.startsWith('record:'));
assert.deepEqual(records(raw.common), records(raw.original)); assert(records(raw.common).length >= 20);
const boundaries = Object.fromEntries(Object.entries(raw).map(([variant, text]) => [variant, text.trimEnd().split('\n').filter(row => row.startsWith('boundary:'))]));
const artifacts = [];
async function inventory(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, item.name); if (item.isDirectory()) await inventory(filename);
        else { const bytes = await readRegular(filename, 32 * 1024 * 1024); artifacts.push({ path: path.relative(root, filename), bytes: bytes.length, sha256: sha256(bytes) }); }
    }
}
await inventory(root);
for (const pin of filePins) { const bytes = await readRegular(pin.filename, 100 * 1024 * 1024); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'Lazy/mutable runtime input changed'); }
await writeJson(path.join(root, 'receipt.json'), { schemaVersion: 1, kind: 'genuine-descriptor-lazy-mutable-full-jvm-proof', result: 'pass', outputRoot: root,
    commands, filePins, artifacts, observations: records(raw.common).length, comparedRecordsSha256: sha256(Buffer.from(records(raw.common).join('\n'))),
    originalFullJavaClasses: javaSources, fullCommonClasses: lock.common.map(pin => pin.path), directGenuineConsumersRebuilt: [SUSPEND_FUNCTIONS, DESERIALIZED_PARAMETER],
    consumerAssemblyImports, consumerBodyProjectionUsed: false, fullShippingImportAssemblyCheckedBySeparateIntegrityProof: true,
    parentFullSourceJvmProof: { path: evidencePath, sha256: sha256(parentBytes), outputRoot: parent.outputRoot, artifactSha256: parent.artifacts.find(pin => pin.path === 'common.jar').sha256,
        interpretation: 'Previously compiled complete genuine common descriptor families reused with all recorded inputs/artifacts independently rehashed; not recompiled by this proof.' },
    bootstrapDependencies: ['deserialization contexts and metadata', 'OverridingUtil', 'DescriptorUtils', 'builtins', 'storage', 'checker/refiner and graph scopes'],
    commonOverridingUtilClosureOpen: true, commonDescriptorUtilsClosureOpen: true, boundaries, rawJavaNullContractParity: false,
    externalJavaCollectionMutationParity: false, hostSpecificClassDiagnosticParity: false, assertionsEnabled: true,
    fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false,
    bootstrap: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts } });
console.log(JSON.stringify({ result: 'pass', observations: records(raw.common).length, outputRoot: root }));
