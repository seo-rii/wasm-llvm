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
import { prepareDescriptorBaseImplementations, verifyDescriptorBaseImplementations } from '../descriptor-base-implementations/prepare.mjs';
import { descriptorBaseFixture } from '../descriptor-base-implementations/fixture.mjs';
import { VALUE_PARAMETER } from '../descriptor-base-implementations/transform.mjs';
import { applyBuilderRecipes } from '../copy-builder-platform/transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), execute = promisify(execFile);
const root = path.resolve(process.argv[2]); assert(root.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(root, { mode: 0o700 });
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const prepared = await prepareDescriptorBaseImplementations({ sourceRoot, outputRoot: path.join(root, 'prepared'), ...await descriptorBaseFixture() });
assert.deepEqual(await verifyDescriptorBaseImplementations(prepared.outputRoot), prepared.receipt);
const bootstrap = await verifyBootstrap(), commands = [], filePins = [], flags = JSON.parse(await readRegular(path.join(HERE, '../build-flags.json')));
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
const annotationsLock = JSON.parse(await frozen(path.join(HERE, '../descriptors/reference.lock.json')));
const annotations = path.join(REPO, 'out/kotlin-compiler-descriptors/reference-artifacts', annotationsLock.artifact.file);
const annotationBytes = await frozen(annotations);
assert.equal(annotationBytes.length, annotationsLock.artifact.bytes); assert.equal(sha256(annotationBytes), annotationsLock.artifact.sha256);
const runtimeClasspath = bootstrap.classPath + path.delimiter + annotations;
const classpath = (...items) => items.join(path.delimiter), compiler = ['java', '-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-jvm-default=enable', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
const descriptor = await prepareDescriptorContracts(sourceRoot, path.join(root, 'generated-contracts'));
const signatureLock = JSON.parse(await frozen(path.join(HERE, '../descriptor-platform-signatures/sources.lock.json')));
const builderLock = JSON.parse(await frozen(path.join(HERE, '../copy-builder-platform/sources.lock.json')));
const commonContracts = [];
for (const filename of descriptor.sourceFiles) {
    const bytes = await frozen(filename), logical = 'compiler-port-descriptors/generated/' + path.basename(filename);
    const recipes = signatureLock.recipes.filter(row => row.path === logical);
    let output = recipes.length ? applySignatureRecipes(bytes, recipes) : bytes;
    const builders = builderLock.recipes.filter(row => row.path === logical);
    if (builders.length) output = applyBuilderRecipes(output, builders);
    commonContracts.push(await put('common-contracts/' + path.basename(filename), output));
}
const original = path.join(root, 'original'), oracle = path.join(root, 'oracle'); await mkdir(original); await mkdir(oracle);
const originalFiles = prepared.receipt.originals.filter(pin => pin.language === 'java').map(pin => path.join(prepared.outputRoot, 'reference', pin.path));
const javaLock = JSON.parse(await frozen(path.join(HERE, '../descriptors/sources.lock.json')));
for (const name of javaLock.javaInterfaces) {
    const filename = path.join(sourceRoot, name), expected = javaLock.files.find(pin => pin.path === name);
    verifyFile(await frozen(filename), expected);
    if (!originalFiles.some(file => file.endsWith('/' + name))) originalFiles.push(filename);
}
for (const name of ['FunctionDescriptorImpl', 'SimpleFunctionDescriptorImpl']) {
    const logical = 'core/descriptors/src/org/jetbrains/kotlin/descriptors/impl/' + name + '.java';
    const primary = JSON.parse(await frozen(path.join(HERE, '../closure.lock.json')));
    verifyFile(await frozen(path.join(sourceRoot, logical)), primary.files.find(pin => pin.path === logical));
    originalFiles.push(path.join(sourceRoot, logical));
}
await run('full-original-java-family', ['javac', '-cp', runtimeClasspath, '-d', original, ...originalFiles]);
const valuePath = 'core/descriptors/src/org/jetbrains/kotlin/descriptors/impl/ValueParameterDescriptorImpl.kt';
const originalValue = await frozen(path.join(prepared.outputRoot, 'reference', valuePath));
let commonValue = (await frozen(path.join(prepared.outputRoot, VALUE_PARAMETER))).toString();
commonValue = commonValue.replace(/(^package[^\n]*\n)/m, '$1import org.jetbrains.kotlin.portable.descriptors.*\n');
const commonValueFile = await put('common-consumer/ValueParameterDescriptorImpl.kt', Buffer.from(commonValue));
const dynamic = await put('Dynamic.kt', await frozen(path.join(HERE, '../descriptor-base-implementations/Dynamic.kt')));
const functionInvokePath = 'core/descriptors/src/org/jetbrains/kotlin/builtins/functions/FunctionInvokeDescriptor.kt';
const functionInvokeOriginal = await frozen(path.join(sourceRoot, functionInvokePath));
verifyFile(functionInvokeOriginal, JSON.parse(await readRegular(path.join(HERE, '../closure.lock.json'))).files.find(pin => pin.path === functionInvokePath));
const commonInvoke = await put('common-consumer/FunctionInvokeDescriptor.kt', Buffer.from(functionInvokeOriginal.toString().replace(/(^package[^\n]*\n)/m, '$1import org.jetbrains.kotlin.portable.descriptors.*\n')));
const originalJar = path.join(root, 'original-consumer.jar'), commonJar = path.join(root, 'common.jar');
await run('full-original-value-parameter', [...compiler, '-classpath', classpath(original, runtimeClasspath), '-d', originalJar, path.join(prepared.outputRoot, 'reference', valuePath), dynamic, path.join(sourceRoot, functionInvokePath)]);
const ownSources = [];
for (const name of ['FunctionDescriptorImpl.kt', 'SimpleFunctionDescriptorImpl.kt', 'FunctionDescriptorProperties.kt', 'FlagConsumer.kt']) ownSources.push(await put('common-functions/' + name, await frozen(path.join(HERE, name))));
const annotationSource = await put('common-annotation/AnnotationImplementations.kt', await frozen(path.join(HERE, '../annotation-implementations/AnnotationImplementations.kt')));
await run('full-common-contracts-bases-value-parameter', [...compiler, '-classpath', runtimeClasspath, '-d', commonJar, ...commonContracts, ...prepared.commonSources.filter(filename => !filename.endsWith('/' + VALUE_PARAMETER)), annotationSource, commonValueFile, commonInvoke, dynamic, ...ownSources]);

const observer = await put('FunctionOracle.java', await frozen(path.join(HERE, 'FunctionOracle.java')));
await run('full-genuine-function-observer', ['javac', '-cp', classpath(originalJar, original, commonJar, runtimeClasspath), '-d', oracle, observer]);
const raw = {};
for (const [variant, cp] of [['original', classpath(oracle, originalJar, original, runtimeClasspath, commonJar)], ['common', classpath(oracle, commonJar, runtimeClasspath)]]) {
    raw[variant] = await run(variant + '-observe', ['java', '-ea', '-cp', cp, 'descriptorfunctionproof.FunctionOracle', variant]);
}
const records = text => text.trimEnd().split('\n').filter(row => row.startsWith('record:'));
assert.deepEqual(records(raw.common), records(raw.original));
assert.equal(records(raw.common).length, 32);
const boundaries = Object.fromEntries(Object.entries(raw).map(([variant, text]) => [variant, text.trimEnd().split('\n').filter(row => row.startsWith('boundary:'))]));
assert.deepEqual(boundaries.original, ['boundary:initialized-null-modality-builder:true', 'boundary:initialized-null-modality-copy:true'].concat(['getContextReceiverParameters','getModality','getValueParameters','getReturnType'].map(name => 'boundary:' + name + ':null')));
assert.deepEqual(boundaries.common, ['boundary:initialized-null-modality-builder:java.lang.NullPointerException', 'boundary:initialized-null-modality-copy:java.lang.NullPointerException'].concat(['getContextReceiverParameters','getModality','getValueParameters'].map(name => 'boundary:' + name + ':java.lang.NullPointerException'), 'boundary:getReturnType:null'));
const artifacts = [];
async function inventory(directory) { for (const item of await readdir(directory, { withFileTypes: true })) { const filename = path.join(directory, item.name); if (item.isDirectory()) await inventory(filename); else { const bytes = await readRegular(filename, 32 * 1024 * 1024); artifacts.push({ path: path.relative(root, filename), bytes: bytes.length, sha256: sha256(bytes) }); } } }
await inventory(root);
await writeJson(path.join(root, 'receipt.json'), { schemaVersion:1, kind:'genuine-descriptor-function-full-jvm-proof', result:'pass', outputRoot:root,
  commands, filePins, artifacts, observations:records(raw.common).length, comparedRecordsSha256:sha256(Buffer.from(records(raw.common).join('\n'))), boundaries,
  originalFullJavaClasses:['FunctionDescriptorImpl','SimpleFunctionDescriptorImpl'], fullOriginalJavaInterfaces:javaLock.javaInterfaces.length, fullGeneratedContracts:commonContracts.length,
  genuineValueParameterSourceRebuilt:true, genuineFunctionInvokeWholeSourceRebuilt:true, bootstrapDependencies:['DescriptorSubstitutor','DescriptorFactory','ReceiverParameterDescriptorImpl','SmartList','type-system and builtins'],
  initializedNullReturnTypeBuilderSetPreserved:true, initializedNullModalityBuilderCopyParity:false, nullModalityFailureStage:'virtual getModality() before setModality can replace the null', crossThreadVolatileParity:false, innerFieldBinaryVisibilityParity:false, rawJavaNullContractParity:false, fullCommonClassesWasmExecuted:false, fullCompilerBuilt:false, languageReadiness:false,
  bootstrap: { version:bootstrap.lock.version, artifacts:bootstrap.artifacts } });
console.log(JSON.stringify({result:'pass', observations:records(raw.common).length, outputRoot:root}));
