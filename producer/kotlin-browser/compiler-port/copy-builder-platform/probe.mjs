import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { prepareCopyBuilderPlatform, verifyCopyBuilderPlatform, verifyFinalCopyBuilderPlatform } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), execute = promisify(execFile);
assert.equal(process.argv.length, 5); const mode = process.argv[2], root = path.resolve(process.argv[3]), previousRoot = path.resolve(process.argv[4]);
assert(root.startsWith(path.join(REPO, 'out') + path.sep));
if (mode === '--prepare') {
    const receipt = JSON.parse(await readRegular(path.join(previousRoot, 'receipt.json')));
    const previousSnapshot = JSON.parse(gunzipSync(await readRegular(path.join(previousRoot, receipt.snapshot.path), receipt.snapshot.bytes)));
    const retainedSources = previousSnapshot.map(item => {
        const replacement = receipt.files.find(pin => pin.path === item.path);
        return replacement ? { path: item.path, filename: path.join(previousRoot, item.path), bytes: replacement.bytes, sha256: replacement.sha256 } :
            { path: item.path, filename: item.filename, bytes: item.bytes, sha256: item.sha256 };
    });
    const preparedSignatures = { outputRoot: previousRoot, receipt, receiptPath: path.join(previousRoot, 'receipt.json'),
        commonSources: receipt.files.map(item => path.join(previousRoot, item.path)) };
    const prepared = await prepareCopyBuilderPlatform({ outputRoot: root, preparedSignatures, retainedSources });
    assert.deepEqual((await verifyCopyBuilderPlatform(root)).receipt, prepared.receipt);
    const actual = retainedSources.map(item => {
        const replacement = prepared.receipt.files.find(pin => pin.path === item.path);
        return replacement ? { path: item.path, filename: path.join(root, item.path), bytes: replacement.bytes, sha256: replacement.sha256 } : item;
    });
    const final = await verifyFinalCopyBuilderPlatform({ profileRoot: root, retainedSources: actual });
    await writeJson(path.join(root, 'proof-preparation.json'), { component: prepared, retainedSources: actual, final: final.receipt });
    console.log(JSON.stringify({ result: 'pass', outputs: 4, selectedSources: actual.length, predecessorBindings: prepared.predecessorBindings }));
} else {
    assert.equal(mode, '--runtime'); await mkdir(root, { mode: 0o700 });
    const verified = await verifyCopyBuilderPlatform(previousRoot), lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const bootstrap = await verifyBootstrap(), flags = JSON.parse(await readRegular(path.join(HERE, '../build-flags.json'))), commands = [], externalInputs = [];
    const frozen = async (filename, expected) => {
        const bytes = await readRegular(filename, expected?.bytes ?? 80 * 1024 * 1024);
        if (expected) { assert.equal(bytes.length, expected.bytes); assert.equal(sha256(bytes), expected.sha256); }
        externalInputs.push({ filename, bytes: bytes.length, sha256: sha256(bytes) }); return bytes;
    };
    const publish = async (logical, bytes) => { const filename = path.join(root, logical); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename; };
    async function run(phase, command, expectedExitCode = 0) {
        console.log('phase: ' + phase); let result, exitCode = 0;
        try { result = await execute(command[0], command.slice(1), { cwd: root, timeout: 300000, maxBuffer: 8 * 1024 * 1024 }); }
        catch (error) { result = error; exitCode = error.code; }
        await publish(phase + '.stdout', Buffer.from(result.stdout ?? '')); await publish(phase + '.stderr', Buffer.from(result.stderr ?? ''));
        commands.push({ phase, command, exitCode, expectedExitCode }); assert.equal(exitCode, expectedExitCode, phase + ': ' + String(result.stderr ?? '').slice(-6000)); return String(result.stdout ?? '');
    }
    const classpath = (...parts) => parts.join(path.delimiter);
    const compilerArtifact = bootstrap.artifacts.find(item => item.id === 'compiler'); assert(compilerArtifact);
    const compiler = ['java', '-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
        '-Xfriend-paths=' + compilerArtifact.path,
        '-jvm-target', '17', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
    const referenceLock = JSON.parse(await frozen(path.join(HERE, '../descriptors/reference.lock.json')));
    assert.equal(referenceLock.kind, 'official-reference-only-artifact'); assert.equal(referenceLock.artifact.version, bootstrap.lock.version);
    const readOnly = referenceLock.artifact; assert.equal(readOnly.file, 'kotlin-annotations-jvm-2.5.0-dev-10106.jar');
    const annotations = path.join(REPO, 'out/kotlin-compiler-descriptors/reference-artifacts', readOnly.file); await frozen(annotations, readOnly);
    const primary = JSON.parse(await readRegular(path.join(HERE, '../closure.lock.json'))), javaSources = [];
    for (const source of lock.runtimeOriginals) {
        assert.deepEqual(source, primary.files.find(item => item.path === source.path));
        const filename = path.join(previousRoot, 'predecessor/reference', source.path); verifyFile(await frozen(filename, source), source); javaSources.push(filename);
    }
    const javaClasses = path.join(root, 'java-classes'); await mkdir(javaClasses);
    await run('original-complete-java-family', ['javac', '-cp', classpath(bootstrap.classPath, annotations), '-d', javaClasses, ...javaSources]);
    const beforeSources = [], afterSources = [];
    for (const source of lock.inputs) beforeSources.push(await publish('before/' + source.path, await frozen(path.join(previousRoot, 'predecessor', source.path), source)));
    for (const source of lock.outputs) afterSources.push(await publish('after/' + source.path, await frozen(path.join(previousRoot, source.path), source)));
    const beforeJar = path.join(root, 'before.jar'), afterJar = path.join(root, 'after.jar'), cp = classpath(javaClasses, bootstrap.classPath, annotations);
    await run('before-complete-four-contracts', [...compiler, '-classpath', cp, '-d', beforeJar, ...beforeSources]);
    await run('after-complete-four-contracts', [...compiler, '-classpath', cp, '-d', afterJar, ...afterSources]);
    const errorPath = 'core/descriptors/src/org/jetbrains/kotlin/types/error/ErrorFunctionDescriptor.kt';
    const signatureReceipt = JSON.parse(await readRegular(path.join(previousRoot, 'predecessor/receipt.json')));
    const errorPin = signatureReceipt.files.find(item => item.path === errorPath); assert(errorPin);
    const errorSource = await publish('source/' + errorPath, await frozen(path.join(previousRoot, 'predecessor', errorPath), errorPin));
    const errorJar = path.join(root, 'error.jar');
    await run('complete-shipping-error-original-java-boundary', [...compiler, '-classpath', cp, '-d', errorJar, errorSource]);
    const observer = await publish('BuilderProbe.kt', await readRegular(path.join(HERE, 'BuilderProbe.kt'))), originalObserver = path.join(root, 'original-observer.jar'), commonObserver = path.join(root, 'common-observer.jar');
    await run('original-typed-receiver-observer', [...compiler, '-classpath', classpath(errorJar, cp), '-d', originalObserver, observer]);
    await run('before-nullable-type-usage-negative', [...compiler, '-classpath', classpath(beforeJar, errorJar, cp), '-d', path.join(root, 'before-observer.jar'), observer], 1);
    await run('after-nullable-nonnull-type-usage', [...compiler, '-classpath', classpath(afterJar, errorJar, cp), '-d', commonObserver, observer]);
    const main = 'org.jetbrains.kotlin.portable.copybuilder.probe.BuilderProbeKt';
    const original = await run('original-receiver-observe', ['java', '-ea', '-cp', classpath(originalObserver, errorJar, cp), main]);
    const common = await run('common-receiver-observe', ['java', '-ea', '-cp', classpath(commonObserver, afterJar, errorJar, cp), main]);
    assert.equal(original, common); assert.equal(original.trimEnd().split('\n').length, 1731);
    // Retain the already sealed complete generated-family graph; only these four metadata files differ.
    const earlierEvidenceBytes = await readRegular(path.join(HERE, '../descriptor-platform-signatures/evidence/differential.json'));
    assert.equal(sha256(earlierEvidenceBytes), lock.runtimePreviousEvidenceSha256); const earlier = JSON.parse(earlierEvidenceBytes);
    const family = earlier.runtime.commands.find(item => item.phase === 'full-generated-family-after-negative-typecheck').command.filter(item => item.endsWith('.kt'));
    const familyBefore = [], familyAfter = [];
    for (const [index, filename] of family.entries()) {
        const actual = earlier.filePins.find(item => item.filename === filename); assert(actual, 'Unsealed family source: ' + filename);
        const bytes = await frozen(filename, actual), before = await publish('family-before/' + index + '-' + path.basename(filename), bytes);
        const replacement = lock.outputs.find(item => item.path.endsWith('/' + path.basename(filename)));
        if (replacement) assert.equal(sha256(bytes), lock.inputs.find(item => item.path === replacement.path).sha256, 'Family predecessor metadata differs');
        familyBefore.push(before); familyAfter.push(await publish('family-after/' + index + '-' + path.basename(filename), replacement ? await frozen(path.join(previousRoot, replacement.path), replacement) : bytes));
    }
    await run('full-generated-family-before-negative', [...compiler, '-classpath', cp, '-d', path.join(root, 'family-before.jar'), ...familyBefore], 1);
    await run('full-generated-family-after-negative', [...compiler, '-classpath', cp, '-d', path.join(root, 'family-after.jar'), ...familyAfter], 1);
    const artifacts = [];
    async function inventory(directory) { for (const item of await readdir(directory, { withFileTypes: true })) { const filename = path.join(directory, item.name); if (item.isDirectory()) await inventory(filename); else { const bytes = await readRegular(filename, 80 * 1024 * 1024); artifacts.push({ path: path.relative(root, filename), bytes: bytes.length, sha256: sha256(bytes) }); } } }
    await inventory(root);
    await writeJson(path.join(root, 'receipt.json'), { schemaVersion: 1, kind: 'selected-copy-builder-real-jvm-evidence', preparationReceiptSha256: verified.receiptSha256,
        probeSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), observerSha256: sha256(await readRegular(path.join(HERE, 'BuilderProbe.kt'))),
        sourceLockSha256: sha256(lockBytes), commands, artifacts, externalInputs, observations: 1731, originalJvmEqualsCommonJvm: true, normalized: false,
        fourCompleteCommonInterfacesCompiled: true, completeShippingErrorCompiledAgainstOriginalJavaFamily: true,
        runtimeBoundary: 'Actual shipping ErrorFunctionDescriptor compiled against complete original Java family; unchanged builder bodies executed against original or four complete common interfaces. Genuine verified bootstrap native Function/Property copy configurations. All-common family remains a retained failing typecheck.',
        bootstrap: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts },
        fullGeneratedFamilyRuntime: false, fullDescriptorWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false });
    console.log(JSON.stringify({ result: 'pass', commands: commands.length, observations: 1731, outputRoot: root }));
}
