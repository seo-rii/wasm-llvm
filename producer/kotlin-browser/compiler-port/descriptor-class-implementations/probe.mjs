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
    if (['VariableDescriptor.kt','PropertyDescriptor.kt'].includes(path.basename(filename))) {
        const canonical = await frozen(path.join(HERE, '../descriptor-property-constructors/contracts/Canonical' + path.basename(filename))); assert(output.equals(canonical));
        output = await frozen(path.join(HERE, '../descriptor-property-constructors/contracts', path.basename(filename)));
    }
    commonContracts.push(await put('common-contracts/' + path.basename(filename), output));
}
const receiverLock = JSON.parse(await frozen(path.join(HERE, '../descriptor-receiver-factory/sources.lock.json')));
for (const name of ['probe.mjs']) await frozen(path.join(HERE, name));
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
const ownLock = JSON.parse(await frozen(path.join(HERE, 'sources.lock.json')));
const propertyLock = JSON.parse(await frozen(path.join(HERE, '../descriptor-property-constructors/sources.lock.json')));
for (const logical of propertyLock.implementations) { verifyFile(await frozen(path.join(sourceRoot, logical)), propertyLock.originals.find(pin => pin.path === logical)); originalFiles.push(path.join(sourceRoot, logical)); }
for (const logical of ownLock.implementations) { verifyFile(await frozen(path.join(sourceRoot, logical)), ownLock.originals.find(pin => pin.path === logical)); originalFiles.push(path.join(sourceRoot, logical)); }
for (const logical of receiverLock.implementations) { verifyFile(await frozen(path.join(sourceRoot, logical)), receiverLock.originals.find(pin => pin.path === logical)); originalFiles.push(path.join(sourceRoot, logical)); }
const receiversDirectory = 'core/descriptors/src/org/jetbrains/kotlin/resolve/scopes/receivers/';
for (const name of ['Receiver.java', 'ReceiverValue.java']) { const logical = receiversDirectory + name; const primary = JSON.parse(await frozen(path.join(HERE, '../closure.lock.json'))); verifyFile(await frozen(path.join(sourceRoot, logical)), primary.files.find(pin => pin.path === logical)); originalFiles.push(path.join(sourceRoot, logical)); }
const typeUtilsLogical = 'core/descriptors/src/org/jetbrains/kotlin/types/TypeUtils.java';
const primaryForTypeUtils = JSON.parse(await frozen(path.join(HERE, '../closure.lock.json')));
verifyFile(await frozen(path.join(sourceRoot, typeUtilsLogical)), primaryForTypeUtils.files.find(pin => pin.path === typeUtilsLogical)); originalFiles.push(path.join(sourceRoot,typeUtilsLogical));
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
for (const name of ['FunctionDescriptorImpl.kt', 'SimpleFunctionDescriptorImpl.kt', 'FunctionDescriptorProperties.kt']) ownSources.push(await put('common-functions/' + name, await frozen(path.join(HERE, '../descriptor-function-implementations', name))));
for (const pin of receiverLock.common) ownSources.push(await put('common-receivers/' + pin.path, verifyFile(await frozen(path.join(HERE, '../descriptor-receiver-factory', pin.path)), pin)));
const typeRoot = path.join(REPO, 'out/kotlin-compiler-port/builds/function-syntax-whole-1791708437574091361/components/typeContractReceipt/compiler-port-type-contracts');
const typeReceipt = JSON.parse(await frozen(path.join(typeRoot, 'receipt.json')));
const { normalizeImports } = await import('../descriptor-base-implementations/prepare.mjs');
const { receiverFactoryFixture } = await import('../descriptor-receiver-factory/fixture.mjs');
const fixture = await receiverFactoryFixture();
const receiverContracts = [];
for (const name of ['Receiver.kt', 'ReceiverValue.kt', 'TypeProperties.kt', 'TypeConstructor.kt']) {
 const pin = ownLock.bindings.find(binding => binding.name === 'preparedTypeContracts').files.find(pin => pin.localPath === 'contracts/Canonical' + name);
 const bytes = verifyFile(await frozen(path.join(HERE, pin.localPath)), pin);
 receiverContracts.push(await put('common-receiver-contracts/' + name, bytes));
}
const genuineKotlinDependencies = [...new Set([...receiverLock.consumers, 'core/descriptors/src/org/jetbrains/kotlin/resolve/StdlibClassFinder.kt', ...ownLock.consumers, 'core/descriptors/src/org/jetbrains/kotlin/types/error/ErrorType.kt'])];
const originalDependencies = [], commonDependencies = [];
const primaryLock = JSON.parse(await frozen(path.join(HERE, '../closure.lock.json')));
for (const logical of genuineKotlinDependencies) {
 const bytes = verifyFile(await frozen(path.join(sourceRoot, logical)), primaryLock.files.find(pin => pin.path === logical)); originalDependencies.push(path.join(sourceRoot, logical));
 const commonBytes = ownLock.contracts.some(contract => contract.path === logical) ? await frozen(path.join(HERE,'contracts',path.basename(logical))) : bytes;
 commonDependencies.push(await put('common-consumer/' + path.basename(logical), Buffer.from(commonBytes.toString().replace(/(^package[^\n]*\n)/m, '$1import org.jetbrains.kotlin.portable.descriptors.*\n'))));
}
await run('full-original-kotlin-receiver-consumers', [...compiler, '-classpath', classpath(originalJar, original, runtimeClasspath), '-d', path.join(root,'original-receivers.jar'), ...originalDependencies]);
for (const pin of propertyLock.common) ownSources.push(await put('common-property-constructors/' + pin.path, verifyFile(await frozen(path.join(HERE, '../descriptor-property-constructors', pin.path)), pin)));
for (const pin of ownLock.common) ownSources.push(await put('common-classes/' + pin.path, verifyFile(await frozen(path.join(HERE, pin.path)), pin)));
ownSources.push(await put('common-type-utilities/TypeUtils.kt', await frozen(path.join(HERE,'../type-utilities/TypeUtils.kt'))));
for (const name of ['DescriptorSubstitutor.kt','AbstractTypeParameterDescriptor.kt','TypeParameterDescriptorImpl.kt','TypeParameterProperties.kt']) {
 const bytes = await frozen(path.join(HERE, '../descriptor-substitutor', name));
 ownSources.push(await put('common-substitution/' + name, Buffer.from(bytes.toString().replace(/(^package[^\n]*\n)/m, '$1import org.jetbrains.kotlin.portable.descriptors.*\n'))));
}
for (const name of ['TypeSubstitutor.kt','TypeProjectionImpl.kt','TypeProjectionBase.kt','TypeImplementationProperties.kt']) ownSources.push(await put('common-types/' + name, await frozen(path.join(HERE, '../type-implementation', name))));
ownSources.push(await put('common-host/TypeSubstitutorProperties.kt', await frozen(path.join(HERE, '../type-substitutor-getter/TypeSubstitutorProperties.kt'))));
const constructorContractLogical = 'core/descriptors/src/org/jetbrains/kotlin/descriptors/ClassConstructorDescriptor.kt';
const constructorOriginal = verifyFile(await frozen(path.join(sourceRoot, constructorContractLogical)), primaryLock.files.find(pin => pin.path === constructorContractLogical));
commonDependencies.push(await put('common-consumer/ClassConstructorDescriptor.kt', applySignatureRecipes(constructorOriginal, signatureLock.recipes.filter(row => row.path === constructorContractLogical))));
for (const name of ['assertions/CompilerAssertions.kt','storage/exceptionUtils.kt','storage/ProcessCanceledException.kt']) ownSources.push(await put('common-host/' + name, await frozen(path.join(HERE, '..', name))));
const field = 'core/descriptors/src/org/jetbrains/kotlin/descriptors/impl/FieldDescriptorImpl.kt';
commonDependencies.push(await put('common-consumer/FieldDescriptorImpl.kt', await frozen(path.join(sourceRoot, field))));
const annotationSource = await put('common-annotation/AnnotationImplementations.kt', await frozen(path.join(HERE, '../annotation-implementations/AnnotationImplementations.kt')));
await run('full-common-contracts-bases-value-parameter', [...compiler, '-classpath', runtimeClasspath, '-d', commonJar, ...commonContracts, ...prepared.commonSources.filter(filename => !filename.endsWith('/' + VALUE_PARAMETER)), annotationSource, commonValueFile, commonInvoke, dynamic, ...ownSources, ...receiverContracts, ...commonDependencies]);


