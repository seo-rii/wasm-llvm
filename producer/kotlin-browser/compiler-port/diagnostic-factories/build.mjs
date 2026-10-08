#!/usr/bin/env node
/** Execute the full selected factory source with genuine JVM diagnostic support, never fake Wasm models. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile } from '../../scripts/source.mjs';
import { prepareDiagnosticFactories } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);
const options = {}, args = process.argv.slice(2);
while (args.length) {
    const key = args.shift();
    assert(['--output', '--source-root', '--bootstrap-cache'].includes(key) && args[0] && !options[key], 'Invalid diagnostic factories build option');
    options[key] = path.resolve(args.shift());
}
const output = options['--output'] ?? path.join(repository, 'out/kotlin-diagnostic-factories-probe');
assert(output.startsWith(path.join(repository, 'out') + path.sep), 'Diagnostic probe output must stay under repository out/');
await assertNoSymlink(output); await mkdir(output, { recursive: false });
const commands = [];
const receipt = { schemaVersion: 1, kind: 'official-diagnostic-factory-jvm-source-variant-differential', status: 'building', commands,
    generatedTableExecution: 'not-run', diagnosticWasmExecution: 'not-run', resolvedFirExecution: 'not-run', browserCompiler: 'not-built', languageReadiness: false };

async function command(phase, argv, capture = false) {
    const start = performance.now(); let exitCode = null, signal = null, stdout = '', stderr = '';
    try {
        if (capture) {
            const result = await execute(argv[0], argv.slice(1), { timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
            stdout = result.stdout; stderr = result.stderr; exitCode = 0;
        } else {
            exitCode = await new Promise((resolve, reject) => {
                const child = spawn(argv[0], argv.slice(1), { cwd: repository, stdio: ['ignore', 'inherit', 'inherit'] });
                const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
                child.once('error', (error) => { clearTimeout(timer); reject(error); });
                child.once('exit', (code, stopped) => { clearTimeout(timer); signal = stopped; resolve(code); });
            });
        }
        assert.equal(signal, null, phase + ' terminated'); assert.equal(exitCode, 0, phase + ' failed');
        return { stdout, stderr };
    } catch (error) {
        if (exitCode === null && Number.isInteger(error.code)) exitCode = error.code;
        if (error.stderr) process.stderr.write(error.stderr.slice(-8192));
        throw error;
    } finally { commands.push({ phase, argv, exitCode, signal, elapsedMs: performance.now() - start }); }
}

try {
    const bootstrap = await verifyBootstrap(options['--bootstrap-cache'] ?? defaultCache);
    const sourceRoot = options['--source-root'] ?? path.join(repository, 'out/kotlin-compiler-port/sources');
    const prepared = await prepareDiagnosticFactories({ sourceRoot, outputRoot: output });
    const recipeBytes = await readRegular(path.join(here, 'diagnostic-factories.recipe.json'));
    const recipe = JSON.parse(recipeBytes);
    receipt.source = recipe.source; receipt.preparation = prepared.receipt;
    receipt.bootstrap = { version: bootstrap.lock.version, compilerSourceCommit: bootstrap.lock.compilerSourceCommit,
        artifacts: bootstrap.artifacts.map(({ path: ignored, ...item }) => item),
        support: 'Actual bootstrap JVM diagnostic/source/context/renderer/configuration classes; authoritative source revision unknown' };
    const flagsBytes = await readRegular(path.join(here, '../build-flags.json'));
    const flags = JSON.parse(flagsBytes); assert.equal(flags.source.commit, recipe.source.commit);
    receipt.compilerFlags = { path: 'compiler-port/build-flags.json', sha256: sha256(flagsBytes), compilerFlags: flags.compilerFlags };
    receipt.toolSources = [];
    for (const name of ['build.mjs', 'prepare.mjs', 'transform.mjs', 'OriginalFactories.kt', 'CommonFactories.kt', 'DiagnosticFactoryProbe.kt']) {
        const bytes = await readRegular(path.join(here, name));
        receipt.toolSources.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    for (const name of ['original', 'jvm']) await mkdir(path.join(output, name));
    const factoryPin = recipe.originals.find((pin) => pin.path.endsWith('/KtDiagnosticFactory.kt'));
    const fallbackPin = recipe.referenceDependencies.find((pin) => pin.path.endsWith('/FallbackDiagnostics.kt'));
    const referenceFactory = path.join(output, 'original/KtDiagnosticFactory.kt');
    const fallback = path.join(output, 'original/FallbackDiagnostics.kt');
    for (const [destination, pin] of [[referenceFactory, factoryPin], [fallback, fallbackPin]]) {
        const bytes = verifyFile(await readRegular(path.join(sourceRoot, relativePath(pin.path)), pin.bytes), pin);
        await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    }
    receipt.selectedSourceReference = [factoryPin, fallbackPin];
    const version = await command('actual-jvm-version', ['java', '-version'], true);
    receipt.jvmRuntime = { version: (version.stderr || version.stdout).trim() };
    const compiler = ['java', '-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
        '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', '2.5', '-api-version', '2.5', ...flags.compilerFlags,
        '-classpath', bootstrap.classPath];
    const probe = path.join(here, 'DiagnosticFactoryProbe.kt');
    const originalJar = path.join(output, 'jvm/original.jar');
    await command('selected-original-factory-jvm-build', [...compiler, '-d', originalJar, referenceFactory, fallback, probe, path.join(here, 'OriginalFactories.kt')]);
    const commonFactory = prepared.commonSources.find((filename) => filename.endsWith('/KtDiagnosticFactory.kt'));
    const commonJar = path.join(output, 'jvm/browser-variant.jar');
    const common = [commonFactory, fallback];
    await command('browser-source-variant-jvm-build', [...compiler, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','),
        '-d', commonJar, ...common, probe, path.join(here, 'CommonFactories.kt')]);
    const main = 'org.jetbrains.kotlin.portable.diagnosticfactories.probe.DiagnosticFactoryProbeKt';
    const original = JSON.parse((await command('selected-original-factory-jvm-observe', ['java', '-Xmx768m', '-cp', originalJar + path.delimiter + bootstrap.classPath, main], true)).stdout.trim());
    const variant = JSON.parse((await command('browser-source-variant-jvm-observe', ['java', '-Xmx768m', '-cp', commonJar + path.delimiter + bootstrap.classPath, main], true)).stdout.trim());
    assert.deepEqual(variant, original, 'Browser constructor metadata variant changed actual diagnostic behavior');
    for (const [name, value] of [['original-jvm.json', original], ['browser-variant-jvm.json', variant]])
        await writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    receipt.outputs = [];
    for (const name of ['original/KtDiagnosticFactory.kt', 'original/FallbackDiagnostics.kt', 'jvm/original.jar', 'jvm/browser-variant.jar', 'original-jvm.json', 'browser-variant-jvm.json']) {
        const bytes = await readRegular(path.join(output, name)); receipt.outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    receipt.comparison = { originalSelectedFactoryEqualsBrowserVariantJvm: true, observations: original.observations.length,
        diagnosticFactoryArities: original.diagnosticFactoryArities, deprecationArities: original.deprecationArities,
        originalPsiMetadataPresent: true, browserVariantPsiMetadataAbsent: true,
        failed: 0, skipped: 0, required: original.observations.length, notRun: 0 };
    receipt.limitations = ['The original selected KtDiagnosticFactory and FallbackDiagnostics source files execute against genuine JVM bootstrap support classes, whose source revision remains unknown.',
        'The source variant comparison executes factory bodies, typed diagnostics, real renderers/context, severity overrides, deprecation pairs and fallback paths on JVM.',
        'Generated registration tables are source-verified; their full FIR-specific runtime is not executed.',
        'The genuine missing-source sentinel is used; this does not establish precise diagnostics for parsed user source.',
        'Full Wasm diagnostic support is not yet built, including java.text.MessageFormat and the complete source/diagnostic model closure. No replacement compiler models or fake PSI classes are supplied.'];
    receipt.status = 'passed';
} catch (error) {
    receipt.status = 'failed'; receipt.failure = { message: String(error.message).slice(0, 2048), lastPhase: commands.at(-1)?.phase ?? 'preparation' };
    process.exitCode = 1;
} finally {
    await writeFile(path.join(output, 'diagnostic-factories-evidence.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ output, status: receipt.status, comparison: receipt.comparison ?? null, failure: receipt.failure ?? null }));
}
