import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareIdentitySources } from '../identity/prepare.mjs';
import { prepareTypeContracts, verifyTypePreparation } from '../type-contracts/prepare.mjs';
import { prepareClassifierConstructorGetter, verifyClassifierConstructorGetter } from './prepare.mjs';
import { CONSTRUCTOR_PATH, CONTRACT_PATH, projectClassifierConstructor } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..'), execute = promisify(execFile);
const outputRoot = path.resolve(process.argv[2]); assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
await mkdir(outputRoot, { mode: 0o700 });
const sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources');
const preparedIdentity = await prepareIdentitySources({ sourceRoot, outputRoot: path.join(outputRoot, 'identity') });
const prepared = await prepareClassifierConstructorGetter({ sourceRoot, outputRoot: path.join(outputRoot, 'prepared'), preparedIdentity });
const verified = await verifyClassifierConstructorGetter(prepared.outputRoot);
const typeContracts = await prepareTypeContracts(sourceRoot, path.join(outputRoot, 'contracts'));
const verifiedContracts = await verifyTypePreparation(typeContracts.outputRoot);
const bootstrap = await verifyBootstrap(), flagsBytes = await readRegular(path.join(here, '../build-flags.json')), flags = JSON.parse(flagsBytes);
const commonContract = typeContracts.sourceFiles.find(file => file.endsWith('/TypeConstructor.kt'));
const commonAliases = typeContracts.sourceFiles.find(file => file.endsWith('/TypeProperties.kt')); assert(commonContract && commonAliases);
const aliases = await readRegular(commonAliases), contractBytes = await readRegular(commonContract);
assert(aliases.toString().includes('val org.jetbrains.kotlin.types.TypeConstructor.declarationDescriptor: org.jetbrains.kotlin.descriptors.ClassifierDescriptor? get() = getDeclarationDescriptor()'));
assert(contractBytes.toString().includes('fun getDeclarationDescriptor(): org.jetbrains.kotlin.descriptors.ClassifierDescriptor?'));
const lock = JSON.parse(await readRegular(path.join(here, 'sources.lock.json')));
const original = verifyFile(await readRegular(path.join(sourceRoot, CONSTRUCTOR_PATH)), lock.sources[0]);
const predecessor = await readRegular(path.join(preparedIdentity.outputRoot, CONSTRUCTOR_PATH)), common = await readRegular(prepared.commonSources[0]);
const compiler = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17',
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
const wasm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js',
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, '-libraries', bootstrap.wasmJsStdlib, ...flags.compilerFlags];
const commands = [];
async function run(phase, command, args, expectedFailure = false) {
    const start = performance.now();
    try {
        const result = await execute(command, args, { cwd: outputRoot, timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
        assert(!expectedFailure, 'Before-fix class unexpectedly compiled against the nullable common alias');
        commands.push({ phase, command: [command, ...args], exitCode: 0, elapsedMs: performance.now() - start });
        if (result.stderr) process.stderr.write(result.stderr); return result.stdout;
    } catch (error) {
        const stderr = String(error.stderr ?? '');
        commands.push({ phase, command: [command, ...args], exitCode: error.code ?? null, elapsedMs: performance.now() - start,
            expectedFailure, stderrSha256: sha256(Buffer.from(stderr)) });
        if (expectedFailure) {
            assert.equal(error.code, 1); const diagnostics = stderr.split('\n').filter(line => /error:/.test(line));
            assert.equal(diagnostics.length, 3, 'Expected exactly the three recorded own covariance errors');
            assert(diagnostics.every(line => /argument type mismatch: actual type is 'ClassifierDescriptor\?'/.test(line)));
            assert(stderr.includes('hasMeaningfulFqName(descriptor)') && stderr.includes('DescriptorUtils.getFqName(descriptor)')
                && stderr.includes('hasMeaningfulFqName(myDescriptor)'));
            await writeFile(path.join(outputRoot, 'before-fix-diagnostics.txt'), stderr, { flag: 'wx', mode: 0o600 });
            return stderr;
        }
        await writeJson(path.join(outputRoot, 'failure.json'), { phase, commands, stderr: stderr.slice(-16384) });
        if (stderr) process.stderr.write(stderr.slice(-16384)); throw new Error(phase + ' failed');
    }
}
const addAliasImport = bytes => Buffer.from(bytes.toString().replace(/^package[^\r\n]+\r?\n/m, '$&import org.jetbrains.kotlin.portable.descriptors.*\n'));
const before = path.join(outputRoot, 'BeforeClassifierBasedTypeConstructor.kt'), fixed = path.join(outputRoot, 'FixedClassifierBasedTypeConstructor.kt');
await writeFile(before, addAliasImport(predecessor), { flag: 'wx', mode: 0o600 }); await writeFile(fixed, addAliasImport(common), { flag: 'wx', mode: 0o600 });
await run('before-fix-full-class-actual-common-contract-typecheck', 'java', [...compiler, '-classpath', bootstrap.classPath,
    '-d', path.join(outputRoot, 'before.jar'), commonContract, commonAliases, before], true);
const actual = {}, actualArtifacts = [];
for (const variant of ['original', 'common']) {
    const jar = path.join(outputRoot, variant + '-actual.jar');
    const files = [variant === 'original' ? path.join(sourceRoot, CONSTRUCTOR_PATH) : fixed, path.join(here, 'JvmProbe.kt')];
    if (variant === 'common') files.push(commonContract, commonAliases);
    await run(variant + '-full-class-genuine-descriptors-jvm-build', 'java', [...compiler, '-classpath', bootstrap.classPath, '-d', jar, ...files]);
    actual[variant] = await run(variant + '-full-class-genuine-descriptors-jvm-observe', 'java', ['-ea', '-Xmx768m', '-cp', jar + path.delimiter + bootstrap.classPath,
        'org.jetbrains.kotlin.portable.classifiergetter.actual.JvmProbeKt']);
    await writeFile(path.join(outputRoot, variant + '-actual-observations.txt'), actual[variant], { flag: 'wx', mode: 0o600 });
    actualArtifacts.push(variant + '-actual.jar', variant + '-actual-observations.txt');
}
assert.equal(actual.common, actual.original, 'Full class on actual descriptor implementations changed');
const template = await readRegular(path.join(here, 'ProjectionProbe.kt.in')), projections = [], observed = {}, projectedArtifacts = [];
for (const variant of ['original', 'common']) {
    const root = path.join(outputRoot, variant); await mkdir(root, { mode: 0o700 });
    const projection = projectClassifierConstructor(variant === 'original' ? original : common);
    const boundary = path.join(root, 'ConstructorBoundary.kt'), observer = path.join(root, 'ProjectionProbe.kt');
    await writeFile(boundary, projection.bytes, { flag: 'wx', mode: 0o600 });
    let observerBytes = template;
    const sourceFiles = [boundary, observer, path.join(here, 'JvmEntry.kt')]; let classPath = bootstrap.classPath;
    if (variant === 'original') {
        const old = 'interface ConstructorPayload {\n    fun getDeclarationDescriptor(): ClassifierPayload?\n    fun getParameters(): List<Int>\n}\nval ConstructorPayload.declarationDescriptor: ClassifierPayload? get() = getDeclarationDescriptor()\nval ConstructorPayload.parameters: List<Int> get() = getParameters()\n';
        assert.equal(template.toString().split(old).length, 2); observerBytes = Buffer.from(template.toString().replace(old, ''));
        const originalContract = verifyFile(await readRegular(path.join(sourceRoot, CONTRACT_PATH)), lock.sources[1]).toString();
        assert(originalContract.includes('    @Nullable\n    ClassifierDescriptor getDeclarationDescriptor();'));
        assert(originalContract.includes('    @NotNull\n    @ReadOnly\n    List<TypeParameterDescriptor> getParameters();'));
        const javaPayload = Buffer.from('// Probe-only receiver contract projected from pinned TypeConstructor.java.\n' +
            'package org.jetbrains.kotlin.portable.classifiergetter.probe;\n' +
            'public interface ConstructorPayload {\n    @org.jetbrains.annotations.Nullable ClassifierPayload getDeclarationDescriptor();\n' +
            '    @org.jetbrains.annotations.NotNull java.util.List<Integer> getParameters();\n}\n');
        const javaFilename = path.join(root, 'ConstructorPayload.java'); await writeFile(javaFilename, javaPayload, { flag: 'wx', mode: 0o600 }); sourceFiles.push(javaFilename);
        projections.push({ variant, originalContractPath: CONTRACT_PATH, originalContractSha256: lock.sources[1].sha256,
            projectedJavaReceiverBytes: javaPayload.length, projectedJavaReceiverSha256: sha256(javaPayload),
            scope: 'Actual nullable Java getter and nonnull parameters method declarations; explicit payload return/generic types only' });
    }
    await writeFile(observer, observerBytes, { flag: 'wx', mode: 0o600 });
    const jar = path.join(root, 'probe.jar');
    await run(variant + '-exact-class-body-projection-jvm-build', 'java', [...compiler, '-classpath', classPath, '-d', jar, ...sourceFiles]);
    if (variant === 'original') {
        const classes = path.join(root, 'java-classes'); await mkdir(classes, { mode: 0o700 });
        await run('original-projected-java-receiver-javac', 'javac', ['-cp', jar + path.delimiter + classPath, '-d', classes, path.join(root, 'ConstructorPayload.java')]);
        classPath = classes + path.delimiter + classPath;
    }
    observed[variant] = await run(variant + '-exact-class-body-projection-jvm-observe', 'java', ['-ea', '-Xmx768m', '-cp', jar + path.delimiter + classPath,
        'org.jetbrains.kotlin.portable.classifiergetter.probe.JvmEntryKt']);
    await writeFile(path.join(outputRoot, variant + '-projection-observations.txt'), observed[variant], { flag: 'wx', mode: 0o600 });
    projectedArtifacts.push(variant + '/probe.jar', variant + '-projection-observations.txt');
    projections.push({ variant, ...projection, bytes: projection.bytes.length, sha256: sha256(projection.bytes), observerBytes: observerBytes.length,
        observerSha256: sha256(observerBytes) });
}
assert.equal(observed.common, observed.original, 'Projected full class body changed on JVM');
for (const name of ['klib', 'wasm']) await mkdir(path.join(outputRoot, name), { mode: 0o700 });
await run('common-exact-class-body-projection-wasmjs-klib-build', 'java', [...wasm, '-Xir-produce-klib-file', '-ir-output-dir', path.join(outputRoot, 'klib'),
    '-ir-output-name', 'classifier-getter', path.join(outputRoot, 'common/ConstructorBoundary.kt'), path.join(outputRoot, 'common/ProjectionProbe.kt'), path.join(here, 'WasmEntry.kt')]);
await run('common-exact-class-body-projection-wasmjs-binary-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/classifier-getter.klib'),
    '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'classifier-getter', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
observed.wasm = await run('common-exact-class-body-projection-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const m=await import(process.argv[1]);process.stdout.write(m.classifierGetterProbe());', pathToFileURL(path.join(outputRoot, 'wasm/classifier-getter.mjs')).href]);
await writeFile(path.join(outputRoot, 'wasm-projection-observations.txt'), observed.wasm, { flag: 'wx', mode: 0o600 });
assert.equal(observed.wasm, observed.original, 'Projected full class body changed on Wasm');
const ids = observed.original.trimEnd().split('\n').map(line => line.split('\t')[0]); assert.equal(new Set(ids).size, ids.length);
assert(observed.original.includes('zero-recomputed\ttrue\n') && observed.original.includes('cache-getters-zero\t32\n'));
const artifacts = [];
for (const relative of ['before-fix-diagnostics.txt', ...actualArtifacts, ...projectedArtifacts, 'wasm-projection-observations.txt', 'klib/classifier-getter.klib',
    ...(await readdir(path.join(outputRoot, 'wasm'))).sort().map(name => 'wasm/' + name)]) {
    const bytes = await readRegular(path.join(outputRoot, relative)); artifacts.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
}
const receipt = { schemaVersion: 1, kind: 'official-classifier-constructor-getter-bounded-differential', result: 'pass', source: lock.source,
    preparationReceiptSha256: verified.receiptSha256, preparation: prepared.receipt,
    actualCommonContract: { receiptSha256: verifiedContracts.receiptSha256, receipt: typeContracts.receipt,
        typeConstructor: { bytes: contractBytes.length, sha256: sha256(contractBytes) }, typeProperties: { bytes: aliases.length, sha256: sha256(aliases) } },
    beforeFix: { exitCode: 1, exactTypeErrors: 3, realCommonNullableContract: true },
    genuineFullClassJvm: { observations: actual.original.trimEnd().split('\n').length, originalSha256: sha256(Buffer.from(actual.original)),
        commonSha256: sha256(Buffer.from(actual.common)), helperObjects: 'Genuine bootstrap ClassTypeConstructorImpl, ClassDescriptorImpl, Module/Package/Function descriptors and DefaultBuiltIns' },
    projectedBody: { observations: ids.length, originalJvmSha256: sha256(Buffer.from(observed.original)), commonJvmSha256: sha256(Buffer.from(observed.common)),
        nodeWasmSha256: sha256(Buffer.from(observed.wasm)), fixtureReceiverGraph: true, fullClassifierGraph: false },
    rawOutputNormalization: false, projections, commands, artifacts, flagsSha256: sha256(flagsBytes),
    observerPins: await Promise.all(['JvmProbe.kt', 'ProjectionProbe.kt.in', 'JvmEntry.kt', 'WasmEntry.kt', 'probe.mjs'].map(async filename => {
        const bytes = await readRegular(path.join(here, filename)); return { path: filename, bytes: bytes.length, sha256: sha256(bytes) };
    })), bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    fullClassifierWasmRuntime: 'not-run', fullCompilerBuilt: false, publicLanguageSupport: false };
await writeJson(path.join(outputRoot, 'differential.json'), receipt);
console.log(JSON.stringify({ outputRoot, result: receipt.result, actualJvm: receipt.genuineFullClassJvm.observations, projected: ids.length }));
