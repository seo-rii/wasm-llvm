import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareDiagnosticFactories } from '../diagnostic-factories/prepare.mjs';
import { DSL_PATH, prepareDiagnosticDsl, prepareDiagnosticDslReferences, verifyDiagnosticDsl } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);

// This observer-only projection keeps original constructor/property/map/storage
// algorithms. It deliberately omits source/context/formatting methods whose full
// Wasm type graph is unfinished; none of these projections are shipping inputs.
function block(text, anchor) {
    const start = text.indexOf(anchor); assert(start >= 0, 'Missing projected declaration: ' + anchor);
    assert.equal(text.indexOf(anchor, start + anchor.length), -1, 'Ambiguous projected declaration');
    const opening = text.indexOf('{', start); assert(opening >= 0);
    let end = opening + 1, depth = 1;
    while (depth && end < text.length) { if (text[end] === '{') depth++; else if (text[end] === '}') depth--; end++; }
    assert.equal(depth, 0); return { start, end, text: text.slice(start, end) };
}
function header(text, className) {
    const declaration = block(text, className); return declaration.text.slice(0, declaration.text.indexOf('{') + 1);
}
function notice(text) { return text.slice(0, text.indexOf('\npackage ') + 1); }
function remove(text, anchor) { const part = block(text, anchor); return text.slice(0, part.start) + text.slice(part.end); }

export function projectIdentityRuntime(sources) {
    const out = {};
    const factory = sources['KtDiagnosticFactory.kt'];
    const base = remove(block(factory, 'sealed class AbstractKtDiagnosticFactory(').text, '    fun getEffectiveSeverity(');
    const sourceless = remove(block(factory, 'class KtSourcelessDiagnosticFactory(').text, '    fun create(');
    out['KtDiagnosticFactory.kt'] = notice(factory) + 'package org.jetbrains.kotlin.diagnostics\n\n' +
        'import org.jetbrains.kotlin.diagnostics.rendering.BaseDiagnosticRendererFactory\n\n' + base + '\n\n' + sourceless + '\n';
    const renderer = sources['KtDiagnosticRenderer.kt'];
    out['KtDiagnosticRenderer.kt'] = notice(renderer) + 'package org.jetbrains.kotlin.diagnostics\n\n' +
        header(renderer, 'sealed class KtDiagnosticRenderer {') + '\n    abstract val message: String\n}\n\n' +
        header(renderer, 'sealed class AbstractKtDiagnosticWithParametersRenderer(') + '\n}\n\n' +
        header(renderer, 'class KtSourcelessDiagnosticRenderer(') + '\n}\n';
    const map = sources['KtDiagnosticFactoryToRendererMap.kt'];
    const prefix = block(map, 'class KtDiagnosticFactoryToRendererMap ').text;
    out['KtDiagnosticFactoryToRendererMap.kt'] = notice(map) + 'package org.jetbrains.kotlin.diagnostics\n\n' +
        prefix.slice(0, prefix.indexOf('    fun put(factory: KtSourcelessDiagnosticFactory')) +
        block(map, '    fun put(factory: KtSourcelessDiagnosticFactory').text + '\n\n' +
        block(map, '    private fun put(factory: AbstractKtDiagnosticFactory').text + '\n}\n\n' +
        block(map, 'fun KtDiagnosticFactoryToRendererMap(\n').text + '\n';
    const rendering = sources['DiagnosticRendererFactory.kt'];
    out['DiagnosticRendererFactory.kt'] = notice(rendering) + 'package org.jetbrains.kotlin.diagnostics.rendering\n\n' +
        'import org.jetbrains.kotlin.diagnostics.KtDiagnosticFactoryToRendererMap\n\n' +
        header(rendering, 'abstract class BaseDiagnosticRendererFactory : DiagnosticRendererFactory {')
            .replace(' : DiagnosticRendererFactory', '') + '\n    abstract val MAP: KtDiagnosticFactoryToRendererMap\n}\n\n' +
        block(rendering, 'abstract class BaseSourcelessDiagnosticRendererFactory').text + '\n';
    out['Severity.kt'] = remove(sources['Severity.kt'], '    fun toCompilerMessageSeverity()')
        .replace('import org.jetbrains.kotlin.cli.common.messages.CompilerMessageSeverity\n', '');
    for (const name of ['KtDiagnosticsContainer.kt', 'KtRegisteredDiagnosticFactoriesStorage.kt', 'DummyDelegate.kt', 'CliDiagnostics.kt']) out[name] = sources[name];
    return out;
}