const observer = await put('ClassBehaviorProbe.java', await frozen(path.join(HERE, 'proof/ClassBehaviorProbe.java')));
await run('full-genuine-receiver-factory-observer', ['javac', '-cp', classpath(path.join(root, 'original-receivers.jar'), originalJar, original, runtimeClasspath, commonJar), '-d', oracle, observer]);
const raw = {};
for (const [variant, cp] of [['original', classpath(oracle, path.join(root, 'original-receivers.jar'), originalJar, original, runtimeClasspath, commonJar)], ['common', classpath(oracle, commonJar, runtimeClasspath)]]) raw[variant] = await run(variant + '-observe', ['java', '-ea', '-cp', cp, 'descriptorclassproof.ClassBehaviorProbe']);
const records = text => text.trimEnd().split('\n').filter(row => row.startsWith('record:'));
assert.deepEqual(records(raw.common), records(raw.original)); assert.equal(records(raw.common).length, 33);
const boundaries = Object.fromEntries(Object.entries(raw).map(([variant, text]) => [variant, text.trimEnd().split('\n').filter(row => row.startsWith('boundary:'))]));
// Cold raw Java state violates annotated non-null getters and is retained as an explicit measured boundary.
const artifacts = [];
async function inventory(directory) { for (const item of await readdir(directory, { withFileTypes: true })) { const filename = path.join(directory, item.name); if (item.isDirectory()) await inventory(filename); else { const bytes = await readRegular(filename, 32 * 1024 * 1024); artifacts.push({ path: path.relative(root, filename), bytes: bytes.length, sha256: sha256(bytes) }); } } }
await inventory(root);
for (const pin of filePins) { const bytes = await readRegular(pin.filename, 100 * 1024 * 1024); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'Runtime proof input changed during execution'); }
await writeJson(path.join(root, 'receipt.json'), { schemaVersion: 1, kind: 'genuine-descriptor-class-full-jvm-proof', result: 'pass', outputRoot: root,
 commands, filePins, artifacts, observations: records(raw.common).length, comparedRecordsSha256: sha256(Buffer.from(records(raw.common).join('\n'))),
 originalFullJavaClasses: ownLock.implementations, fullCommonClasses: ownLock.common.map(pin => pin.path), genuineContextReceiverConsumersRebuilt: true,
 bootstrapDependencies: ['OverridingUtil','DescriptorUtils','builtins','storage','constant values','type checker/refiner and graph scopes','AbstractTypeAliasDescriptor'], commonOverridingUtilClosureOpen: true, commonDescriptorUtilsClosureOpen: true, genuineSevenClassConsumersRebuilt: ownLock.consumers, completeModuleAwareListBridgeRebuilt: true, defaultTypeRefinementBranches: ['null cached descriptor','ModuleAware class protected scope','genuine type alias expansion','type parameter fallback'], writableConstructorReturnTypeConsumerRebuilt: true, rebuiltGenuineFamilies: ['descriptor bases','functions','receivers and DescriptorFactory','property and constructor descriptors','DescriptorSubstitutor and type parameters','TypeSubstitutor','TypeUtils'], nullableSubstituteContracts: ['VariableDescriptor','PropertyDescriptor'], boundaries, rawConstructorReturnBeforeInitializationParity: false,
 rawJavaNullContractParity: false, assertionsEnabled: true, fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false,
 bootstrap: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts } });
console.log(JSON.stringify({ result: 'pass', observations: records(raw.common).length, outputRoot: root }));
