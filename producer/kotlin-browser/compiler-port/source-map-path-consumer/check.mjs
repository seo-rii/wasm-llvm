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
import { prepareSourceMapBuilder, verifySourceMapBuilder } from '../source-map-builder-kernel/prepare.mjs';
import { prepareConfigurationSources } from '../config/prepare.mjs';
import { prepareSourceMapPaths, verifySourceMapPaths } from './prepare.mjs';
import { verifySourceMapPathFinalSources } from './final.mjs';
import { verifyRuntimePathComposition } from './runtime-composition.mjs';
import { BUILDER, CONSUMER as MAPPING } from '../source-map-builder-kernel/transform.mjs';
import { RELATIVE, RESOLVER, CONSUMER, PREFIX, INFO, OUTLINING, GENERATOR } from './transform.mjs';
import {projectSourceMapsInfo,projectSourceMapKeys,projectOutliningPrint} from './project-callers.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources'), parent = path.join(REPO, 'out/kotlin-source-map-path-consumer');
await mkdir(parent, { recursive: true, mode: 0o700 });
const output = await mkdtemp(path.join(parent, 'run-')), local = name => path.join(output, name);
const options = { sourceRoot, outputRoot: local('paths') }, prepared = await prepareSourceMapPaths(options);
await verifySourceMapPaths({ ...options, receiptPath: prepared.receiptPath });
const kernel = await prepareSourceMapBuilder({sourceRoot,outputRoot:local('kernel')});await verifySourceMapBuilder({sourceRoot,outputRoot:local('kernel'),receiptPath:kernel.receiptPath});
const config = await prepareConfigurationSources({sourceRoot,outputRoot:local('configuration')});
const retainedSources=[...prepared.receipt.files.map((pin,index)=>({...pin,filename:prepared.commonSources[index],compile:true})),...kernel.receipt.files.map((pin,index)=>({...pin,filename:kernel.commonSources[index],compile:true}))];

