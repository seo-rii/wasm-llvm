#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { defaultReferenceCache, prepareDiagnosticRendering } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);

function kotlinString(value) {
    return JSON.stringify(value).replace(/\$/g, '\\$').replace(/\\f/g, '\\u000c');
}

/** Only literal expressions are evaluated here; interpolated/identifier expressions remain unexecuted. */
export function literalDiagnosticCases(inventory) {
    const selected = [], deferred = [];
    for (const [index, record] of inventory.records.entries()) {
        if (record.mode !== 'parameterized-MessageFormat') continue;
        let expression = record.patternExpression;
        for (const literal of record.literalParts) expression = expression.replace(literal.source, '');
        if (!record.literalParts.length || record.literalParts.some(part => part.value === null || part.interpolation) || !/^[\s+]*$/.test(expression)) {
            deferred.push({ index, table: record.table, diagnostic: record.diagnostic });
            continue;
        }
        const pattern = record.literalParts.map(part => part.value).join('');
        for (const count of [0, 1, 1000]) {
            const args = record.parameterTypes.map((_, argument) => record.rawParameters.some(raw => raw.index === argument)
                ? String(count) : kotlinString(`renderer${argument}: 한글 {0} 'quoted'`));
            selected.push(`FormatCase(${kotlinString(`official:${index}:${record.table}:${record.diagnostic}:${count}`)}, ${kotlinString(pattern)}, arrayOf<Any?>(${args.join(', ')}))`);
        }
    }
    const chunks = [];
    for (let index = 0; index < selected.length; index += 30) chunks.push(selected.slice(index, index + 30));
    const source = 'package org.jetbrains.kotlin.portable.diagnostics.probe\nfun officialLiteralCases(): List<FormatCase> = buildList {\n' +
        chunks.map((_, index) => `addAll(officialCases${index}())`).join('\n') + '\n}\n' +
        chunks.map((cases, index) => `private fun officialCases${index}(): List<FormatCase> = listOf(\n${cases.join(',\n')}\n)\n`).join('');
    return { source,
        patterns: selected.length / 3, samples: selected.length, deferred };
}

/** Execute the actual interpolation prefix used by all five raw Int registrations.
 * The warning suffix extension needs LanguageFeature state and is explicitly outside this probe. */
export function rawIntDiagnosticCases(inventory, originalTable) {
    const declaration = /^        val wrongNumberOfTypeArguments = "[^\n]+"$/m.exec(originalTable)?.[0];
    assert(declaration, 'Actual raw-Int diagnostic prefix declaration changed');
    const records = inventory.records.filter(record => record.rawParameters.length);
    assert.equal(records.length, 5);
    const cases = [];
    for (const record of records) {
        assert.equal(record.literalParts.length, 1, 'Actual raw-Int base expression changed');
        const base = record.literalParts[0].source;
        assert(base.startsWith('"$wrongNumberOfTypeArguments'), 'Unclosed actual raw-Int interpolation');
        const suffix = record.patternExpression.slice(base.length).trim();
        assert(!suffix || /^\.toDeprecationWarningMessage\(LanguageFeature\.[A-Za-z0-9_]+\)$/.test(suffix), 'Unclosed raw-Int warning suffix');
        for (const count of ['Int.MIN_VALUE', '-1', '0', '1', '2', '999', '1000', 'Int.MAX_VALUE']) {
            const args = record.parameterTypes.map((_, index) => index === 0 ? count : kotlinString(`renderer${index}: 한글 {0} 'quoted'`));
            cases.push(`FormatCase(${kotlinString(`official-raw-int:${record.diagnostic}:${count}`)}, ${base}, arrayOf<Any?>(${args.join(', ')}))`);
        }
    }
    return { source: `package org.jetbrains.kotlin.portable.diagnostics.probe\nfun officialRawIntCases(): List<FormatCase> {\n${declaration.trim()}\nreturn listOf(\n${cases.join(',\n')}\n)\n}\n`,
        patterns: records.length, samples: cases.length, prefixDeclarationSha256: sha256(Buffer.from(declaration)), warningSuffixExecution: 'not-run' };
}

