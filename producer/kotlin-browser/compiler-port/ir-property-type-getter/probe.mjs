import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { prepareIrPropertyTypeGetter, verifyIrPropertyTypeGetter, verifyFinalIrPropertyTypeGetter } from './prepare.mjs';
import { IR, algorithm } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), execute = promisify(execFile);
assert.equal(process.argv.length, 5); const mode = process.argv[2], root = path.resolve(process.argv[3]), previousRoot = path.resolve(process.argv[4]);
assert(root.startsWith(path.join(REPO, 'out') + path.sep));
if (mode === '--prepare') {
    const receipt = JSON.parse(await readRegular(path.join(previousRoot, 'receipt.json')));
    const snapshot = JSON.parse(gunzipSync(await readRegular(path.join(previousRoot, receipt.snapshot.path), receipt.snapshot.bytes)));
    const retainedSources = snapshot.map(item => { const replacement = receipt.files.find(pin => pin.path === item.path);
        return replacement ? { path: item.path, filename: path.join(previousRoot, item.path), bytes: replacement.bytes, sha256: replacement.sha256 } :
            { path: item.path, filename: item.filename, bytes: item.bytes, sha256: item.sha256 }; });
    const preparedCopyBuilder = { outputRoot: previousRoot, receipt, receiptPath: path.join(previousRoot, 'receipt.json'),
        commonSources: receipt.files.map(item => path.join(previousRoot, item.path)) };
    const prepared = await prepareIrPropertyTypeGetter({ outputRoot: root, preparedCopyBuilder, retainedSources });
    assert.deepEqual((await verifyIrPropertyTypeGetter(root)).receipt, prepared.receipt);
    const actual = retainedSources.map(item => item.path === IR ? { path: IR, filename: path.join(root, IR), ...prepared.receipt.files[0] } : item);
    const final = await verifyFinalIrPropertyTypeGetter({ profileRoot: root, retainedSources: actual });
    await writeJson(path.join(root, 'proof-preparation.json'), { component: prepared, retainedSources: actual, final: final.receipt });
    console.log(JSON.stringify({ result: 'pass', outputs: 1, selectedSources: actual.length, predecessorBindings: prepared.predecessorBindings }));
} else {
    assert.equal(mode, '--runtime'); await mkdir(root, { mode: 0o700 });
    const verified = await verifyIrPropertyTypeGetter(previousRoot), lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const bootstrap = await verifyBootstrap(), flags = JSON.parse(await readRegular(path.join(HERE, '../build-flags.json'))), commands = [], externalInputs = [];
    async function frozen(filename, expected) { const bytes = await readRegular(filename, expected?.bytes ?? 80 * 1024 * 1024);
        if (expected) { assert.equal(bytes.length, expected.bytes); assert.equal(sha256(bytes), expected.sha256); }
        externalInputs.push({ filename, bytes: bytes.length, sha256: sha256(bytes) }); return bytes; }
    async function publish(logical, bytes) { const filename = path.join(root, logical); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename; }
    async function run(phase, command, expectedExitCode = 0) {
        console.log('phase: ' + phase); let result, exitCode = 0;
        try { result = await execute(command[0], command.slice(1), { cwd: root, timeout: 300000, maxBuffer: 8 * 1024 * 1024 }); }
        catch (error) { result = error; exitCode = error.code; }
        await publish(phase + '.stdout', Buffer.from(result.stdout ?? '')); await publish(phase + '.stderr', Buffer.from(result.stderr ?? ''));
        commands.push({ phase, command, exitCode, expectedExitCode }); assert.equal(exitCode, expectedExitCode, phase + ': ' + String(result.stderr ?? '').slice(-6000)); return String(result.stdout ?? '');
    }
    const classpath = (...parts) => parts.join(path.delimiter), compilerArtifact = bootstrap.artifacts.find(item => item.id === 'compiler'); assert(compilerArtifact);
    const compiler = ['java', '-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
        '-Xfriend-paths=' + compilerArtifact.path, '-jvm-default=enable', '-jvm-target', '17', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
    const referenceLock = JSON.parse(await frozen(path.join(HERE, '../descriptors/reference.lock.json'))); assert.equal(referenceLock.kind, 'official-reference-only-artifact');
    assert.equal(referenceLock.artifact.version, bootstrap.lock.version);
    const annotations = path.join(REPO, 'out/kotlin-compiler-descriptors/reference-artifacts', referenceLock.artifact.file); await frozen(annotations, referenceLock.artifact);
    const builderLock = JSON.parse(await frozen(path.join(HERE, '../copy-builder-platform/sources.lock.json'))), primary = JSON.parse(await frozen(path.join(HERE, '../closure.lock.json'))), javaSources = [];
    for (const source of builderLock.runtimeOriginals) { assert.deepEqual(source, primary.files.find(item => item.path === source.path));
        const filename = path.join(previousRoot, 'copy-builder/predecessor/reference', source.path); verifyFile(await frozen(filename, source), source); javaSources.push(filename); }
    const javaClasses = path.join(root, 'java-classes'); await mkdir(javaClasses);
    await run('original-complete-java-family', ['javac', '-cp', classpath(bootstrap.classPath, annotations), '-d', javaClasses, ...javaSources]);
    const cp = classpath(javaClasses, bootstrap.classPath, annotations);
    const earlierBytes = await frozen(path.join(HERE, '../copy-builder-platform/evidence/differential.json'));
    assert.equal(sha256(earlierBytes), lock.runtimeCopyBuilderEvidenceSha256); const earlier = JSON.parse(earlierBytes);
    const family = earlier.runtime.commands.find(item => item.phase === 'full-generated-family-after-negative').command.filter(item => item.endsWith('.kt'));
    const aliasBytes = await frozen(path.join(previousRoot, 'alias/DescriptorProperties.kt'), lock.alias);
    const aliasPackage = aliasBytes.toString().match(/^package ([\w.]+)\r?$/m)?.[1]; assert(aliasPackage);
    const aliasImport = aliasPackage + '.*', assemblyPins = [];
    function assembleAlias(bytes) {
        const canonical = bytes.toString(); assert(!canonical.includes('import ' + aliasImport + '\n'));
        const assembled = Buffer.from(canonical.replace(/(^package[^\n]*\n)/m, '$1import ' + aliasImport + '\n\n'));
        assert.equal(algorithm(assembled), algorithm(bytes));
        const imports = text => [...text.matchAll(/^import ([^\r\n]+)\r?$/gm)].map(item => item[1]);
        assert.deepEqual(imports(assembled.toString()), [aliasImport, ...imports(canonical)]);
        assemblyPins.push({ canonicalBytes: bytes.length, canonicalSha256: sha256(bytes), assembledBytes: assembled.length, assembledSha256: sha256(assembled) });
        return assembled;
    }
    const beforeSources = [], afterSources = [], skippedProbeGroups = [];
    for (const [index, filename] of family.entries()) {
        const name = path.basename(filename).replace(/^\d+-/, '');
        if (['IrBuiltinFunctionDescriptor.kt', 'TypeAliasConstructorDescriptor.kt', 'ErrorFunctionDescriptor.kt'].includes(name)) { skippedProbeGroups.push(name); continue; }
        const expected = earlier.filePins.find(item => item.filename === filename); assert(expected, 'Unsealed earlier family source');
        const previousBytes = await frozen(filename, expected);
        let beforeBytes = previousBytes, afterBytes = previousBytes;
        if (name === 'IrBasedDescriptors.kt') {
            const canonicalBefore = await frozen(path.join(previousRoot, 'copy-builder/predecessor', IR), lock.input);
            const canonicalAfter = await frozen(path.join(previousRoot, IR), lock.output);
            assert.equal(algorithm(previousBytes), algorithm(canonicalBefore), 'Earlier probe changed an actual IR body');
            beforeBytes = assembleAlias(canonicalBefore); afterBytes = assembleAlias(canonicalAfter);
        }
        beforeSources.push(await publish('before/' + index + '/' + name, beforeBytes));
        afterSources.push(await publish('after/' + index + '/' + name, afterBytes));
    }
    assert.equal(beforeSources.length, 36); assert.equal(skippedProbeGroups.length, 3);
    const beforeJar = path.join(root, 'before.jar'), afterJar = path.join(root, 'after.jar'), originalJar = path.join(root, 'original.jar');
    await run('before-complete-ir-common-negative', [...compiler, '-classpath', cp, '-d', beforeJar, ...beforeSources], 1);
    const beforeErrors = (await readRegular(path.join(root, 'before-complete-ir-common-negative.stderr'))).toString();
    assert.equal([...beforeErrors.matchAll(/: error:/g)].length, 1); assert(beforeErrors.includes('IrBasedDescriptors.kt') && beforeErrors.includes('KotlinType?'));
    await run('after-complete-ir-common', [...compiler, '-classpath', cp, '-d', afterJar, ...afterSources]);
    const originalSources = [];
    for (const logical of [IR, 'core/descriptors/src/org/jetbrains/kotlin/descriptors/ClassConstructorDescriptor.kt']) {
        const original = lock.originals.find(item => item.path === logical); originalSources.push(await publish('original/' + logical, await frozen(path.join(previousRoot, 'reference', logical), original))); }
    await run('original-complete-ir', [...compiler, '-classpath', cp, '-d', originalJar, ...originalSources]);
    const observer = await publish('IrPropertyProbe.kt', await frozen(path.join(HERE, 'IrPropertyProbe.kt'))), originalObserver = path.join(root, 'original-observer.jar'), commonObserver = path.join(root, 'common-observer.jar');
    await run('original-real-ir-observer', [...compiler, '-classpath', classpath(originalJar, cp), '-d', originalObserver, observer]);
    await run('common-real-ir-observer', [...compiler, '-classpath', classpath(afterJar, cp), '-d', commonObserver, observer]);
    const main = 'org.jetbrains.kotlin.portable.irgetter.probe.IrPropertyProbeKt';
    const original = await run('original-real-ir-observe', ['java', '-ea', '-cp', classpath(originalObserver, originalJar, cp), main]);
    const common = await run('common-real-ir-observe', ['java', '-ea', '-cp', classpath(commonObserver, afterJar, cp), main]);
    assert.equal(common, original); const records = original.trimEnd().split('\n'); assert.equal(records.length, 448);
    let negatives = 0;
    for (const row of records) { const [key, result] = row.split('\t'), [kind, index, mask] = key.split(':');
        assert(Number(index) >= 0 && Number(index) <= 15 && Number(mask) >= 0 && Number(mask) <= 3);
        if (['return', 'type'].includes(kind) && mask === '0') { assert.equal(result, 'NullPointerException:null'); negatives++; }
        else assert.equal(result, kind === 'virtual' ? 'true:1' : kind === 'virtual-live' ? 'true:2' : 'true'); }
    assert.equal(negatives, 32);
    const artifacts = [];
    async function inventory(directory) { for (const item of await readdir(directory, { withFileTypes: true })) { const filename = path.join(directory, item.name); if (item.isDirectory()) await inventory(filename); else { const bytes = await readRegular(filename, 80 * 1024 * 1024); artifacts.push({ path: path.relative(root, filename), bytes: bytes.length, sha256: sha256(bytes) }); } } }
    await inventory(root);
    await writeJson(path.join(root, 'receipt.json'), { schemaVersion: 1, kind: 'ir-property-own-getter-real-jvm-evidence', preparationReceiptSha256: verified.receiptSha256,
        probeSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), observerSha256: sha256(await readRegular(path.join(HERE, 'IrPropertyProbe.kt'))), sourceLockSha256: sha256(lockBytes),
        commands, artifacts, externalInputs, observations: 448, negativeObservations: negatives, originalJvmEqualsCommonJvm: true, normalized: false,
        completeOriginalIrSourceCompiled: true, completeCommonIrSourceCompiled: true, completeGeneratedMetadataContracts: 29,
        probeOnlySkippedUnrelatedKotlinGroups: skippedProbeGroups,
        propertyAliasAssembly: { dependency: verified.receipt.predecessor.alias, aliasPackage, addedImport: aliasImport, assemblyPins, onlyKnownImportAdded: true, allIrAlgorithmBytesUnchanged: true },
        runtimeBoundary: 'Complete original/shared IR source with real IR Module/File/Class/Property/Getter/Field and real KotlinType payloads. 29 complete common generated contracts plus genuine five support files/ClassConstructor. Unchanged implementations not rebuilt here come from verified bootstrap, whose source commit is unknown. Observer subclass overrides only genuine open property getReturnType to count real virtual dispatch.',
        bootstrap: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts },
        fullGeneratedFamilyRuntime: false, fullDescriptorWasm: false, fullCompilerBuilt: false, languageReadiness: false });
    console.log(JSON.stringify({ result: 'pass', commands: commands.length, observations: 448, negativeObservations: negatives, outputRoot: root }));
}
