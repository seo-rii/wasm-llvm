import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareDiagnosticFactories } from '../diagnostic-factories/prepare.mjs';
import { defaultDiagnosticDslReference, DSL_PATH, prepareDiagnosticDsl } from '../diagnostic-dsl/prepare.mjs';
import { prepareDiagnosticSourceDsl, prepareDiagnosticSourceDslReferences, verifyDiagnosticSourceDsl } from './prepare.mjs';
import { transformDiagnosticContainer } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);

export async function runSourceDslProbe({ outputRoot, frozenBuildRoot,
    sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources') } = {}) {
    outputRoot = path.resolve(outputRoot); frozenBuildRoot = path.resolve(frozenBuildRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    await assertNoSymlink(outputRoot); await mkdir(outputRoot, { mode: 0o700 });
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
    const frozenBytes = await readRegular(path.join(frozenBuildRoot, 'compiler-build-receipt.json'), 32 * 1024 * 1024);
    const frozen = JSON.parse(frozenBytes);
    const actualCommand = frozen.commands.find(item => item.phase === 'official-compiler-source-to-wasmjs-klib');
    assert(actualCommand && Number.isInteger(actualCommand.exitCode), 'The frozen compiler invocation must have exited');
    const argBytes = await readRegular(path.join(frozenBuildRoot, 'compiler-klib.args'), 8 * 1024 * 1024);
    assert.equal(sha256(argBytes), actualCommand.argumentFileSha256);
    const filenames = argBytes.toString().trimEnd().split('\n').map(line => JSON.parse(line)).slice(-frozen.compileSources.length);
    assert(filenames.every(file => path.isAbsolute(file) && file.startsWith(frozenBuildRoot + path.sep) && file.endsWith('.kt')));
    const retainedSources = frozen.compileSources.map((pin, index) => ({ ...pin, filename: filenames[index] }));
    await prepareDiagnosticSourceDslReferences();
    const prepared = await prepareDiagnosticSourceDsl({ sourceRoot, outputRoot, retainedSources });
    const checked = await verifyDiagnosticSourceDsl(path.dirname(prepared.receiptPath));
    const sourceFree = await prepareDiagnosticDsl({ outputRoot });
    const factories = await prepareDiagnosticFactories({ sourceRoot, outputRoot });
    const bootstrap = await verifyBootstrap();
    const support = {};
    for (const pin of lock.probeSupport) support[path.basename(pin.path)] = verifyFile(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), pin);
    const commands = [], outputs = [], projections = [];
    const observer = await readRegular(path.join(here, 'SourceDslProbe.kt'));
    const originalMetadataCheck = '            if (getter != null) check(getter.invoke(factory) == PsiElement::class)\n';
    assert.equal(observer.toString().split(originalMetadataCheck).length, 2);
    // The common observer validates the absence of getPsiType. Only its original
    // variant directly checks the original genuine PSI KClass identity.
    const commonObserver = transformDiagnosticContainer(observer.toString().replace(originalMetadataCheck, ''), 17);
    const variants = {};
    for (const variant of ['original', 'common']) {
        await mkdir(path.join(outputRoot, variant), { mode: 0o700 });
        const entries = {};
        entries['KtDiagnosticFactoryDsl.kt'] = variant === 'original' ? await readRegular(path.join(defaultDiagnosticDslReference, DSL_PATH)) :
            await readRegular(prepared.commonSources.find(file => file.endsWith('/KtDiagnosticFactoryDsl.kt')));
        if (variant === 'common') entries['KtSourcelessDiagnosticFactoryDsl.kt'] = await readRegular(sourceFree.commonSources[0]);
        entries['KtDiagnosticFactory.kt'] = variant === 'original' ? support['KtDiagnosticFactory.kt'] :
            await readRegular(factories.commonSources.find(file => file.endsWith('/KtDiagnosticFactory.kt')));
        for (const name of ['FallbackDiagnostics.kt', 'DummyDelegate.kt', 'KtDiagnosticsContainer.kt', 'KtRegisteredDiagnosticFactoriesStorage.kt', 'KtDiagnosticReportHelpers.kt']) entries[name] = support[name];
        for (const pin of lock.containers) entries[path.basename(pin.path)] = variant === 'original' ?
            verifyFile(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), pin) :
            await readRegular(prepared.commonSources.find(file => file.endsWith('/' + path.basename(pin.path))));
        entries['SourceDslProbe.kt'] = variant === 'original' ? observer : Buffer.from(commonObserver.text);
        variants[variant] = [];
        for (const [name, source] of Object.entries(entries)) {
            const bytes = variant === 'original' ? Buffer.from(source.toString().replaceAll('import com.intellij.psi.PsiElement\n',
                'import org.jetbrains.kotlin.com.intellij.psi.PsiElement\n')) : source;
            const filename = path.join(outputRoot, variant, name); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); variants[variant].push(filename);
            projections.push({ path: variant + '/' + name, originalBytes: source.length, originalSha256: sha256(source),
                bytes: bytes.length, sha256: sha256(bytes), jvmPsiImportBindingChanged: !bytes.equals(source) });
        }
    }
    await mkdir(path.join(outputRoot, 'jvm'), { mode: 0o700 });
    async function run(phase, command, argv) {
        const begin = performance.now();
        try {
            const result = await execute(command, argv, { cwd: outputRoot, timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
            commands.push({ phase, command: [command, ...argv], exitCode: 0, elapsedMs: performance.now() - begin });
            if (result.stderr) process.stderr.write(result.stderr); return result.stdout;
        } catch (error) {
            await writeJson(path.join(outputRoot, 'failure.json'), { phase, exitCode: error.code, stderr: String(error.stderr ?? '').slice(-16384) });
            if (error.stderr) process.stderr.write(String(error.stderr).slice(-16384)); throw new Error(phase + ' failed');
        }
    }
    const flagsBytes = await readRegular(path.join(here, '../build-flags.json')); const flags = JSON.parse(flagsBytes);
    const compiler = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
        '-jvm-target', '17', '-language-version', '2.5', '-api-version', '2.5', ...flags.compilerFlags, '-classpath', bootstrap.classPath];
    const observed = {};
    for (const variant of ['original', 'common']) {
        const jar = path.join(outputRoot, 'jvm', variant + '.jar');
        const commonSources = variants[variant].filter(file => !file.endsWith('/SourceDslProbe.kt'));
        await run(variant + '-actual-sourced-diagnostics-jvm-build', 'java', [...compiler,
            ...(variant === 'common' ? ['-Xmulti-platform', '-Xcommon-sources=' + commonSources.join(',')] : []), '-d', jar, ...variants[variant]]);
        observed[variant] = await run(variant + '-actual-sourced-diagnostics-jvm-observe', 'java', ['-cp', jar + path.delimiter + bootstrap.classPath,
            'org.jetbrains.kotlin.portable.diagnosticsourcedsl.probe.SourceDslProbeKt', variant]);
        for (const [filename, bytes] of [[variant + '-observations.txt', Buffer.from(observed[variant])], ['jvm/' + variant + '.jar', await readRegular(jar)]]) {
            if (!filename.startsWith('jvm/')) await writeFile(path.join(outputRoot, filename), bytes, { flag: 'wx', mode: 0o600 });
            outputs.push({ path: filename, bytes: bytes.length, sha256: sha256(bytes) });
        }
    }
    assert.equal(observed.common, observed.original, 'Sourced diagnostic property/provider behavior changed');
    const receipt = { schemaVersion: 1, kind: 'actual-sourced-diagnostic-dsl-jvm-differential', result: 'pass', source: lock.source,
        sourceLockSha256: sha256(lockBytes), probeToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
        preparation: checked.receipt, preparationReceiptSha256: checked.receiptSha256,
        sourceFreePreparation: sourceFree.receipt, factoryPreparation: factories.receipt,
        frozenBuildReceiptSha256: sha256(frozenBytes), frozenArgumentFileSha256: sha256(argBytes), compilerFlagsSha256: sha256(flagsBytes),
        observer: { path: 'SourceDslProbe.kt', bytes: observer.length, sha256: sha256(observer),
            commonMetadataDeletions: commonObserver.deletions, originalOnlyMetadataCheckSha256: sha256(Buffer.from(originalMetadataCheck)) },
        supportInputs: lock.probeSupport, projections, commands, outputs,
        bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
        comparison: { originalJvmEqualsCommonJvm: true, observations: observed.original.trimEnd().split('\n').length,
            selectedContainers: 6, typedMetadataSites: 31, sourcedDeclarationBindings: 34,
            allTypedHelpers: 17, allProviderArities: 5, deprecationFeaturesSelectActualErrorAndWarningFactories: true },
        limits: ['Complete selected official DSL, common factory bodies, six container files and report helper selection execute on JVM with genuine bootstrap support whose source commit is unknown.',
            'The original observer checks genuine PSI KClass metadata; the common observer checks its actual absence. All successful behavior observations are compared raw.',
            'No fixture compiler types, payload types, PSI implementations or success stubs are supplied.',
            'Actual Wasm sourced-diagnostic/context/positioning and full IR payload type closure remain a separate compiler target gate; no Wasm runtime parity is claimed.'],
        wasmRuntime: 'not-run', browserWorker: 'not-run', fullCompilerAcceptance: false, languageReadiness: false };
    await writeJson(path.join(outputRoot, 'differential.json'), receipt);
    return { output: outputRoot, comparison: receipt.comparison, wasmRuntime: 'not-run' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const options = {}; for (let index = 2; index < process.argv.length; index += 2) {
        assert(['--output', '--frozen-build-root', '--source-root'].includes(process.argv[index]) && process.argv[index + 1] && !options[process.argv[index]]);
        options[process.argv[index]] = path.resolve(process.argv[index + 1]);
    }
    console.log(JSON.stringify(await runSourceDslProbe({ outputRoot: options['--output'], frozenBuildRoot: options['--frozen-build-root'], sourceRoot: options['--source-root'] })));
}
