#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { readRegular, sha256, verifyFile, writeJson } from '../../../scripts/source.mjs';
import { verifyBootstrap } from '../../../build/bootstrap.mjs';
import { prepareConfigurationSources } from '../../config/prepare.mjs';
import { prepareHostSources } from '../../host/prepare.mjs';
import { verifyEvidence } from '../../js-ast/verify.mjs';
import { observeAstInChromium } from '../../js-ast/browser.mjs';
import { prepareSourceContentBindings, verifySourceContentBindings } from './prepare.mjs';
import { UTILS, sourceContentBinding } from './transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../../..');
const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
const parent = path.join(REPO, 'out/kotlin-js-ast-source-content'); await mkdir(parent, { recursive: true, mode: 0o700 });
const output = await mkdtemp(path.join(parent, 'run-')), local = name => path.join(output, name);
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const prepared = await prepareSourceContentBindings({ sourceRoot, outputRoot: local('binding') });
await verifySourceContentBindings({ sourceRoot, outputRoot: local('binding'), receiptPath: prepared.receiptPath });
const config = await prepareConfigurationSources({ sourceRoot, outputRoot: local('configuration') });
const host = await prepareHostSources({ sourceRoot, outputRoot: local('host') });
const sourcePath = 'compiler/frontend.common/src/org/jetbrains/kotlin/KtSourceFile.kt';
const hostLock = JSON.parse(await readRegular(path.join(HERE, '../../host/sources.lock.json'))), hostPin = hostLock.sources.find(pin => pin.path === sourcePath);
const portableSource = path.join(host.outputRoot, sourcePath); assert.equal(sha256(await readRegular(portableSource)), hostPin.portableSha256);
const astReceipt = JSON.parse(await readRegular(path.join(HERE, '../../js-ast/evidence/receipt.json')));
const baseline = path.join(REPO, 'out/kotlin-js-ast/differential-WViAyC'); await verifyEvidence(astReceipt, { artifactRoot: baseline });
const originalSource = verifyFile(await readRegular(path.join(sourceRoot, sourcePath)), lock.sources.find(pin => pin.path === sourcePath)).toString();
const interfaceStart = originalSource.indexOf('interface KtSourceFile {'), interfaceEnd = originalSource.indexOf('\nclass KtPsiSourceFile', interfaceStart), memoryStart = originalSource.indexOf('class KtInMemoryTextSourceFile(');
assert(interfaceStart > 0 && interfaceEnd > interfaceStart && memoryStart > interfaceEnd);
const sourceProjection = 'package org.jetbrains.kotlin\nimport java.io.InputStream\nimport java.io.ByteArrayInputStream\n' + originalSource.slice(interfaceStart, interfaceEnd) + '\n' + originalSource.slice(memoryStart);
await writeFile(local('OriginalKtSourceFile.kt'), sourceProjection, { flag: 'wx', mode: 0o600 });
const originals = [local('OriginalKtSourceFile.kt')];
for (const pin of lock.sources.filter(pin => pin.path.includes('/config/'))) {
    const bytes = verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin);
    const text = bytes.toString().replace('import com.intellij.openapi.util.Key', 'import org.jetbrains.kotlin.com.intellij.openapi.util.Key');
    const filename = local('Original' + path.basename(pin.path)); await writeFile(filename, text, { flag: 'wx', mode: 0o600 }); originals.push(filename);
}
const provider = verifyFile(await readRegular(path.join(HERE, lock.provider.path)), lock.provider);
const originalProvider = provider.toString().replace('import org.jetbrains.kotlin.js.util.AstSourceReader', 'import java.io.Reader as AstSourceReader')
    .replace('import org.jetbrains.kotlin.js.util.AstStringReader', 'import java.io.StringReader as AstStringReader') +
    '\nprivate fun KtSourceFile.getContentsAsText(): String = getContentsAsStream().reader(Charsets.UTF_8).use { it.readText() }\n';
await writeFile(local('OriginalRequestSourceContent.kt'), originalProvider, { flag: 'wx', mode: 0o600 });
const bound = sourceContentBinding(await readRegular(path.join(sourceRoot, UTILS)));
const consumerProjection = 'package org.jetbrains.kotlin.js.sourcecontentprobe\nimport org.jetbrains.kotlin.config.CompilerConfiguration\nimport org.jetbrains.kotlin.js.backend.ast.*\nimport org.jetbrains.kotlin.js.portable.requestSourceSupplier\n' +
    bound.boundBody.replace('private fun', 'fun').replace('context: JsGenerationContext', 'context: CompilerConfiguration').replace('context.staticContext.backendContext.configuration', 'context');
