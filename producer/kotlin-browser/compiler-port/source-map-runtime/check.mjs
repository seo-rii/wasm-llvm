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
import { prepareConfigurationSources } from '../config/prepare.mjs';
import { prepareSourceContentBindings } from '../js-ast-consumer-bindings/source-content/prepare.mjs';
import { prepareCompilerTextSources, verifyCompilerTextPreparation } from '../text/prepare.mjs';
import { prepareSourceMapJsonReferences, prepareSourceMapJson, verifySourceMapJson } from '../source-map-json/prepare.mjs';
import { prepareSourceMapTextIo, verifySourceMapTextIo } from '../source-map-text-io/prepare.mjs';
import { observeAstInChromium } from '../js-ast/browser.mjs';
import { prepareSourceMapRuntimeReferences, prepareSourceMapRuntime, verifySourceMapRuntime } from './prepare.mjs';
import { verifySourceMapRuntimeFinalSources } from './final.mjs';
import { UTILS } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources'), parent = path.join(REPO, 'out/kotlin-source-map-runtime'); await mkdir(parent, { recursive: true, mode: 0o700 });
const output = await mkdtemp(path.join(parent, 'run-')), local = name => path.join(output, name);
const sourceContentComponent = await prepareSourceContentBindings({ sourceRoot, outputRoot: local('source-content') });
const retainedSources = lock.selectedCallers.map(name => name === UTILS ? { path: lock.predecessor.componentRelativePath,
    filename: sourceContentComponent.commonSources[0], compile: true } : { path: name, filename: path.join(sourceRoot, name), compile: true });
const references = await prepareSourceMapRuntimeReferences();
const options = { sourceRoot, runtimeSourceRoot: references.sourceRoot, sourceContentComponent, retainedSources, outputRoot: local('runtime') };
const prepared = await prepareSourceMapRuntime(options); await verifySourceMapRuntime({ ...options, receiptPath: prepared.receiptPath });
const finalOptions = { profileRoot: options.outputRoot, sourceRoot, runtimeSourceRoot: references.sourceRoot, sourceContentComponent,
    retainedSources: [...prepared.receipt.files.map((pin, index) => ({ path: pin.path, filename: prepared.commonSources[index], compile: true })),
        ...retainedSources.filter(item => item.path !== lock.predecessor.componentRelativePath)] };
const finalSelection = await verifySourceMapRuntimeFinalSources(finalOptions);
const ast = await prepareJsAstSources({ sourceRoot, outputRoot: local('ast') }); await verifyJsAstPreparation(local('ast'), { sourceRoot });
const config = await prepareConfigurationSources({ sourceRoot, outputRoot: local('configuration') });
const jsonReferences = await prepareSourceMapJsonReferences(); const json = await prepareSourceMapJson({ sourceRoot: jsonReferences.sourceRoot, outputRoot: local('json') });
await verifySourceMapJson({ sourceRoot: jsonReferences.sourceRoot, outputRoot: local('json'), receiptPath: json.receiptPath });
const io = await prepareSourceMapTextIo({ outputRoot: local('io') }); await verifySourceMapTextIo({ outputRoot: local('io'), receiptPath: io.receiptPath });
const text = await prepareCompilerTextSources({ sourceRoot, outputRoot: local('text') }); await verifyCompilerTextPreparation(path.dirname(text.receiptPath));
const textLock = JSON.parse(await readRegular(path.join(HERE, '../text/sources.lock.json')));
const utf8 = text.commonSources.filter(name => [textLock.generatedAlgorithm, textLock.api].some(pin => path.basename(name) === pin.path)); assert.equal(utf8.length, 2);
const sink = path.join(HERE, '../js-ast-consumer-bindings/output-stream/JsAstStreamOutput.kt');
const baseline = path.join(REPO, 'out/kotlin-js-ast/differential-WViAyC');
const astEvidence = JSON.parse(await readRegular(path.join(HERE, '../js-ast/evidence/receipt.json'))); await verifyEvidence(astEvidence, { artifactRoot: baseline });
const observer = verifyFile(await readRegular(path.join(HERE, 'Probe.kt')), lock.observers.find(pin => pin.path === 'Probe.kt')).toString();
const observerImports = [...observer.matchAll(/^import [^\n]+/gm)].map(match => match[0]).join('\n');
const observerBody = observer.replace(/^package[^\n]*\n/, '').replace(/^import [^\n]+\n/gm, '');
for (const common of [false, true]) {
    const name = common ? 'CommonSupport.kt' : 'OriginalSupport.kt';
    const support = verifyFile(await readRegular(path.join(HERE, name)), lock.observers.find(pin => pin.path === name)).toString().replace(/^(package[^\n]*\n)/, '$1' + observerImports + '\n');
    await writeFile(local(common ? 'CommonProbe.kt' : 'OriginalProbe.kt'), support + '\n' + observerBody, { flag: 'wx', mode: 0o600 });
}
for (const name of ['JvmEntry.kt', 'WasmEntry.kt']) await writeFile(local(name), verifyFile(await readRegular(path.join(HERE, name)), lock.observers.find(pin => pin.path === name)), { flag: 'wx', mode: 0o600 });
const helper = verifyFile(await readRegular(path.join(HERE, lock.runtime.path)), lock.runtime).toString();
await writeFile(local('OriginalRuntime.kt'), helper.replace('import org.jetbrains.kotlin.config.CompilerConfiguration\n',
    'import java.io.File as SourceMapTextStore\nimport java.io.PrintStream as SourceMapPrintOutput\nimport org.jetbrains.kotlin.config.CompilerConfiguration\n'), { flag: 'wx', mode: 0o600 });
