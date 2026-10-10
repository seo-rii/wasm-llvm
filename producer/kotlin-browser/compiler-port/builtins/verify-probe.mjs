/** Original selected Java versus complete common Kotlin, using genuine compiler helper classes. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildBuiltInsProbe } from './build-probe.mjs';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const execute = promisify(execFile);
export async function verifyBuiltInsProbe({ sourceRoot, outputRoot, bootstrapCache = defaultCache }) {
    const built = await buildBuiltInsProbe({ sourceRoot, outputRoot, bootstrapCache });
    outputRoot = built.outputRoot; const bootstrap = await verifyBootstrap(bootstrapCache);
    const compiler = bootstrap.artifacts.find(item => item.id === 'compiler').path;
    const stdlib = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path;
    const annotations = bootstrap.artifacts.find(item => item.id === 'annotations').path;
    const classPath = [compiler, stdlib, annotations].join(path.delimiter); const commands = [];
    async function run(command, args, maximum = 8 * 1024 * 1024) {
        const result = await execute(command, args, { cwd: outputRoot, timeout: 180000, maxBuffer: maximum });
        commands.push({ command, args, exitCode: 0 }); return result.stdout;
    }
    const originalPath = built.prepared.receipt.sourceFiles.find(item => item.path === 'core/descriptors/src/org/jetbrains/kotlin/builtins/KotlinBuiltIns.java');
    const original = await readRegular(path.join(path.resolve(sourceRoot), originalPath.path));
    assert.equal(sha256(original), originalPath.sha256);
    const originalFile = path.join(outputRoot, 'original-source/KotlinBuiltIns.java');
    await mkdir(path.dirname(originalFile), { recursive: true, mode: 0o700 }); await writeFile(originalFile, original, { flag: 'wx', mode: 0o600 });
    const originalClasses = path.join(outputRoot, 'original-classes'); await mkdir(originalClasses, { mode: 0o700 });
    await run('javac', ['-J-Xmx512m', '-proc:none', '-source', '17', '-target', '17', '-classpath', classPath, '-d', originalClasses, originalFile]);
    const referenceBytes = await readRegular(path.join(HERE, 'Reference.java')); const referenceFile = path.join(outputRoot, 'Reference.java');
    await writeFile(referenceFile, referenceBytes, { flag: 'wx', mode: 0o600 });
    await run('javac', ['-J-Xmx256m', '-proc:none', '-d', outputRoot, referenceFile]);
    const portableJar = path.join(outputRoot, 'builtins.jar');
    const originalApi = await run('java', ['-ea', '-Xmx768m', '-cp', [outputRoot, originalClasses, compiler, stdlib].join(path.delimiter), 'Reference']);
    const portableApi = await run('java', ['-ea', '-Xmx768m', '-cp', [outputRoot, portableJar, compiler, stdlib].join(path.delimiter), 'Reference']);
    const lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
    const extraGetters = [...lock.getterAliases.map(item => item.property + 'Property'), 'builtInsModuleProperty',
        'setBuiltInsModuleProperty', 'builtInPackagesImportedByDefaultProperty', 'builtInsPackageScopeProperty', 'storageManagerProperty',
        'additionalClassPartsProviderProperty', 'platformDependentDeclarationFilterProperty', 'classDescriptorFactoriesProperty'];
    const portableLines = portableApi.trim().split('\n');
    const addedAliases = portableLines.filter(line => extraGetters.some(name => line.includes(':' + name + ':')));
    assert.equal(addedAliases.length, 71, 'All seventy synthetic getters and one setter must be present exactly once');
    const companionField = 'field:public static final:Companion:org.jetbrains.kotlin.builtins.KotlinBuiltIns$Companion';
    assert.equal(portableLines.filter(line => line === companionField).length, 1);
    const normalizedApi = portableLines.filter(line => line !== companionField && !addedAliases.includes(line))
        .map(line => line.replace('method:public static final:', 'method:public static:')).sort().join('\n') + '\n';
    assert.equal(normalizedApi, originalApi, 'Original erased descriptor APIs, method visibility or virtual dispatch changed');
    await writeFile(path.join(outputRoot, 'original-api.txt'), originalApi, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(outputRoot, 'portable-api.txt'), portableApi, { flag: 'wx', mode: 0o600 });
    const flagBytes = await readRegular(path.resolve(HERE, '../build-flags.json')); const flags = JSON.parse(flagBytes);
    const jvm = ['-ea', '-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
        '-jvm-target', '17', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
    const probeBytes = await readRegular(path.join(HERE, 'AlgorithmProbe.kt')); const probeFile = path.join(outputRoot, 'AlgorithmProbe.kt');
    await writeFile(probeFile, probeBytes, { flag: 'wx', mode: 0o600 }); const probeJar = path.join(outputRoot, 'probe.jar');
    await run('java', [...jvm, '-classpath', [originalClasses, classPath].join(path.delimiter), '-d', probeJar, probeFile]);
    const main = 'org.jetbrains.kotlin.portable.builtins.probe.AlgorithmProbeKt';
    const originalObservations = await run('java', ['-ea', '-Xmx768m', '-cp', [probeJar, originalClasses, classPath].join(path.delimiter), main]);
    await writeFile(path.join(outputRoot, 'original-observations.txt'), originalObservations, { flag: 'wx', mode: 0o600 });
    const portableObservations = await run('java', ['-ea', '-Xmx768m', '-cp', [probeJar, portableJar, classPath].join(path.delimiter), main]);
    await writeFile(path.join(outputRoot, 'portable-observations.txt'), portableObservations, { flag: 'wx', mode: 0o600 });
    assert.equal(portableObservations, originalObservations, 'Actual builtins initialization, resolution or type predicate results differ');
    const cases = originalObservations.trim().split('\n').map(line => line.split('\t')[0]);
    assert(cases.length >= 5000 && new Set(cases).size === cases.length && cases.includes('postponed-replacement') && cases.includes('actual-metadata-fallback'), 'Incomplete builtins corpus');
    const getterBytes = await readRegular(path.join(HERE, 'TypedGetterProbe.kt')); const getterFile = path.join(outputRoot, 'TypedGetterProbe.kt');
    await writeFile(getterFile, getterBytes, { flag: 'wx', mode: 0o600 }); const getterJar = path.join(outputRoot, 'typed-getter-probe.jar');
    await run('java', [...jvm, '-classpath', [portableJar, classPath].join(path.delimiter), '-d', getterJar, getterFile]);
    const getterResult = await run('java', ['-ea', '-Xmx768m', '-cp', [getterJar, portableJar, classPath].join(path.delimiter), 'org.jetbrains.kotlin.portable.builtins.probe.TypedGetterProbeKt']);
    assert.equal(getterResult, 'actual builtins typed getter and explicit factory: pass\n');
    const unsignedMissing = originalObservations.trim().split('\n').filter(line => line.startsWith('unsigned-resource-') && line.includes("Can't find built-in class kotlin."));
    const observations = { required: cases.length, passed: cases.length, failed: 0, skipped: 0, notRun: 0,
        originalSha256: sha256(Buffer.from(originalObservations)), portableSha256: sha256(Buffer.from(portableObservations)), cases };
    const receipt = { schemaVersion: 1, kind: 'official-kotlin-builtins-original-common-differential', source: built.receipt.source, result: 'pass',
        sourceLockSha256: sha256(await readRegular(path.join(HERE, 'sources.lock.json'))), prepared: built.prepared.receipt,
        buildReceiptSha256: sha256(await readRegular(path.join(outputRoot, 'build-receipt.json'))), buildFlagsSha256: sha256(flagBytes),
        verificationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), referenceToolSha256: sha256(referenceBytes),
        probeSourceSha256: sha256(probeBytes), typedGetterProbeSha256: sha256(getterBytes), bootstrap: built.receipt.bootstrap,
        api: { originalSha256: sha256(Buffer.from(originalApi)), portableSha256: sha256(Buffer.from(portableApi)),
            comparison: 'all original public/protected erased JVM APIs and virtual instance modifiers match',
            documentedKotlinAdditions: [...addedAliases, companionField],
            documentedStaticModifierDifference: 'Kotlin @JvmStatic bridges are final; Java subclass static method hiding is outside this common compiler API' },
        observations, unavailableReferenceCases: {
            required: unsignedMissing.length * 2, passed: 0, failed: 0, skipped: 0, notRun: unsignedMissing.length * 2,
            cases: unsignedMissing.flatMap(line => [line.split('\t')[0] + '-positive-type', line.split('\t')[0] + '-positive-nullable-type']),
            reason: 'Genuine bootstrap DefaultBuiltIns .kotlin_builtins resource provider lacks these unsigned stdlib classes; no descriptors are invented to fill the gap. Positive lookup requires real KLIB descriptor/type closure.',
        }, typedGetterResult: getterResult.trim(), commands,
        normalization: 'only nondeterministic JVM descriptor identity hex in exception messages; no result, type or diagnostic predicates normalized',
        helperDependencies: built.receipt.helperDependencies,
        wasmBuild: 'not-run: concrete descriptor/type closure required', browserCompilerBuilt: false, readiness: false };
    await writeJson(path.join(outputRoot, 'differential-receipt.json'), receipt); return { outputRoot, receipt };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2); const options = {};
    for (let i = 0; i < args.length; i += 2) {
        if (!['--source-root', '--output-root'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Invalid builtins verification option');
        options[args[i]] = args[i + 1];
    }
    const result = await verifyBuiltInsProbe({ sourceRoot: options['--source-root'], outputRoot: options['--output-root'] });
    console.log(JSON.stringify({ outputRoot: result.outputRoot, result: result.receipt.result, cases: result.receipt.observations.required, readiness: false }));
}