await writeFile(local('EmbeddedSourceConsumer.kt'), consumerProjection, { flag: 'wx', mode: 0o600 });
for (const pin of lock.observers) await writeFile(local(pin.path), verifyFile(await readRegular(path.join(HERE, pin.path)), pin), { flag: 'wx', mode: 0o600 });
const locationPath = 'js/js.ast/src/org/jetbrains/kotlin/js/backend/ast/JsLocation.kt';
const originalLocation = local('OriginalJsLocation.kt'); await writeFile(originalLocation, await readRegular(path.join(sourceRoot, locationPath)), { flag: 'wx', mode: 0o600 });
const commonLocation = path.join(baseline, 'common', locationPath), reader = path.join(HERE, '../../js-ast/portable/org/jetbrains/kotlin/js/util/AstSourceReader.kt');
const shared = [local('Probe.kt'), local('RawTextProbe.kt'), local('EmbeddedSourceConsumer.kt')];
const common = [...config.commonSources, portableSource, commonLocation, reader, prepared.commonSources[1], ...shared, local('CommonSupport.kt')];
const bootstrap = await verifyBootstrap(), flagsBytes = await readRegular(path.join(HERE, '../../build-flags.json')), flags = JSON.parse(flagsBytes);
const run = promisify(execFile), commands = [];
async function execute(phase, executable, args) { console.log('phase: ' + phase); const result = await run(executable, args, { timeout: 240000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
    if (result.stderr) process.stderr.write(result.stderr); commands.push({ phase, command: [executable, ...args], exitCode: 0 }); return result.stdout; }
const java = ['-Xmx768m', '-cp', bootstrap.classPath];
const jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', flags.languageVersion,
    '-api-version', flags.apiVersion, ...flags.compilerFlags, '-classpath', bootstrap.classPath];
await execute('actual-source-configuration-jvm-build', 'java', [...jvm, '-d', local('original.jar'), ...originals, originalLocation, local('OriginalRequestSourceContent.kt'), ...shared, local('OriginalSupport.kt'), local('JvmEntry.kt')]);
await execute('common-source-configuration-jvm-build', 'java', [...jvm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-d', local('portable.jar'), ...common, local('JvmEntry.kt')]);
async function observeJvm(name, argument = []) { return execute(name + '-observe', 'java', ['-ea', '-cp', [local(name === 'actual-jvm' ? 'original.jar' : 'portable.jar'), bootstrap.classPath].join(path.delimiter), 'org.jetbrains.kotlin.js.sourcecontentprobe.JvmEntryKt', ...argument]); }
const original = JSON.parse(await observeJvm('actual-jvm')), portable = JSON.parse(await observeJvm('common-jvm'));
assert.deepEqual(portable.records, original.records);
await writeJson(local('original-jvm.json'), original); await writeJson(local('portable-jvm.json'), portable);
const originalRaw = (await observeJvm('actual-jvm', ['raw'])).trim(), portableRaw = (await observeJvm('common-jvm', ['raw'])).trim();
assert.equal(originalRaw, '0061003f0062003f0063'); assert.equal(portableRaw, '0061d8000062dc000063');
await mkdir(local('klib')); await mkdir(local('wasm'));
const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-language-version', flags.languageVersion,
    '-api-version', flags.apiVersion, ...flags.compilerFlags, '-libraries', bootstrap.wasmJsStdlib];
await execute('common-source-provider-wasm-klib', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-ir-output-dir', local('klib'), '-ir-output-name', 'source-content', ...common, local('WasmEntry.kt')]);
await execute('common-source-provider-wasm-module', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + local('klib/source-content.klib'), '-ir-output-dir', local('wasm'), '-ir-output-name', 'js-ast', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const loader = pathToFileURL(local('wasm/js-ast.mjs')).href;
const node = JSON.parse(await execute('common-source-provider-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e', 'const module=await import(process.argv[1]);console.log(module.astProbeJson());', loader]));
assert.deepEqual(node.records, original.records); await writeJson(local('portable-wasm.json'), node);
const nodeRaw = (await execute('common-source-provider-node-wasm-rawtext', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e', 'const module=await import(process.argv[1]);console.log(module.rawTextProbe());', loader])).trim(); assert.equal(nodeRaw, portableRaw);
const browser = await observeAstInChromium(output, original.records); assert.equal(browser.observation.rawText, portableRaw);
await writeFile(local('portable-chromium.json'), browser.raw, { flag: 'wx', mode: 0o600 });
const outputs = [];
async function collect(directory) { for (const item of await readdir(local(directory), { withFileTypes: true })) { const name = directory ? directory + '/' + item.name : item.name;
    if (item.isDirectory()) await collect(name); else { const bytes = await readRegular(local(name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); } } }
await collect('');
const receipt = { schemaVersion: 1, kind: 'request-source-content-actual-configuration-host-profile', source: lock.source,
    sourceLockSha256: sha256(lockBytes), checkToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), buildFlagsSha256: sha256(flagsBytes),
    preparation: prepared.receipt, configuration: config.receipt, sourceHost: host.receipt, commands, outputs,
    sourceProjection: { interfaceSha256: sha256(Buffer.from(sourceProjection)), exactUpstreamSections: ['KtSourceFile', 'KtInMemoryTextSourceFile'],
        originalTextBoundary: 'Actual original KtSourceFile UTF8 stream read; common request retains already snapshotted raw String.' },
    consumerProjection: { sha256: sha256(Buffer.from(consumerProjection)), changes: 'Only test method visibility and JsGenerationContext configuration expression bound to actual CompilerConfiguration parameter; shipping body keeps actual context API.' },
    comparison: { observations: original.records.length, originalJvmEqualsCommonJvm: true, originalJvmEqualsNodeWasm: true, originalJvmEqualsOfflineChromium: true, skipped: 0 },
    rawClosedFailures: { originalJvm: original.failures, commonJvm: portable.failures, nodeWasm: node.failures, offlineChromium: browser.observation.failures },
    rawUnpairedSurrogateBoundary: { originalJvmStream: originalRaw, commonJvmRawText: portableRaw, nodeWasmRawText: nodeRaw, offlineChromiumRawText: browser.observation.rawText,
        equal: false, intentional: 'Raw request String preserves unpaired UTF16 units. The genuine original UTF8 file/stream path replaces them with U+003F; this difference is retained, not counted as parity.' },
    browser: browser.receipt, sourceRegistryInstalledInEntry: false, fullJsAstUtilsBuilt: false, sourceMapBuilderBuilt: false, fullCompilerBuilt: false, languageReadiness: false };
await writeJson(local('receipt.json'), receipt); console.log(JSON.stringify({ output, comparison: receipt.comparison, rawBoundaryEqual: false }));
