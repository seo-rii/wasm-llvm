import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { prepareJsAstSources, verifyJsAstPreparation } from '../js-ast/prepare.mjs';
import { verifyEvidence } from '../js-ast/verify.mjs';
import { prepareCompilerTextSources, verifyCompilerTextPreparation } from '../text/prepare.mjs';
import { prepareSourceMapJsonReferences, prepareSourceMapJson, verifySourceMapJson } from '../source-map-json/prepare.mjs';
import { prepareSourceMapTextIo, verifySourceMapTextIo } from '../source-map-text-io/prepare.mjs';
import { observeAstInChromium } from '../js-ast/browser.mjs';
import { prepareSourceMapBuilder, verifySourceMapBuilder } from './prepare.mjs';
import { BUILDER, CONSUMER } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources'), parent = path.join(REPO, 'out/kotlin-source-map-builder-kernel');
await mkdir(parent, { recursive: true, mode: 0o700 });
const output = await mkdtemp(path.join(parent, 'run-')), local = name => path.join(output, name);
const options = { sourceRoot, outputRoot: local('kernel') }, prepared = await prepareSourceMapBuilder(options);
await verifySourceMapBuilder({ ...options, receiptPath: prepared.receiptPath });
const ast = await prepareJsAstSources({ sourceRoot, outputRoot: local('ast') }); await verifyJsAstPreparation(local('ast'), { sourceRoot });
const jsonReferences = await prepareSourceMapJsonReferences();
const json = await prepareSourceMapJson({ sourceRoot: jsonReferences.sourceRoot, outputRoot: local('json') });
await verifySourceMapJson({ sourceRoot: jsonReferences.sourceRoot, outputRoot: local('json'), receiptPath: json.receiptPath });
const io = await prepareSourceMapTextIo({ outputRoot: local('io') }); await verifySourceMapTextIo({ outputRoot: local('io'), receiptPath: io.receiptPath });
const text = await prepareCompilerTextSources({ sourceRoot, outputRoot: local('text') }); await verifyCompilerTextPreparation(path.dirname(text.receiptPath));
const textLock = JSON.parse(await readRegular(path.join(HERE, '../text/sources.lock.json')));
const utf8 = text.commonSources.filter(name => [textLock.generatedAlgorithm, textLock.api].some(pin => path.basename(name) === pin.path)); assert.equal(utf8.length, 2);
const sink = path.join(HERE, '../js-ast-consumer-bindings/output-stream/JsAstStreamOutput.kt');
const baseline = path.join(REPO, 'out/kotlin-js-ast/differential-WViAyC');
const astEvidence = JSON.parse(await readRegular(path.join(HERE, '../js-ast/evidence/receipt.json'))); await verifyEvidence(astEvidence, { artifactRoot: baseline });
const observer = verifyFile(await readRegular(path.join(HERE, 'Probe.kt')), lock.observers.find(pin => pin.path === 'Probe.kt')).toString();
const imports = [...observer.matchAll(/^import [^\n]+/gm)].map(match => match[0]).join('\n');
const body = observer.replace(/^package[^\n]*\n/, '').replace(/^import [^\n]+\n/gm, '');
for (const common of [false, true]) {
    const name = common ? 'CommonSupport.kt' : 'OriginalSupport.kt';
    const support = verifyFile(await readRegular(path.join(HERE, name)), lock.observers.find(pin => pin.path === name)).toString().replace(/^(package[^\n]*\n)/, '$1' + imports + '\n');
    // Imports from the shared observer are coalesced; all code/fixtures remain intact.
    const seen = new Set(); const combined = (support + '\n' + body).split('\n').filter(line => {
        if (!line.startsWith('import ')) return true;
        if (seen.has(line)) return false; seen.add(line); return true;
    }).join('\n');
    await writeFile(local(common ? 'CommonProbe.kt' : 'OriginalProbe.kt'), combined, { flag: 'wx', mode: 0o600 });
}
for (const name of ['JvmEntry.kt', 'WasmEntry.kt']) await writeFile(local(name), verifyFile(await readRegular(path.join(HERE, name)), lock.observers.find(pin => pin.path === name)), { flag: 'wx', mode: 0o600 });
const bootstrap = await verifyBootstrap(), flagsBytes = await readRegular(path.join(HERE, '../build-flags.json')), flags = JSON.parse(flagsBytes);
const run = promisify(execFile), commands = [];
async function execute(phase, executable, args) {
    console.log('phase: ' + phase); const started = Date.now();
    try {
        const result = await run(executable, args, { timeout: 240000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });
        if (result.stderr) process.stderr.write(result.stderr);
        commands.push({ phase, command: [executable, ...args], exitCode: 0, durationMs: Date.now() - started });
        return phase === 'jvm-runtime-version' ? (result.stdout || result.stderr) : result.stdout;
    } catch (error) {
        await writeJson(local(phase + '-failure.json'), { code: error.code ?? null, signal: error.signal ?? null, killed: error.killed ?? false, durationMs: Date.now() - started });
        process.stderr.write(String(error.stderr ?? '').slice(-16000)); throw new Error(phase + ' failed: ' + error.code);
    }
}
const oracleVersion = await execute('jvm-runtime-version', 'java', ['--version']); await writeFile(local('JvmVersion.txt'), oracleVersion, { flag: 'wx', mode: 0o600 });
const compilerPin = bootstrap.artifacts.find(pin => pin.id === 'compiler'), stdlib = bootstrap.artifacts.find(pin => pin.id === 'stdlib-jvm').path;
const annotations = bootstrap.artifacts.find(pin => pin.id === 'annotations').path;
const fastutil = JSON.parse(await execute('extract-pinned-genuine-fastutil', 'python3', [path.join(HERE, 'extract-fastutil.py'), compilerPin.path, local('fastutil.jar')]));
assert(fastutil.classes.length > 0 && fastutil.classes.every(pin => pin.path.startsWith('org/jetbrains/kotlin/it/unimi/dsi/fastutil/')));
assert.equal(fastutil.compilerAstClassesExtracted, false); await writeJson(local('fastutil.json'), { ...fastutil, archive: compilerPin });
const originals = [];
for (const pin of lock.sources) {
    const original = verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin);
    const filename = local('original-inputs/' + pin.path); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, original, { flag: 'wx', mode: 0o600 });
    if (pin.path === BUILDER) {
        const code = original.toString(); const from = 'import it.unimi.dsi.fastutil.objects.Object2IntOpenHashMap'; assert.equal(code.split(from).length, 2);
        const oracle = local('OriginalSourceMap3Builder.kt');
        await writeFile(oracle, code.replace(from, 'import org.jetbrains.kotlin.it.unimi.dsi.fastutil.objects.Object2IntOpenHashMap'), { flag: 'wx', mode: 0o600 }); originals.push(oracle);
    }
}
await mkdir(local('original-java'), { mode: 0o700 });
await execute('actual-original-mapping-interface-javac', 'javac', ['-cp', annotations, '-d', local('original-java'), local('original-inputs/' + CONSUMER)]);
const jsonLock = JSON.parse(await readRegular(path.join(HERE, '../source-map-json/sources.lock.json')));
originals.push(path.join(jsonReferences.sourceRoot, jsonLock.sources.find(pin => pin.path.endsWith('/JSON.kt')).path));
const originalAst = [path.join(baseline, 'original-java'), path.join(baseline, 'original-kotlin.jar'), path.join(baseline, 'oracle-dependencies.jar')];
const java = ['-Xmx768m', '-cp', bootstrap.classPath], jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17',
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
const originalClasspath = [local('original-java'), ...originalAst, local('fastutil.jar'), stdlib, annotations].join(path.delimiter);
await execute('actual-original-builder-jvm-build', 'java', [...jvm, '-classpath', originalClasspath, '-d', local('original.jar'), ...originals, local('OriginalProbe.kt'), local('JvmEntry.kt')]);
const readerBytecode = await execute('actual-stdlib-reader-bytecode', 'javap', ['-c', '-p', '-classpath', stdlib, 'kotlin.io.TextStreamsKt', 'kotlin.io.CloseableKt', 'kotlin.ExceptionsKt__ExceptionsKt']);
assert(readerBytecode.includes('sipush        8192') && readerBytecode.includes('iflt') && readerBytecode.includes('closeFinally') && readerBytecode.includes('if_acmpeq'));
await writeFile(local('OriginalReaderBytecode.txt'), readerBytecode, { flag: 'wx', mode: 0o600 });
const supportBytes = verifyFile(await readRegular(path.join(sourceRoot, lock.referenceDependencies[0].path)), lock.referenceDependencies[0]);
const support = supportBytes.toString(), start = support.indexOf('fun <T, A : Appendable> Iterable<T>.joinToWithBuffer('), end = support.indexOf('\nfun String.countOccurrencesOf(', start); assert(start >= 0 && end > start);
const join = local('JoinToWithBuffer.kt'); await writeFile(join, support.slice(0, support.indexOf('@file:')) + 'package org.jetbrains.kotlin.utils.addToStdlib\n\n' + support.slice(start, end), { flag: 'wx', mode: 0o600 });
const common = [join, ...prepared.commonSources, ...ast.commonSources, ...ast.dependencySources, ...json.commonSources, ...io.commonSources, ...utf8, sink, local('CommonProbe.kt')];
await execute('common-full-ast-builder-jvm-build', 'java', [...jvm, '-classpath', stdlib, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-d', local('portable.jar'), ...common, local('JvmEntry.kt')]);
const original = JSON.parse(await execute('actual-original-builder-observe', 'java', ['-ea', '-Dfile.encoding=UTF-8', '-cp', [local('original.jar'), originalClasspath].join(path.delimiter), 'org.jetbrains.kotlin.js.sourcemapbuilderprobe.JvmEntryKt']));
const portable = JSON.parse(await execute('common-full-ast-builder-observe', 'java', ['-ea', '-cp', [local('portable.jar'), stdlib].join(path.delimiter), 'org.jetbrains.kotlin.js.sourcemapbuilderprobe.JvmEntryKt']));
await writeJson(local('original-jvm.json'), original); await writeJson(local('portable-jvm.json'), portable);
function compare(actual, host) {
    assert.equal(actual.records.length, original.records.length);
    const index = original.records.findIndex((value, index) => value !== actual.records[index]);
    if (index >= 0) throw new Error(host + ' differs at ' + index + ': ' + original.records[index].slice(0, 3000) + ' <> ' + actual.records[index].slice(0, 3000));
}
compare(portable, 'Common JVM'); await mkdir(local('klib')); await mkdir(local('wasm'));
const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-language-version', flags.languageVersion,
    '-api-version', flags.apiVersion, ...flags.compilerFlags, '-libraries', bootstrap.wasmJsStdlib];
await execute('full-ast-builder-wasm-klib', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-ir-output-dir', local('klib'), '-ir-output-name', 'source-map-builder', ...common, local('WasmEntry.kt')]);
await execute('full-ast-builder-wasm-module', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + local('klib/source-map-builder.klib'), '-ir-output-dir', local('wasm'), '-ir-output-name', 'js-ast', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const node = JSON.parse(await execute('full-ast-builder-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const module=await import(process.argv[1]);console.log(module.astProbeJson());', pathToFileURL(local('wasm/js-ast.mjs')).href]));
await writeJson(local('portable-wasm.json'), node); compare(node, 'Node Wasm');
const browser = await observeAstInChromium(output, original.records); await writeFile(local('portable-chromium.json'), browser.raw, { flag: 'wx', mode: 0o600 });
const outputs = []; async function collect(directory) {
    for (const entry of await readdir(local(directory), { withFileTypes: true })) {
        const name = directory ? directory + '/' + entry.name : entry.name;
        if (entry.isDirectory()) await collect(name); else { const bytes = await readRegular(local(name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
    }
} await collect('');
const receipt = { schemaVersion: 1, kind: 'genuine-source-map-builder-full-ast-four-host-profile', source: lock.source, sourceLockSha256: sha256(lockBytes),
    checkToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), buildFlagsSha256: sha256(flagsBytes), preparation: prepared.receipt, commands, outputs, oracleVersion,
    originalAstEvidenceSha256: sha256(await readRegular(path.join(HERE, '../js-ast/evidence/receipt.json'))), fastutil,
    oracleFastutilArchive: { id: compilerPin.id, bytes: compilerPin.bytes, sha256: compilerPin.sha256, importRelocationOnly: true },
    comparison: { observations: original.records.length, originalJvmEqualsCommonJvm: true, originalJvmEqualsNodeWasm: true, originalJvmEqualsOfflineChromium: true,
        skipped: 0, normalization: false, recordsSha256: sha256(Buffer.from(JSON.stringify(original.records))) },
    rawNativeReaderDiagnostics: { originalJvm: original.rawFailures, commonJvm: portable.rawFailures, nodeWasm: node.rawFailures, offlineChromium: browser.observation.rawFailures },
    browser: browser.receipt, identityContract: lock.identityContract, diagnosticProtocol: 'Required banner then throwable reporting; controlled genuine-JVM throwable override observes order, identity and real byte effects.',
    nativeStacktraceTextParity: false, originalGlobalStderrParity: false, callerIntegrated: false, pathResolverBuilt: false, fullCompilerBuilt: false, languageReadiness: false };
await writeJson(local('receipt.json'), receipt); console.log(JSON.stringify({ output, comparison: receipt.comparison, fastutilClasses: fastutil.classes.length }));
