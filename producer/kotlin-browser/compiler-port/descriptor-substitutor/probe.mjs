import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { prepareDescriptorContracts } from '../descriptors/prepare.mjs';
import { applySignatureRecipes } from '../descriptor-platform-signatures/transform.mjs';
import { applyBuilderRecipes } from '../copy-builder-platform/transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), execute = promisify(execFile);
const root = path.resolve(process.argv[2]); assert(root.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(root, { mode: 0o700 });
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources'), bootstrap = await verifyBootstrap(), commands = [], filePins = [];
async function frozen(filename) { const bytes = await readRegular(filename, 100 * 1024 * 1024); filePins.push({ filename, bytes: bytes.length, sha256: sha256(bytes) }); return bytes; }
async function put(name, bytes) { const filename = path.join(root, name); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename; }
async function run(phase, command) {
    console.log('phase: ' + phase); const start = performance.now(); let result, exitCode = 0;
    try { result = await execute(command[0], command.slice(1), { cwd: root, timeout: 300000, maxBuffer: 8 * 1024 * 1024 }); }
    catch (error) { result = error; exitCode = error.code; }
    await put(phase + '.stdout', Buffer.from(result.stdout ?? '')); await put(phase + '.stderr', Buffer.from(result.stderr ?? ''));
    commands.push({ phase, command, exitCode, elapsedMs: performance.now() - start });
    await writeFile(path.join(root, 'commands.json'), JSON.stringify(commands, null, 2) + '\n', { mode: 0o600 });
    assert.equal(exitCode, 0, phase + ': ' + String(result.stderr ?? '').slice(-7000)); return String(result.stdout ?? '');
}
const flags = JSON.parse(await frozen(path.join(HERE, '../build-flags.json'))), lock = JSON.parse(await frozen(path.join(HERE, 'sources.lock.json')));
for (const name of ['probe.mjs', 'DescriptorSubstitutionOracle.java']) await frozen(path.join(HERE, name));
for (const pin of lock.dependencies) verifyFile(await frozen(path.join(HERE, pin.path)), pin);
const annotationsLock = JSON.parse(await frozen(path.join(HERE, '../descriptors/reference.lock.json')));
const annotations = path.join(REPO, 'out/kotlin-compiler-descriptors/reference-artifacts', annotationsLock.artifact.file);
const annotationBytes = await frozen(annotations);
assert.equal(annotationBytes.length, annotationsLock.artifact.bytes); assert.equal(sha256(annotationBytes), annotationsLock.artifact.sha256);
const runtimeClasspath = bootstrap.classPath + path.delimiter + annotations, classpath = (...items) => items.join(path.delimiter);
const compiler = ['java', '-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-jvm-default=enable', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
const descriptor = await prepareDescriptorContracts(sourceRoot, path.join(root, 'generated-contracts'));
const signatureLock = JSON.parse(await frozen(path.join(HERE, '../descriptor-platform-signatures/sources.lock.json'))), builderLock = JSON.parse(await frozen(path.join(HERE, '../copy-builder-platform/sources.lock.json')));
const commonContracts = [];
for (const filename of descriptor.sourceFiles) {
    const bytes = await frozen(filename), logical = 'compiler-port-descriptors/generated/' + path.basename(filename);
    const recipes = signatureLock.recipes.filter(row => row.path === logical), builders = builderLock.recipes.filter(row => row.path === logical);
    let output = recipes.length ? applySignatureRecipes(bytes, recipes) : bytes;
    if (builders.length) output = applyBuilderRecipes(output, builders);
    commonContracts.push(await put('common-contracts/' + path.basename(filename), output));
}
const original = path.join(root, 'original'), oracle = path.join(root, 'oracle'); await mkdir(original); await mkdir(oracle);
const originalFiles = [];
for (const logical of lock.implementations) {
    const filename = path.join(sourceRoot, logical), pin = lock.originals.find(pin => pin.path === logical);
    verifyFile(await frozen(filename), pin); originalFiles.push(filename);
}
await run('full-original-java-family', ['javac', '-cp', runtimeClasspath, '-d', original, ...originalFiles]);
const commonSources = [];
for (const pin of lock.common) commonSources.push(await put('common-family/' + pin.path, verifyFile(await frozen(path.join(HERE, pin.path)), pin)));
for (const name of ['descriptor-base-implementations/DescriptorBaseImplementations.kt', 'descriptor-base-implementations/DescriptorDebugHost.kt',
    'annotation-implementations/AnnotationImplementations.kt', 'type-implementation/TypeSubstitutor.kt', 'type-implementation/TypeProjectionImpl.kt',
    'type-implementation/TypeProjectionBase.kt', 'type-implementation/TypeImplementationProperties.kt', 'assertions/CompilerAssertions.kt',
    'storage/exceptionUtils.kt', 'storage/ProcessCanceledException.kt']) commonSources.push(await put('common-dependencies/' + name, await frozen(path.join(HERE, '..', name))));
const commonJar = path.join(root, 'common.jar');
await run('full-common-contracts-and-family', [...compiler, '-classpath', runtimeClasspath, '-d', commonJar, ...commonContracts, ...commonSources]);
const observer = await put('DescriptorSubstitutionOracle.java', await frozen(path.join(HERE, 'DescriptorSubstitutionOracle.java')));
await run('genuine-observer', ['javac', '-cp', classpath(original, commonJar, runtimeClasspath), '-d', oracle, observer]);
const raw = {};
for (const [variant, cp] of [['original', classpath(oracle, original, runtimeClasspath, commonJar)], ['common', classpath(oracle, commonJar, runtimeClasspath)]])
    raw[variant] = await run(variant + '-observe', ['java', '-ea', '-cp', cp, 'descriptorsubstitutionproof.DescriptorSubstitutionOracle']);
const records = text => text.trimEnd().split('\n').filter(row => row.startsWith('record:'));
assert.deepEqual(records(raw.common), records(raw.original)); assert(records(raw.common).length >= 12);
const artifacts = [];
async function inventory(directory) { for (const item of await readdir(directory, { withFileTypes: true })) { const filename = path.join(directory, item.name); if (item.isDirectory()) await inventory(filename); else { const bytes = await readRegular(filename, 64 * 1024 * 1024); artifacts.push({ path: path.relative(root, filename), bytes: bytes.length, sha256: sha256(bytes) }); } } }
await inventory(root);
await writeJson(path.join(root, 'receipt.json'), { schemaVersion: 1, kind: 'genuine-descriptor-substitution-jvm-proof', result: 'pass', outputRoot: root, commands, filePins, artifacts,
    observations: records(raw.common).length, comparedRecordsSha256: sha256(Buffer.from(records(raw.common).join('\n'))), originalFullJavaClasses: lock.implementations,
    fullCommonClassesCompiled: lock.common.map(pin => pin.path), fullGeneratedContracts: commonContracts.length,
    fullCommonTypeSubstitutorRebuilt: true, genuineBootstrapDependencies: ['KotlinBuiltIns', 'TypeConstructorSubstitution', 'AbstractTypeConstructor', 'DescriptorEquivalenceForOverrides', 'member scopes', 'storage', 'type utilities'],
    javaPlatformNullAndCollectionMutationParity: false, crossThreadLazyPublicationParity: false, fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false,
    bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null, artifacts: bootstrap.artifacts } });
console.log(JSON.stringify({ result: 'pass', observations: records(raw.common).length, root }));