function equalObservations(original, actual, label) {
    if (original === actual) return;
    const expected = original.split('\n'), observed = actual.split('\n');
    const index = expected.findIndex((line, i) => line !== observed[i]);
    throw new Error(`${label} differs at observation ${index}: expected ${expected[index]?.slice(0, 250)}; observed ${observed[index]?.slice(0, 250)}`);
}

export async function buildDiagnosticRenderingProbe({ sourceRoot, outputRoot, referenceCache = defaultReferenceCache } = {}) {
    assert(sourceRoot && outputRoot, 'sourceRoot and outputRoot required');
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); referenceCache = path.resolve(referenceCache);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep), 'Probe output must stay under repository out/');
    await assertNoSymlink(outputRoot); await mkdir(path.dirname(outputRoot), { recursive: true }); await mkdir(outputRoot, { mode: 0o700 });
    const prepared = await prepareDiagnosticRendering({ sourceRoot, outputRoot, referenceCache });
    const bootstrap = await verifyBootstrap();
    const recipe = JSON.parse(await readRegular(path.join(here, 'rendering.recipe.json')));
    const inventory = JSON.parse(await readRegular(path.join(here, 'templates.lock.json')));
    const corpus = literalDiagnosticCases(inventory);
    const commonTablePin = recipe.kotlinInputs.find(pin => pin.path.endsWith('/FirErrorsDefaultMessages.kt'));
    const commonTable = verifyFile(await readRegular(path.join(sourceRoot, commonTablePin.path)), commonTablePin).toString('utf8');
    const rawCorpus = rawIntDiagnosticCases(inventory, commonTable);
    const generated = Buffer.from(corpus.source);
    await writeFile(path.join(outputRoot, 'GeneratedPatterns.kt'), generated, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(outputRoot, 'GeneratedRawIntPatterns.kt'), rawCorpus.source, { flag: 'wx', mode: 0o600 });
    const observerNames = ['FormatProbe.kt', 'JvmOriginal.kt', 'CommonFormat.kt', 'JvmEntry.kt', 'ProfileGuardProbe.kt', 'ProfileJvmEntry.kt', 'WasmEntry.kt'];
    const observers = [];
    for (const name of observerNames) {
        const bytes = await readRegular(path.join(here, name));
        await writeFile(path.join(outputRoot, name), bytes, { flag: 'wx', mode: 0o600 });
        observers.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    for (const dir of ['jvm', 'klib', 'wasm', 'original-jdk']) await mkdir(path.join(outputRoot, dir));
    const commands = [], stderrByPhase = new Map();
    async function run(phase, command, args) {
        console.log('phase: ' + phase);
        const result = await execute(command, args, { cwd: outputRoot, timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
        if (result.stderr) process.stderr.write(result.stderr);
        stderrByPhase.set(phase, result.stderr);
        commands.push({ phase, command: [command, ...args], exitCode: 0 });
        return result.stdout;
    }
    // Compile the exact pinned java.text implementation; locale provider data and java.lang.Integer
    // are supplied by the recorded host JDK 17. This does not claim a rebuilt complete OpenJDK.
    const originalJava = recipe.jdk.files.filter(pin => ['MessageFormat.java', 'ChoiceFormat.java', 'NumberFormat.java', 'DecimalFormat.java'].includes(pin.path));
    for (const pin of originalJava) verifyFile(await readRegular(path.join(referenceCache, pin.path)), pin);
    await run('pinned-openjdk-java-text-build', 'javac', ['--patch-module', 'java.base=' + referenceCache, '-d', path.join(outputRoot, 'original-jdk'), ...originalJava.map(pin => path.join(referenceCache, pin.path))]);
    const jdkVersion = await run('host-jdk-version', 'java', ['-version']) + stderrByPhase.get('host-jdk-version');
    assert(/version "17\./.test(jdkVersion), 'Differential reference support requires the recorded JDK 17 host');
    const flagBytes = await readRegular(path.join(here, '../build-flags.json'));
    const flags = JSON.parse(flagBytes);
    assert.equal(flags.source.commit, prepared.receipt.source.commit);
    const compiler = ['-Xmx768m', '-cp', bootstrap.classPath];
    const sharedFlags = ['-language-version', '2.5', '-api-version', '2.5', ...flags.compilerFlags];
    const stdlib = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path;
    const jvm = [...compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', ...sharedFlags, '-classpath', stdlib];
    const probe = ['FormatProbe.kt', 'GeneratedPatterns.kt', 'GeneratedRawIntPatterns.kt'].map(name => path.join(outputRoot, name));
    const originalJar = path.join(outputRoot, 'jvm/original.jar'), commonJar = path.join(outputRoot, 'jvm/common.jar');
    const originalSources = [...probe, path.join(outputRoot, 'JvmOriginal.kt')];
    await run('openjdk-jvm-probe-build', 'java', [...jvm, '-Xmulti-platform', '-Xcommon-sources=' + probe.join(','), '-d', originalJar, ...originalSources, path.join(outputRoot, 'JvmEntry.kt')]);
    const formatter = prepared.commonSources.find(filename => filename.endsWith('/DiagnosticMessageFormat.kt'));
    assert(formatter);
    const common = [...probe, formatter, path.join(outputRoot, 'ProfileGuardProbe.kt')];
    const commonActual = path.join(outputRoot, 'CommonFormat.kt');
    await run('common-jvm-probe-build', 'java', [...jvm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-d', commonJar, ...common, commonActual, path.join(outputRoot, 'JvmEntry.kt'), path.join(outputRoot, 'ProfileJvmEntry.kt')]);
    const main = 'org.jetbrains.kotlin.portable.diagnostics.probe.JvmEntryKt';
    const original = await run('pinned-openjdk-jvm-observe', 'java', ['--patch-module', 'java.base=' + path.join(outputRoot, 'original-jdk'), '-ea', '-cp', [originalJar, stdlib].join(path.delimiter), main]);
    const observedJvm = await run('common-jvm-observe', 'java', ['-ea', '-cp', [commonJar, stdlib].join(path.delimiter), main]);
    equalObservations(original, observedJvm, 'Pinned OpenJDK/common JVM');
    const guardsJvm = await run('common-jvm-profile-guards', 'java', ['-ea', '-cp', [commonJar, stdlib].join(path.delimiter), 'org.jetbrains.kotlin.portable.diagnostics.probe.ProfileJvmEntryKt']);
    const wasm = [...compiler, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-libraries', bootstrap.wasmJsStdlib, ...sharedFlags];
    await run('common-wasmjs-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-Xir-produce-klib-file', '-ir-output-dir', path.join(outputRoot, 'klib'), '-ir-output-name', 'diagnostic-rendering', ...common, commonActual, path.join(outputRoot, 'WasmEntry.kt')]);
    await run('common-wasmjs-binary-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/diagnostic-rendering.klib'), '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'diagnostic-rendering', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
    const moduleUrl = pathToFileURL(path.join(outputRoot, 'wasm/diagnostic-rendering.mjs')).href;
    const observedWasm = await run('common-node-wasmjs-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e', 'const m = await import(process.argv[1]); process.stdout.write(m.diagnosticFormatProbe());', moduleUrl]);
    const guardsWasm = await run('common-node-wasmjs-profile-guards', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e', 'const m = await import(process.argv[1]); process.stdout.write(m.diagnosticProfileGuardProbe());', moduleUrl]);
    equalObservations(original, observedWasm, 'Pinned OpenJDK/common Wasm'); equalObservations(guardsJvm, guardsWasm, 'JVM/Wasm profile guards');
    const observationFiles = [['original-jvm.txt', original], ['common-jvm.txt', observedJvm], ['common-wasmjs.txt', observedWasm], ['profile-guards-jvm.txt', guardsJvm], ['profile-guards-wasmjs.txt', guardsWasm]];
    for (const [name, text] of observationFiles) await writeFile(path.join(outputRoot, name), text, { flag: 'wx', mode: 0o600 });
    const outputNames = ['GeneratedPatterns.kt', 'GeneratedRawIntPatterns.kt', 'jvm/original.jar', 'jvm/common.jar', 'klib/diagnostic-rendering.klib', ...observationFiles.map(([name]) => name)];
    async function listFiles(directory) {
        for (const entry of await readdir(path.join(outputRoot, directory), { withFileTypes: true })) {
            const name = path.join(directory, entry.name);
            if (entry.isDirectory()) await listFiles(name); else { assert(entry.isFile()); outputNames.push(name); }
        }
    }
    await listFiles('wasm'); await listFiles('original-jdk');
    const outputs = [];
    for (const name of outputNames.sort()) { const bytes = await readRegular(path.join(outputRoot, name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
    const receipt = { schemaVersion: 1, kind: 'pinned-openjdk-diagnostic-format-jvm-common-wasm-differential', source: recipe.source,
        recipeSha256: sha256(await readRegular(path.join(here, 'rendering.recipe.json'))), preparationReceiptSha256: sha256(await readRegular(prepared.receiptPath)),
        buildToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), buildFlagsSha256: sha256(flagBytes), observers, commands, outputs,
        bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
        originalJdk: { source: recipe.jdk, compiledPinnedJavaText: originalJava.map(pin => pin.path),
            hostSupport: 'Host JDK java.lang.Integer and locale provider data; no complete OpenJDK rebuild claimed', versionCommandStdout: jdkVersion },
        comparison: { observations: original.trimEnd().split('\n').length, literalParameterizedPatterns: corpus.patterns, literalSamples: corpus.samples,
            deferredPatternExpressions: corpus.deferred, originalJvmEqualsCommonJvm: true, originalJvmEqualsCommonWasm: true,
            rawIntDiagnosticBasePatterns: rawCorpus.patterns, rawIntDiagnosticSamples: rawCorpus.samples,
            rawIntPrefixDeclarationSha256: rawCorpus.prefixDeclarationSha256, rawIntWarningSuffixExecution: rawCorpus.warningSuffixExecution,
            observationSha256: sha256(Buffer.from(original)), profileGuardsSha256: sha256(Buffer.from(guardsJvm)),
            defaultLocaleIndependence: ['en-US', 'de-DE', 'tr-TR', 'ar-EG'],
            scope: 'Pinned java.text pattern formatting and audited String/Int profile; no actual diagnostic table or resolved FIR execution.' },
        wasmEngine: { kind: 'Node', version: process.version, flags: ['--experimental-wasm-exnref'] }, browserComparison: 'not-run',
        diagnosticTableExecution: 'not-run', resolvedFirExecution: 'not-run', fullCompilerBuilt: false, freshBrowserSourceCompilation: 'not-run', publicLanguageSupport: false };
    await writeJson(path.join(outputRoot, 'receipt.json'), receipt);
    return { outputRoot, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const args = process.argv.slice(2), options = {};
        for (let index = 0; index < args.length; index += 2) {
            assert(['--source-root', '--output', '--reference-cache'].includes(args[index]) && args[index + 1] && !options[args[index]]);
            options[args[index]] = args[index + 1];
        }
        const result = await buildDiagnosticRenderingProbe({ sourceRoot: options['--source-root'], outputRoot: options['--output'], referenceCache: options['--reference-cache'] });
        console.log(JSON.stringify({ outputRoot: result.outputRoot, comparison: result.receipt.comparison, publicLanguageSupport: false }));
    } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
