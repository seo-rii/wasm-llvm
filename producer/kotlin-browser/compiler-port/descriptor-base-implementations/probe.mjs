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
import { prepareDescriptorBaseImplementations, verifyDescriptorBaseImplementations } from './prepare.mjs';
import { descriptorBaseFixture } from './fixture.mjs';
import { VALUE_PARAMETER } from './transform.mjs';
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
const commonContracts = [];
for (const filename of descriptor.sourceFiles) {
    const bytes = await frozen(filename), logical = 'compiler-port-descriptors/generated/' + path.basename(filename);
    const recipes = signatureLock.recipes.filter(row => row.path === logical);
    commonContracts.push(await put('common-contracts/' + path.basename(filename), recipes.length ? applySignatureRecipes(bytes, recipes) : bytes));
}
const original = path.join(root, 'original'), oracle = path.join(root, 'oracle'); await mkdir(original); await mkdir(oracle);
const originalFiles = prepared.receipt.originals.filter(pin => pin.language === 'java').map(pin => path.join(prepared.outputRoot, 'reference', pin.path));
const javaLock = JSON.parse(await frozen(path.join(HERE, '../descriptors/sources.lock.json')));
for (const name of javaLock.javaInterfaces) {
    const filename = path.join(sourceRoot, name), expected = javaLock.files.find(pin => pin.path === name);
    verifyFile(await frozen(filename), expected);
    if (!originalFiles.some(file => file.endsWith('/' + name))) originalFiles.push(filename);
}
await run('full-original-java-family', ['javac', '-cp', runtimeClasspath, '-d', original, ...originalFiles]);
const valuePath = 'core/descriptors/src/org/jetbrains/kotlin/descriptors/impl/ValueParameterDescriptorImpl.kt';
const originalValue = await frozen(path.join(prepared.outputRoot, 'reference', valuePath));
let commonValue = (await frozen(path.join(prepared.outputRoot, VALUE_PARAMETER))).toString();
commonValue = commonValue.replace(/(^package[^\n]*\n)/m, '$1import org.jetbrains.kotlin.portable.descriptors.*\n');
const commonValueFile = await put('common-consumer/ValueParameterDescriptorImpl.kt', Buffer.from(commonValue));
const dynamic = await put('Dynamic.kt', await frozen(path.join(HERE, 'Dynamic.kt')));
const originalJar = path.join(root, 'original-consumer.jar'), commonJar = path.join(root, 'common.jar');
await run('full-original-value-parameter', [...compiler, '-classpath', classpath(original, runtimeClasspath), '-d', originalJar, path.join(prepared.outputRoot, 'reference', valuePath), dynamic]);
const annotationSource = await put('common-annotation/AnnotationImplementations.kt', await frozen(path.join(HERE, '../annotation-implementations/AnnotationImplementations.kt')));
await run('full-common-contracts-bases-value-parameter', [...compiler, '-classpath', runtimeClasspath, '-d', commonJar, ...commonContracts, ...prepared.commonSources.filter(filename => !filename.endsWith('/' + VALUE_PARAMETER)), annotationSource, commonValueFile, dynamic]);
const observer = await put('DescriptorBaseOracle.java', await frozen(path.join(HERE, 'DescriptorBaseOracle.java')));
await run('full-genuine-object-observer', ['javac', '-cp', classpath(originalJar, original, commonJar, runtimeClasspath), '-d', oracle, observer]);
const raw = {};
for (const [variant, cp] of [['original', classpath(oracle, originalJar, original, runtimeClasspath, commonJar)], ['common', classpath(oracle, commonJar, runtimeClasspath)]]) {
    raw[variant] = await run(variant + '-observe', ['java', '-ea', '-cp', cp, 'descriptorbaseproof.DescriptorBaseOracle', variant]);
}
const rows = raw => raw.trimEnd().split('\n'), commonOnly = /^(?:record:(?:nested-host|nested-throw|host-identity-fallback|host-name-failure|host-cleared):)/;
const originalRows = rows(raw.original).filter(row => row.startsWith('record:'));
const commonRows = rows(raw.common).filter(row => row.startsWith('record:') && !commonOnly.test(row));
assert.deepEqual(commonRows, originalRows, 'Actual descriptor storage, forwarding, renderer, assertion or dispatch behavior differs');
assert(originalRows.length >= 25);
const boundaries = Object.fromEntries(['original', 'common'].map(variant => [variant, rows(raw[variant]).filter(row => row.startsWith('boundary:'))]));
assert.equal(boundaries.original.find(row => row.startsWith('boundary:null-before-set:')), 'boundary:null-before-set:null');
assert(boundaries.common.find(row => row.startsWith('boundary:null-before-set:java.lang.NullPointerException:')));
assert(rows(raw.common).includes('record:nested-host:true:true'));
assert(rows(raw.common).some(row => row.startsWith('record:nested-throw:java.lang.IllegalStateException:') && row.endsWith(':true')));
assert(rows(raw.common).some(row => row.startsWith('record:host-name-failure:java.lang.IllegalArgumentException:') && row.endsWith('[class, class]')));
assert(rows(raw.common).some(row => row.startsWith('record:host-identity-fallback:') && row.endsWith('[class, identity, class]')));
assert(rows(raw.common).some(row => row.startsWith('record:host-cleared:java.lang.IllegalStateException:')));
const artifacts = [];
async function inventory(directory) { for (const item of await readdir(directory, { withFileTypes: true })) { const filename = path.join(directory, item.name); if (item.isDirectory()) await inventory(filename); else { const bytes = await readRegular(filename, 32 * 1024 * 1024); artifacts.push({ path: path.relative(root, filename), bytes: bytes.length, sha256: sha256(bytes) }); } } }
await inventory(root);
await writeJson(path.join(root, 'receipt.json'), { schemaVersion: 1, kind: 'genuine-descriptor-base-full-jvm-proof', result: 'pass', outputRoot: root,
    preparation: prepared.receipt, commands, filePins, artifacts, observations: originalRows.length,
    comparedRecordsSha256: sha256(Buffer.from(originalRows.join('\n'))), rawHostLocalIdentityNumbersCompared: false,
    hostIdentityValidatedAgainstActualSystemIdentityHash: true, commonOnlyRecords: rows(raw.common).filter(row => commonOnly.test(row)), boundaries,
    fullOriginalJavaInterfaces: javaLock.javaInterfaces.length, fullGeneratedContracts: commonContracts.length,
    genuineValueParameterSourceRebuilt: true, nullableVisitorRecipePreserved: true,
    bootstrap: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts },
    fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false });
console.log(JSON.stringify({ result: 'pass', observations: originalRows.length, outputRoot: root }));