const bootstrap = await verifyBootstrap(), flagsBytes = await readRegular(path.join(HERE, '../build-flags.json')), flags = JSON.parse(flagsBytes), run = promisify(execFile), commands = [];
async function execute(phase, executable, args) {
    console.log('phase: ' + phase); const started = Date.now();
    try { const result = await run(executable, args, { timeout: 240000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
        if (result.stderr) process.stderr.write(result.stderr); commands.push({ phase, command: [executable, ...args], exitCode: 0, durationMs: Date.now() - started }); return phase === 'jvm-runtime-version' ? (result.stdout || result.stderr) : result.stdout;
    } catch (error) { await writeJson(local(phase + '-failure.json'), { code: error.code ?? null, signal: error.signal ?? null, killed: error.killed ?? false, durationMs: Date.now() - started });
        process.stderr.write(String(error.stderr ?? '').slice(-16000)); throw new Error(phase + ' failed: ' + error.code); }
}
const oracleVersion = await execute('jvm-runtime-version', 'java', ['--version']);
const ioEvidence = JSON.parse(await readRegular(path.join(HERE, '../source-map-text-io/evidence/receipt.json'))); assert.equal(oracleVersion, ioEvidence.oracleVersion);
await writeFile(local('JvmRuntime.txt'), oracleVersion, { flag: 'wx', mode: 0o600 });
const originals = lock.sources.map(pin => path.join(references.sourceRoot, pin.path));
const jsonLock = JSON.parse(await readRegular(path.join(HERE, '../source-map-json/sources.lock.json')));
originals.push(path.join(jsonReferences.sourceRoot, jsonLock.sources.find(pin => pin.path.endsWith('/JSON.kt')).path));
const configLock = JSON.parse(await readRegular(path.join(HERE, '../config/sources.lock.json')));
for (const pin of configLock.sources) {
    const filename = local('Original' + path.basename(pin.path)); await writeFile(filename, verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin).toString().replace('import com.intellij.openapi.util.Key', 'import org.jetbrains.kotlin.com.intellij.openapi.util.Key'), { flag: 'wx', mode: 0o600 }); originals.push(filename);
}
const stdlib = bootstrap.artifacts.find(pin => pin.id === 'stdlib-jvm').path;
const originalAst = [path.join(baseline, 'original-java'), path.join(baseline, 'original-kotlin.jar'), path.join(baseline, 'oracle-dependencies.jar')];
const java = ['-Xmx768m', '-cp', bootstrap.classPath], jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
await execute('actual-original-runtime-jvm-build', 'java', [...jvm, '-classpath', [...originalAst, bootstrap.classPath].join(path.delimiter), '-d', local('original.jar'), ...originals, local('OriginalRuntime.kt'), local('OriginalProbe.kt'), local('JvmEntry.kt')]);
const originalBytecode = await execute('actual-original-remapper-bytecode', 'javap', ['-c', '-p', '-classpath', local('original.jar'), 'org.jetbrains.kotlin.js.parser.sourcemaps.SourceMapLocationRemapper$JsNodeFlatListCollector']);
const functionBytecode = originalBytecode.slice(originalBytecode.indexOf('public void visitFunction('), originalBytecode.indexOf('protected void visitElement('));
const getter = functionBytecode.indexOf('JsFunction.getBody:'), dereference = functionBytecode.indexOf('JsBlock.getStatements:');
assert(getter >= 0 && dereference > getter && !functionBytecode.slice(getter, dereference).includes('Intrinsics.'));
await writeFile(local('OriginalRemapperBytecode.txt'), originalBytecode, { flag: 'wx', mode: 0o600 });
const supportBytes = verifyFile(await readRegular(path.join(sourceRoot, lock.referenceDependencies[0].path)), lock.referenceDependencies[0]);
const supportText = supportBytes.toString(), start = supportText.indexOf('fun <T, A : Appendable> Iterable<T>.joinToWithBuffer('), end = supportText.indexOf('\nfun String.countOccurrencesOf(', start);
assert(start >= 0 && end > start);
const joinSupport = local('JoinToWithBuffer.kt'); await writeFile(joinSupport, supportText.slice(0, supportText.indexOf('@file:')) + 'package org.jetbrains.kotlin.utils.addToStdlib\n\n' + supportText.slice(start, end), { flag: 'wx', mode: 0o600 });
const common = [joinSupport, ...prepared.commonSources.filter(filename => !filename.endsWith('/' + UTILS)), ...ast.commonSources, ...ast.dependencySources, ...config.commonSources, ...json.commonSources, ...io.commonSources, ...utf8, sink, local('CommonProbe.kt')];
await execute('common-full-ast-runtime-jvm-build', 'java', [...jvm, '-classpath', stdlib, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-d', local('portable.jar'), ...common, local('JvmEntry.kt')]);
await mkdir(local('raw-files'), { mode: 0o700 });
const original = JSON.parse(await execute('actual-original-runtime-observe', 'java', ['-ea', '-Dfile.encoding=UTF-8', '-Djava.io.tmpdir=' + local('raw-files'), '-cp', [local('original.jar'), ...originalAst, bootstrap.classPath].join(path.delimiter), 'org.jetbrains.kotlin.js.sourcemapruntimeprobe.JvmEntryKt']));
const portable = JSON.parse(await execute('common-full-ast-runtime-observe', 'java', ['-ea', '-cp', [local('portable.jar'), stdlib].join(path.delimiter), 'org.jetbrains.kotlin.js.sourcemapruntimeprobe.JvmEntryKt']));
await writeJson(local('original-jvm.json'), original); await writeJson(local('portable-jvm.json'), portable);
function compare(actual, host) { assert.equal(actual.records.length, original.records.length); const index = original.records.findIndex((value, index) => value !== actual.records[index]); if (index >= 0) throw new Error(host + ' differs at ' + index + ': ' + original.records[index].slice(0, 1000) + ' <> ' + actual.records[index].slice(0, 1000)); }
compare(portable, 'Common JVM'); await mkdir(local('klib')); await mkdir(local('wasm'));
const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags, '-libraries', bootstrap.wasmJsStdlib];
await execute('full-ast-runtime-wasm-klib', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-ir-output-dir', local('klib'), '-ir-output-name', 'source-map-runtime', ...common, local('WasmEntry.kt')]);
await execute('full-ast-runtime-wasm-module', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + local('klib/source-map-runtime.klib'), '-ir-output-dir', local('wasm'), '-ir-output-name', 'js-ast', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const node = JSON.parse(await execute('full-ast-runtime-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e', 'const module=await import(process.argv[1]);console.log(module.astProbeJson());', pathToFileURL(local('wasm/js-ast.mjs')).href]));
await writeJson(local('portable-wasm.json'), node); compare(node, 'Node Wasm');
const browser = await observeAstInChromium(output, original.records); await writeFile(local('portable-chromium.json'), browser.raw, { flag: 'wx', mode: 0o600 });
const outputs = []; async function collect(directory) { for (const item of await readdir(local(directory), { withFileTypes: true })) { const name = directory ? directory + '/' + item.name : item.name; if (item.isDirectory()) await collect(name); else { const bytes = await readRegular(local(name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); } } } await collect('');
const receipt = { schemaVersion: 1, kind: 'genuine-source-map-runtime-full-ast-four-host-profile', source: lock.source, sourceLockSha256: sha256(lockBytes),
    checkToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), buildFlagsSha256: sha256(flagsBytes), preparation: prepared.receipt,
    commands, outputs, oracleVersion, originalGetterImmediatelyDereferenced: true, finalSelection: finalSelection.receipt, comparison: { observations: original.records.length, originalJvmEqualsCommonJvm: true, originalJvmEqualsNodeWasm: true, originalJvmEqualsOfflineChromium: true, skipped: 0, normalization: false, recordsSha256: sha256(Buffer.from(JSON.stringify(original.records))) },
    originalAstEvidenceSha256: sha256(await readRegular(path.join(HERE, '../js-ast/evidence/receipt.json'))), originalAstRuntime: originalAst,
    rawReaderFailures: { originalJvm: original.failures, commonJvm: portable.failures, nodeWasm: node.failures, offlineChromium: browser.observation.failures }, browser: browser.receipt,
    explicitRequestPrintContract: true, originalGlobalStdoutParity: false, entryRuntimeInstalled: false, fullJsAstUtilsBuilt: false, sourceMapBuilderBuilt: false, fullCompilerBuilt: false, languageReadiness: false };
await writeJson(local('receipt.json'), receipt); console.log(JSON.stringify({ output, comparison: receipt.comparison }));