export async function runDiagnosticDslProbe({ outputRoot, sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources'),
    additionalSourceRoot = path.join(repository, 'out/kotlin-source-closure-reference/sources') } = {}) {
    outputRoot = path.resolve(outputRoot); assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    await assertNoSymlink(outputRoot); await mkdir(outputRoot, { mode: 0o700 });
    const reference = await prepareDiagnosticDslReferences();
    const prepared = await prepareDiagnosticDsl({ sourceRoot: reference.sourceRoot, outputRoot });
    const verified = await verifyDiagnosticDsl(path.dirname(prepared.receiptPath));
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
    const factoryPreparation = await prepareDiagnosticFactories({ sourceRoot, outputRoot });
    const bootstrap = await verifyBootstrap();
    const support = {}, inputs = [];
    for (const pin of lock.probeSupport) {
        const bytes = verifyFile(await readRegular(path.join(pin.location === 'additional' ? additionalSourceRoot : sourceRoot, pin.path), pin.bytes), pin);
        support[path.basename(pin.path)] = bytes.toString(); inputs.push(pin);
    }
    const commands = [], artifacts = [], observers = [], projections = [];
    const local = {};
    for (const name of ['DslProbe.kt', 'JvmEntry.kt', 'WasmEntry.kt']) {
        const bytes = await readRegular(path.join(here, name)); local[name] = path.join(outputRoot, name);
        await writeFile(local[name], bytes, { flag: 'wx', mode: 0o600 }); observers.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    for (const directory of ['original', 'common', 'projection', 'jvm', 'klib', 'wasm']) await mkdir(path.join(outputRoot, directory), { mode: 0o700 });
    const originalDsl = await readRegular(path.join(reference.sourceRoot, DSL_PATH));
    // Genuine relocated IntelliJ PSI support from the verified bootstrap is used
    // only by original JVM source-bearing declarations, outside this DSL split.
    const originalJvmDsl = Buffer.from(originalDsl.toString().replace('import com.intellij.psi.PsiElement\n',
        'import org.jetbrains.kotlin.com.intellij.psi.PsiElement\n'));
    const variants = {};
    for (const variant of ['original', 'common']) {
        const entries = { 'KtDiagnosticFactoryDsl.kt': variant === 'original' ? originalJvmDsl : await readRegular(prepared.commonSources[0]),
            'KtDiagnosticFactory.kt': variant === 'original' ? Buffer.from(support['KtDiagnosticFactory.kt']) :
                await readRegular(factoryPreparation.commonSources.find(file => file.endsWith('/KtDiagnosticFactory.kt'))) };
        for (const name of ['FallbackDiagnostics.kt', 'DummyDelegate.kt', 'KtDiagnosticsContainer.kt', 'KtRegisteredDiagnosticFactoriesStorage.kt', 'CliDiagnostics.kt'])
            entries[name] = Buffer.from(support[name]);
        variants[variant] = [];
        for (const [name, bytes] of Object.entries(entries)) {
            const target = path.join(outputRoot, variant, name); await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); variants[variant].push(target);
        }
    }
    const commonFactory = await readRegular(factoryPreparation.commonSources.find(file => file.endsWith('/KtDiagnosticFactory.kt')));
    const projected = projectIdentityRuntime({ ...support, 'KtDiagnosticFactory.kt': commonFactory.toString() });
    const commonProjection = [prepared.commonSources[0], local['DslProbe.kt']];
    for (const [name, text] of Object.entries(projected)) {
        const bytes = Buffer.from(text), target = path.join(outputRoot, 'projection', name);
        await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); commonProjection.push(target);
        projections.push({ path: 'projection/' + name, originalInputSha256: sha256(Buffer.from(name === 'KtDiagnosticFactory.kt' ? commonFactory.toString() : support[name])),
            bytes: bytes.length, sha256: sha256(bytes), unchangedWholeFile: text === support[name] });
    }
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
    const stdlib = bootstrap.artifacts.find(pin => pin.id === 'stdlib-jvm').path;
    const jvm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
        '-jvm-target', '17', '-language-version', '2.5', '-api-version', '2.5', ...flags.compilerFlags];
    const observed = {}, runtime = {};
    for (const variant of ['original', 'common']) {
        const jar = path.join(outputRoot, 'jvm', variant + '.jar');
        await run(variant + '-full-jvm-build', 'java', [...jvm, '-classpath', bootstrap.classPath,
            ...(variant === 'common' ? ['-Xmulti-platform', '-Xcommon-sources=' + variants[variant].join(',')] : []),
            '-d', jar, ...variants[variant], local['DslProbe.kt'], local['JvmEntry.kt']]);
        const main = 'org.jetbrains.kotlin.portable.diagnosticdsl.probe.JvmEntryKt';
        observed[variant] = await run(variant + '-full-jvm-observe', 'java', ['-cp', jar + path.delimiter + bootstrap.classPath, main]);
        runtime[variant] = await run(variant + '-full-jvm-runtime-observe', 'java', ['-cp', jar + path.delimiter + bootstrap.classPath, main, 'runtime']);
    }
    assert.equal(observed.common, observed.original, 'Common JVM DSL initialization differs');
    assert.equal(runtime.common, runtime.original, 'Common JVM sourceless diagnostic runtime differs');
    const wasm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js',
        '-language-version', '2.5', '-api-version', '2.5', ...flags.compilerFlags, '-libraries', bootstrap.wasmJsStdlib];
    await run('common-wasm-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + commonProjection.join(','),
        '-Xir-produce-klib-file', '-ir-output-dir', path.join(outputRoot, 'klib'), '-ir-output-name', 'diagnostic-dsl', ...commonProjection, local['WasmEntry.kt']]);
    await run('common-wasm-link', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/diagnostic-dsl.klib'),
        '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'diagnostic-dsl', '-main', 'noCall']);
    observed.wasm = await run('actual-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
        'process.stdout.write((await import(process.argv[1])).diagnosticDslObservation())', pathToFileURL(path.join(outputRoot, 'wasm/diagnostic-dsl.mjs')).href]);
    assert.equal(observed.wasm, observed.original, 'Actual Wasm DSL initialization/registration differs');
    for (const [name, text] of Object.entries({ ...observed, 'original-runtime': runtime.original, 'common-runtime': runtime.common })) {
        const bytes = Buffer.from(text); const filename = name + '-observations.txt';
        await writeFile(path.join(outputRoot, filename), bytes, { flag: 'wx', mode: 0o600 }); artifacts.push({ path: filename, bytes: bytes.length, sha256: sha256(bytes) });
    }
    for (const directory of ['jvm', 'klib', 'wasm']) for (const name of await readdir(path.join(outputRoot, directory))) {
        const bytes = await readRegular(path.join(outputRoot, directory, name), 32 * 1024 * 1024);
        artifacts.push({ path: directory + '/' + name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const receipt = { schemaVersion: 1, kind: 'actual-source-free-diagnostic-dsl-differential', result: 'pass', source: lock.source,
        sourceLockSha256: sha256(lockBytes), probeToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
        preparation: verified.receipt, preparationReceiptSha256: verified.receiptSha256, factoryPreparation: factoryPreparation.receipt,
        bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
        compilerFlagsSha256: sha256(flagsBytes), observerPins: observers, supportInputs: inputs, projections,
        originalJvmPsiImportBinding: { originalSha256: sha256(originalDsl), compiledSha256: sha256(originalJvmDsl),
            change: 'com.intellij.psi.PsiElement -> actual bootstrap relocated org.jetbrains.kotlin.com.intellij.psi.PsiElement; declaration bodies unchanged' },
        comparison: { originalJvmEqualsCommonJvm: true, initializationRegistrationOriginalJvmEqualsNodeWasm: true,
            identityCases: observed.original.trimEnd().split('\n').length, fullJvmRuntimeCases: runtime.original.trimEnd().split('\n').length,
            wasmCreateEffectiveSeverityRendering: 'not-run', originalCommonJvmCreateEffectiveSeverityRendering: 'pass' },
        wasmEngine: { kind: 'Node', version: process.version }, commands, artifacts,
        limits: ['Shipping output consists only of five exact original source-free DSL declarations and their original imports/notice.',
            'Full original/common factory bodies and actual CLI table execute on JVM with genuine bootstrap diagnostic/config/renderer support whose source commit is unknown.',
            'Wasm executes the exact DSL, whole real DummyDelegate/container/storage/CLI and source-projected actual constructor/property/map/duplicate-registration bodies.',
            'Observer-only Wasm projection omits sourced diagnostics, effectiveSeverity/create/context/MessageFormat rendering and renderer invoke. No fixture-owned compiler classes are supplied.',
            'Source-bearing DSL provider metadata and six retained source-bearing declaration reader files remain a separate unfinished gate.'],
        browserWorker: 'not-run', fullCompilerAcceptance: false, languageReadiness: false };
    await writeJson(path.join(outputRoot, 'differential.json'), receipt);
    return { output: outputRoot, result: receipt.result, comparison: receipt.comparison };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const options = {}; for (let i = 2; i < process.argv.length; i += 2) {
        assert(['--output', '--source-root'].includes(process.argv[i])); assert(process.argv[i + 1]); assert(!options[process.argv[i]]);
        options[process.argv[i]] = path.resolve(process.argv[i + 1]);
    }
    console.log(JSON.stringify(await runDiagnosticDslProbe({ outputRoot: options['--output'], sourceRoot: options['--source-root'] })));
}