const runtimeComposition=await verifyRuntimePathComposition({pathComponent:prepared,kernelComponent:kernel,outputRoot:local('runtime-composition')});
const finalSelection={receipt:runtimeComposition.sourceMapPathFinal};
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
    const support = verifyFile(await readRegular(path.join(HERE, name)), lock.observers.find(pin => pin.path === name)).toString().replaceAll("__CURRENT_DIRECTORY__",REPO).replace(/^(package[^\n]*\n)/, '$1' + imports + '\n');
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
const oracleVersion = await execute('jvm-runtime-version', 'java', ['--version']);
assert(oracleVersion.startsWith('openjdk 17.0.20.1 '),'This profile pins JDK17.0.20.1 POSIX File semantics.'); await writeFile(local('JvmVersion.txt'), oracleVersion, { flag: 'wx', mode: 0o600 });
const compilerPin = bootstrap.artifacts.find(pin => pin.id === 'compiler'), stdlib = bootstrap.artifacts.find(pin => pin.id === 'stdlib-jvm').path;
const annotations = bootstrap.artifacts.find(pin => pin.id === 'annotations').path;
const fastutil = JSON.parse(await execute('extract-pinned-genuine-fastutil', 'python3', [path.join(HERE, '../source-map-builder-kernel/extract-fastutil.py'), compilerPin.path, local('fastutil.jar')]));
assert(fastutil.classes.length > 0 && fastutil.classes.every(pin => pin.path.startsWith('org/jetbrains/kotlin/it/unimi/dsi/fastutil/')));
assert.equal(fastutil.compilerAstClassesExtracted, false); await writeJson(local('fastutil.json'), { ...fastutil, archive: compilerPin });
const originals = [];
for (const pin of [...lock.sources.filter(pin => [RELATIVE,RESOLVER,CONSUMER].includes(pin.path)),...JSON.parse(await readRegular(path.join(HERE,"../source-map-builder-kernel/sources.lock.json"))).sources]) {
    const original = verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin);
    const filename = local('original-inputs/' + pin.path); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, original, { flag: 'wx', mode: 0o600 });
    if (pin.path === BUILDER) {
        const code = original.toString(); const from = 'import it.unimi.dsi.fastutil.objects.Object2IntOpenHashMap'; assert.equal(code.split(from).length, 2);
        const oracle = local('OriginalSourceMap3Builder.kt');
        await writeFile(oracle, code.replace(from, 'import org.jetbrains.kotlin.it.unimi.dsi.fastutil.objects.Object2IntOpenHashMap'), { flag: 'wx', mode: 0o600 }); originals.push(oracle);
    } else if ([RELATIVE,RESOLVER,CONSUMER].includes(pin.path)) { originals.push(filename);
    }
}
await mkdir(local('original-java'), { mode: 0o700 });
await execute('actual-original-mapping-interface-javac', 'javac', ['-cp', annotations, '-d', local('original-java'), local('original-inputs/' + MAPPING)]);
const jsonLock = JSON.parse(await readRegular(path.join(HERE, '../source-map-json/sources.lock.json')));
originals.push(path.join(jsonReferences.sourceRoot, jsonLock.sources.find(pin => pin.path.endsWith('/JSON.kt')).path));
const helperPin=lock.referenceDependencies.find(pin=>pin.path.endsWith('/addToStdlib.kt'));const helperText=verifyFile(await readRegular(path.join(sourceRoot,helperPin.path)),helperPin).toString();
const a=helperText.indexOf('fun <T, A : Appendable> Iterable<T>.joinToWithBuffer('),b=helperText.indexOf('\nfun String.countOccurrencesOf(',a);assert(a>=0&&b>a);
const runStart=helperText.indexOf('inline fun <R> runIf('),runEnd=helperText.indexOf('\ninline fun <R> runUnless(',runStart);assert(runStart>=0&&runEnd>runStart);
const pop='fun <E> MutableList<E>.popLast(): E = removeAt(lastIndex)';assert.equal(helperText.split(pop).length,2);
const join=local('CollectionHelpers.kt');await writeFile(join,helperText.slice(0,helperText.indexOf('@file:'))+'@file:OptIn(kotlin.contracts.ExperimentalContracts::class,kotlin.contracts.ExperimentalExtendedContracts::class)\npackage org.jetbrains.kotlin.utils.addToStdlib\nimport kotlin.contracts.*\n'+helperText.slice(a,b)+helperText.slice(runStart,runEnd)+pop+'\n',{flag:'wx',mode:0o600});originals.push(join);
const callerOriginal=[],callerCommon=[];
for(const commonVariant of [false,true]){
    const target=commonVariant?callerCommon:callerOriginal;
    const infoPin=lock.sources.find(pin=>pin.path===INFO),outlinePin=lock.sources.find(pin=>pin.path===OUTLINING),generatorPin=lock.sources.find(pin=>pin.path===GENERATOR);
    const infoBytes=commonVariant?await readRegular(path.join(local('paths'),PREFIX+INFO)):verifyFile(await readRegular(path.join(sourceRoot,INFO)),infoPin);
    const outlineBytes=commonVariant?await readRegular(path.join(local('paths'),PREFIX+OUTLINING)):verifyFile(await readRegular(path.join(sourceRoot,OUTLINING)),outlinePin);
    for(const [name,bytes]of [['SourceMapsInfo.kt',projectSourceMapsInfo(infoBytes)],['OutliningPrint.kt',projectOutliningPrint(outlineBytes,commonVariant)]]){const filename=local((commonVariant?'common-callers/':'original-callers/')+name);await mkdir(path.dirname(filename),{recursive:true,mode:0o700});await writeFile(filename,bytes,{flag:'wx',mode:0o600});target.push(filename);}
    target.push(commonVariant?path.join(local('paths'),PREFIX+GENERATOR):path.join(sourceRoot,GENERATOR));
    for(const pin of lock.referenceDependencies.filter(pin=>pin.path.includes('/js.config/')||pin.path.startsWith('wasm/wasm.ir/'))){const original=verifyFile(await readRegular(path.join(sourceRoot,pin.path)),pin);let bytes=pin.path.endsWith('/JSConfigurationKeys.kt')?projectSourceMapKeys(original,commonVariant):original;if(commonVariant&&pin.path.endsWith('/DebugInfo.kt'))bytes=Buffer.from(bytes.toString().replace('package org.jetbrains.kotlin.wasm.ir.debug','package org.jetbrains.kotlin.wasm.ir.debug\nimport kotlin.jvm.JvmInline'));const filename=local((commonVariant?'common-callers/':'original-callers/')+path.basename(pin.path));await mkdir(path.dirname(filename),{recursive:true,mode:0o700});await writeFile(filename,bytes,{flag:'wx',mode:0o600});target.push(filename);}
}
originals.push(...callerOriginal,...config.commonSources);
const originalAst = [path.join(baseline, 'original-java'), path.join(baseline, 'original-kotlin.jar'), path.join(baseline, 'oracle-dependencies.jar')];
const java = ['-Xmx768m', '-cp', bootstrap.classPath], jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17',
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
const originalClasspath = [local('original-java'), ...originalAst, local('fastutil.jar'), stdlib, annotations].join(path.delimiter);
await execute('actual-original-builder-jvm-build', 'java', [...jvm, '-classpath', originalClasspath, '-d', local('original.jar'), ...originals, local('OriginalProbe.kt'), local('JvmEntry.kt')]);
const readerBytecode = await execute('actual-stdlib-reader-bytecode', 'javap', ['-c', '-p', '-classpath', stdlib, 'kotlin.io.TextStreamsKt', 'kotlin.io.CloseableKt', 'kotlin.ExceptionsKt__ExceptionsKt']);
assert(readerBytecode.includes('sipush        8192') && readerBytecode.includes('iflt') && readerBytecode.includes('closeFinally') && readerBytecode.includes('if_acmpeq'));
await writeFile(local('OriginalReaderBytecode.txt'), readerBytecode, { flag: 'wx', mode: 0o600 });
const pathCommon=prepared.commonSources.filter(name=>[RELATIVE,RESOLVER,CONSUMER].some(logical=>name.endsWith('/'+logical))||name.endsWith('/SourceMapPathHost.kt'));assert.equal(pathCommon.length,4);
const hostProbe=local('HostContractProbe.kt');await writeFile(hostProbe,verifyFile(await readRegular(path.join(HERE,'HostContractProbe.kt')),lock.observers.find(pin=>pin.path==='HostContractProbe.kt')),{flag:'wx',mode:0o600});
const common=[hostProbe,join,...callerCommon,...pathCommon,...kernel.commonSources,...ast.commonSources,...ast.dependencySources,...config.commonSources,...json.commonSources,...io.commonSources,...utf8,sink,local('CommonProbe.kt')];
await execute('common-full-ast-builder-jvm-build', 'java', [...jvm, '-classpath', stdlib, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-d', local('portable.jar'), ...common, local('JvmEntry.kt')]);
const original = JSON.parse(await execute('actual-original-builder-observe', 'java', ['-ea', '-Dfile.encoding=UTF-8', '-cp', [local('original.jar'), originalClasspath].join(path.delimiter), 'org.jetbrains.kotlin.js.sourcemappathprobe.JvmEntryKt']));
const portable = JSON.parse(await execute('common-full-ast-builder-observe', 'java', ['-ea', '-cp', [local('portable.jar'), stdlib].join(path.delimiter), 'org.jetbrains.kotlin.js.sourcemappathprobe.JvmEntryKt']));
await writeJson(local('original-jvm.json'), original); await writeJson(local('portable-jvm.json'), portable);
function compare(actual, host) {
    assert.deepEqual(actual.malformedContracts,original.malformedContracts);assert.equal(actual.rawFailures.length,original.rawFailures.length);
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
await writeJson(local('portable-wasm.json'), node); compare(node, 'Node Wasm');assert.equal(original.hostContracts.length,0);assert.equal(portable.hostContracts.length,7);assert.deepEqual(node.hostContracts,portable.hostContracts);
const browser = await observeAstInChromium(output, original.records); await writeFile(local('portable-chromium.json'), browser.raw, { flag: 'wx', mode: 0o600 });
assert.deepEqual(browser.observation.hostContracts,portable.hostContracts);assert.deepEqual(browser.observation.malformedContracts,original.malformedContracts);assert.equal(browser.observation.rawFailures.length,original.rawFailures.length);
const outputs = []; async function collect(directory) {
    for (const entry of await readdir(local(directory), { withFileTypes: true })) {
        const name = directory ? directory + '/' + entry.name : entry.name;
        if (entry.isDirectory()) await collect(name); else { const bytes = await readRegular(local(name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
    }
} await collect('');
const receipt = { schemaVersion: 1, kind: 'genuine-source-map-path-consumer-full-ast-four-host-profile', source: lock.source, sourceLockSha256: sha256(lockBytes),
    checkToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), buildFlagsSha256: sha256(flagsBytes), preparation: prepared.receipt, finalSelection:finalSelection.receipt,runtimeComposition, commands, outputs, oracleVersion,
    originalAstEvidenceSha256: sha256(await readRegular(path.join(HERE, '../js-ast/evidence/receipt.json'))), fastutil,
    oracleFastutilArchive: { id: compilerPin.id, bytes: compilerPin.bytes, sha256: compilerPin.sha256, importRelocationOnly: true },
    comparison: { observations: original.records.length, originalJvmEqualsCommonJvm: true, originalJvmEqualsNodeWasm: true, originalJvmEqualsOfflineChromium: true,
        skipped: 0, normalization: false, recordsSha256: sha256(Buffer.from(JSON.stringify(original.records))) },
    requestHostContract:{observations:portable.hostContracts.length,commonJvmEqualsNodeWasm:true,commonJvmEqualsOfflineChromium:true,originalGlobalNativeParity:false},
    malformedContract:{observations:original.malformedContracts.length,exactAcrossHosts:true},rawMalformedExceptionObservations: { originalJvm: original.rawFailures, commonJvm: portable.rawFailures, nodeWasm: node.rawFailures, offlineChromium: browser.observation.rawFailures },
    browser: browser.receipt, pathHostContract: lock.hostContract, diagnosticProtocol: 'Required banner then throwable reporting; controlled genuine-JVM throwable override observes order, identity and real byte effects.',
    nativeExceptionRepresentationParity:false,nativeStacktraceTextParity: false, originalGlobalStderrParity: false, callerIntegrated: false, fullWasmSourceMapGeneratorExecuted:true, sourceMapsInfoClassExecuted:true, jsOutliningPrintMethodExecuted:true, fullJsOutliningClassExecuted:false, sourceMapsInfoContextExtensionExecuted:false, generalNativeFileConfiguration:false, pathResolverBuilt: true, fullCompilerBuilt: false, languageReadiness: false };
await writeJson(local('receipt.json'), receipt); console.log(JSON.stringify({ output, comparison: receipt.comparison, fastutilClasses: fastutil.classes.length }));
