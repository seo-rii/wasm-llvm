import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareIdentitySources } from '../identity/prepare.mjs';
import { prepareCompilerTextSources } from '../text/prepare.mjs';
import { prepareWasmCollectionsSources } from '../wasm-collections/prepare.mjs';
import { generateFingerprints } from '../fingerprints/generate.mjs';
import { loadRetainedBuild } from '../fir-navigation/probe.mjs';
import { prepareWasmCollectionConsumers, verifyWasmCollectionConsumers } from './prepare.mjs';
import { CONTEXT, FRAGMENT, REVERSE_ORIGINAL } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..'), execute = promisify(execFile);

function selected(text, start, end) {
    assert.equal(text.split(start).length, 2); const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
    assert(b > a); return text.slice(a, b);
}

// The map owner and signature are an explicit generic probe boundary. The genuine
// WasmFunctionType and all selected loop/encoding bodies are compiled unchanged.
export function projectConsumerBoundaries(fragment, context, portable) {
    const mapBody = selected(fragment.toString(), '        val reversedFunctionTypeMap = ', '        val heapTypeResolver:');
    const tagBody = selected(context.toString(), 'private const val ENCODE_BYTE_COUNT', 'open class WasmTypeCodegenContext(');
    const hashLine = selected(fragment.toString(), '            val signatureHash = cityHash128(signatureString.toByteArray())', '\n');
    assert.equal(hashLine, '            val signatureHash = cityHash128(signatureString.toByteArray())');
    const declarationExpression = 'encode63BitsToUtf8String(cityHash64(referenceString.toByteArray()))'; assert(context.includes(Buffer.from(declarationExpression)));
    const prefix = fragment.toString().split('package ')[0] + 'package org.jetbrains.kotlin.portable.wasmconsumers.probe\n\n' +
        'import org.jetbrains.kotlin.wasm.ir.*\nimport org.jetbrains.kotlin.backend.common.serialization.*\n' +
        (portable ? 'import org.jetbrains.kotlin.portable.text.compilerUtf8Bytes as toByteArray\nimport org.jetbrains.kotlin.portable.text.compilerUtf8String\n' :
            'import org.jetbrains.kotlin.portable.wasmconsumers.probe.declaredReverseSelected as reverse\n') + '\n';
    const source = prefix +
        REVERSE_ORIGINAL.replace('.reverse()', '.declaredReverseSelected()').replace('(k, v)', '[k, v]') + '\n\n' +
        'fun <K> canonicalizeSelected(allFunctionTypes: MutableMap<K, WasmFunctionType>) {\n' + mapBody + '}\n\n' + tagBody +
        'fun encodeSelected(value: ULong): String = encode63BitsToUtf8String(value)\n' +
        'fun declarationTagSelected(referenceString: String): String = ' + declarationExpression + '\n' +
        'fun hash128Selected(signatureString: String): Hash128Bits {\n' + hashLine + '\n    return signatureHash\n}\n' +
        'fun stringBytesSelected(value: String): ByteArray = value.toByteArray()\n' +
        'fun byteListSelected(value: List<Byte>): ByteArray = value.toByteArray()\n';
    return { bytes: Buffer.from(source), boundaries: { mapLoop: { bytes: Buffer.byteLength(mapBody), sha256: sha256(Buffer.from(mapBody)) },
        tagDeclaration: { bytes: Buffer.byteLength(tagBody), sha256: sha256(Buffer.from(tagBody)) },
        hashLineSha256: sha256(Buffer.from(hashLine)), declarationExpressionSha256: sha256(Buffer.from(declarationExpression)),
        signatureReceiver: 'Explicit generic K map parameter; probe-only SignaturePayload on common/Wasm, genuine pinned IdSignature source objects on JVM',
        entireFragmentExecution: false, entireTypeContextExecution: false } };
}

export async function runWasmConsumerProbe({ outputRoot, sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources'),
    buildRoot = path.join(repository, 'out/kotlin-compiler-port/builds/common-boundaries-whole-1791635510943341799') }) {
    outputRoot = path.resolve(outputRoot); assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep)); await mkdir(outputRoot, { mode: 0o700 });
    const selectedBuild = await loadRetainedBuild(buildRoot);
    const identity = await prepareIdentitySources({ sourceRoot, outputRoot: path.join(outputRoot, 'identity') });
    const text = await prepareCompilerTextSources({ sourceRoot, outputRoot: path.join(outputRoot, 'text') });
    const collections = await prepareWasmCollectionsSources({ sourceRoot, outputRoot: path.join(outputRoot, 'collections'), preparedIdentity: identity, preparedText: text });
    const prepared = await prepareWasmCollectionConsumers({ sourceRoot, outputRoot: path.join(outputRoot, 'prepared'), preparedWasmCollections: collections, preparedText: text });
    const verified = await verifyWasmCollectionConsumers(prepared.outputRoot);
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes), originals = new Map();
    for (const entry of [...lock.sources, ...lock.probeTypes, ...lock.probeHash.originals, lock.probeSignature, lock.probeResolver, lock.probeBuildDeclaration])
        originals.set(entry.path, verifyFile(await readRegular(path.join(sourceRoot, entry.path)), entry));
    assert(originals.get(lock.probeResolver.path).includes(Buffer.from('val functionTypes: MutableMap<IdSignature, WasmFunctionType> = mutableMapOf()')));
    assert(originals.get(lock.probeTypes[0].path).includes(Buffer.from('data class WasmFunctionType(\n    val parameterTypes: List<WasmType>,\n    val resultTypes: List<WasmType>\n) : WasmTypeDeclaration("")')));
    const hashCommon = generateFingerprints(originals).get(lock.probeHash.output.path);
    assert.equal(hashCommon.length, lock.probeHash.output.bytes); assert.equal(sha256(hashCommon), lock.probeHash.output.sha256);
    const bootstrap = await verifyBootstrap(), flagsBytes = await readRegular(path.join(here, '../build-flags.json')), flags = JSON.parse(flagsBytes);
    const stdlib = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path, commands = [], artifacts = [], sources = { original: [], common: [] }, projections = [];
    async function put(relative, bytes) { const filename = path.join(outputRoot, relative); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename; }
    async function run(phase, command, args, cwd = outputRoot) {
        console.log('phase: ' + phase); const start = performance.now();
        try { const result = await execute(command, args, { cwd, timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
            commands.push({ phase, command: [command, ...args], exitCode: 0, elapsedMs: performance.now() - start });
            if (result.stderr) process.stderr.write(result.stderr); return result.stdout;
        } catch (error) { await writeJson(path.join(outputRoot, 'failure.json'), { phase, exitCode: error.code, commands, stderr: String(error.stderr ?? '').slice(-16384) });
            if (error.stderr) process.stderr.write(String(error.stderr).slice(-16384)); throw new Error(phase + ' failed'); }
    }
    for (const variant of ['original', 'common']) {
        for (const entry of lock.probeTypes) {
            let bytes = originals.get(entry.path);
            if (variant === 'common' && entry.path.endsWith('/WasmExpressionBuilder.kt')) {
                const marker = 'package org.jetbrains.kotlin.wasm.ir\n'; assert.equal(bytes.toString().split(marker).length, 2);
                bytes = Buffer.from(bytes.toString().replace(marker, marker + '\nimport org.jetbrains.kotlin.portable.assertions.compilerAssert as assert\n'));
            }
            sources[variant].push(await put(variant + '/' + entry.path, bytes));
        }
        for (const entry of lock.probeWriter.sources) sources[variant].push(await put(variant + '/' + entry.path,
            verifyFile(await readRegular(path.join(sourceRoot, entry.path)), { ...entry, gitBlob: entry.gitBlobSha1 })));
        const fragment = variant === 'common' ? await readRegular(prepared.commonSources.find(file => file.endsWith('/' + FRAGMENT))) : originals.get(FRAGMENT);
        const context = variant === 'common' ? await readRegular(prepared.commonSources.find(file => file.endsWith('/' + CONTEXT))) : originals.get(CONTEXT);
        const projection = projectConsumerBoundaries(fragment, context, variant === 'common');
        sources[variant].push(await put(variant + '/SelectedConsumerBoundaries.kt', projection.bytes));
        projections.push({ variant, bytes: projection.bytes.length, sha256: sha256(projection.bytes), boundaries: projection.boundaries });
        sources[variant].push(await put(variant + '/CityHash.kt', variant === 'common' ? hashCommon : originals.get(lock.probeHash.originals[0].path)));
    }
    const writerRoot = path.resolve(here, '../../writer-probe'), patch = path.join(writerRoot, 'writer-portable.patch');
    assert.equal(sha256(await readRegular(path.join(writerRoot, 'sources.lock.json'))), lock.probeWriter.sourceLockSha256);
    assert.equal(sha256(await readRegular(patch)), lock.probeWriter.patchSha256);
    for (const args of [['apply', '--check'], ['apply'], ['apply', '--reverse', '--check']])
        await run('verified-genuine-bytewriter-probe-dependency', 'git', [...args, patch], path.join(outputRoot, 'common'));
    for (const entry of lock.probeWriter.sources) { const bytes = await readRegular(path.join(outputRoot, 'common', entry.path));
        assert.equal(bytes.length, entry.portableBytes); assert.equal(sha256(bytes), entry.portableSha256); }
    const sink = await readRegular(path.join(writerRoot, 'BoundedByteSink.kt')); assert.equal(sha256(sink), lock.probeWriter.sinkSha256);
    sources.common.push(await put('common/BoundedByteSink.kt', sink));
    const assertions = await readRegular(path.resolve(here, lock.probeAssertionHelper.path));
    assert.equal(assertions.length, lock.probeAssertionHelper.bytes); assert.equal(sha256(assertions), lock.probeAssertionHelper.sha256);
    sources.common.push(await put('common/CompilerAssertions.kt', assertions));
    sources.common.push(...prepared.sharedDependencies.map(item => item.filename));
    const observer = await put('Probe.kt', await readRegular(path.join(here, 'Probe.kt'))), entry = await put('JvmEntry.kt', await readRegular(path.join(here, 'JvmEntry.kt')));
    const java = ['-Xmx768m', '-cp', bootstrap.classPath];
    const jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17',
        '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
    for (const variant of ['original', 'common']) {
        const args = variant === 'common' ? ['-Xmulti-platform', '-Xcommon-sources=' + [...sources.common, observer].join(',')] : [];
        await run(variant + '-actual-wasm-types-selected-bodies-jvm-build', 'java', [...jvm, '-classpath', bootstrap.classPath, ...args,
            '-d', path.join(outputRoot, variant + '.jar'), ...sources[variant], observer, entry]);
    }
    // The relocated Kotlin helper's metadata retains the upstream package name.
    // A direct Java static call observes its actual bytecode without inventing
    // Kotlin package metadata or replacing the dependency implementation.
    const helperBridge = await put('actual/BootstrapReverse.java', Buffer.from(
        'package org.jetbrains.kotlin.portable.wasmconsumers.probe;\n' +
        'public final class BootstrapReverse {\n' +
        '    public static <K, V> java.util.Map<V, K> apply(java.util.Map<K, V> input) {\n' +
        '        return org.jetbrains.kotlin.com.intellij.util.containers.UtilKt.reverse(input);\n' +
        '    }\n}\n'));
    const helperClasses = path.join(outputRoot, 'actual-classes'); await mkdir(helperClasses, { mode: 0o700 });
    await run('direct-genuine-bootstrap-reverse-static-call-javac', 'javac', ['-classpath', bootstrap.classPath, '-d', helperClasses, helperBridge]);
    const actualSignature = await put('actual/IdSignature.kt', originals.get(lock.probeSignature.path));
    const actualObserver = await put('actual/JvmGenuine.kt', await readRegular(path.join(here, 'JvmGenuine.kt')));
    await run('pinned-complete-idsignature-genuine-object-jvm-build', 'java', [...jvm, '-classpath', [helperClasses, path.join(outputRoot, 'original.jar'), bootstrap.classPath].join(path.delimiter),
        '-d', path.join(outputRoot, 'genuine.jar'), actualSignature, actualObserver]);
    const raw = {}, actual = {};
    for (const variant of ['original', 'common']) {
        raw[variant] = await run(variant + '-selected-body-jvm-observe', 'java', ['-ea', '-cp', path.join(outputRoot, variant + '.jar') + path.delimiter + bootstrap.classPath,
            'org.jetbrains.kotlin.portable.wasmconsumers.probe.JvmEntryKt']);
        actual[variant] = await run(variant + '-genuine-idsignature-bootstrap-helper-jvm-observe', 'java', ['-ea', '-cp',
            [helperClasses, path.join(outputRoot, 'genuine.jar'), path.join(outputRoot, variant + '.jar'), bootstrap.classPath].join(path.delimiter),
            'org.jetbrains.kotlin.portable.wasmconsumers.probe.JvmGenuineKt']);
    }
    assert.equal(raw.common, raw.original, 'Selected original/common JVM raw observations differ');
    assert.equal(actual.common, actual.original, 'Genuine JVM object canonicalization differs');
    for (const name of ['klib', 'wasm']) await mkdir(path.join(outputRoot, name), { mode: 0o700 });
    const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-libraries', bootstrap.wasmJsStdlib,
        '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
    await run('common-selected-bodies-actual-wasm-types-wasmjs-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + [...sources.common, observer].join(','),
        '-ir-output-dir', path.join(outputRoot, 'klib'), '-ir-output-name', 'wasm-consumers', ...sources.common, observer, path.join(here, 'WasmEntry.kt')]);
    await run('common-selected-bodies-wasmjs-module-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/wasm-consumers.klib'),
        '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'wasm-consumers', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
    raw.wasm = await run('common-selected-bodies-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
        'const m=await import(process.argv[1]);process.stdout.write(m.wasmConsumerProbe());', pathToFileURL(path.join(outputRoot, 'wasm/wasm-consumers.mjs')).href]);
    assert.equal(raw.wasm, raw.original, 'Selected original/Node Wasm raw observations differ');
    for (const [name, bytes] of Object.entries({ 'original.txt': Buffer.from(raw.original), 'common-jvm.txt': Buffer.from(raw.common), 'common-wasm.txt': Buffer.from(raw.wasm),
        'genuine-original.txt': Buffer.from(actual.original), 'genuine-common.txt': Buffer.from(actual.common) })) await put(name, bytes);
    const ids = raw.original.trimEnd().split('\n').map(line => line.split('\t')[0]); assert.equal(new Set(ids).size, ids.length);
    for (const relative of ['original.jar', 'common.jar', 'genuine.jar', 'original.txt', 'common-jvm.txt', 'common-wasm.txt', 'genuine-original.txt', 'genuine-common.txt',
        'actual-classes/org/jetbrains/kotlin/portable/wasmconsumers/probe/BootstrapReverse.class',
        'klib/wasm-consumers.klib', ...(await readdir(path.join(outputRoot, 'wasm'))).sort().map(name => 'wasm/' + name)]) {
        const bytes = await readRegular(path.join(outputRoot, relative)); artifacts.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const sourceArtifacts = [];
    for (const filename of [...new Set([...sources.original, ...sources.common, observer, entry, helperBridge, actualSignature, actualObserver, path.join(here, 'WasmEntry.kt')])]) {
        const bytes = await readRegular(filename); sourceArtifacts.push({ filename, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const receipt = { schemaVersion: 1, kind: 'official-wasm-collection-consumer-bounded-differential', result: 'pass', source: lock.source,
        sourceLockSha256: sha256(lockBytes), preparationReceiptSha256: verified.receiptSha256, preparation: prepared.receipt,
        selectedFailureGraph: selectedBuild.evidence, callerBuildDeclaration: lock.probeBuildDeclaration, mapOwnerDeclaration: lock.probeResolver,
        reverse: { ...lock.reverse, officialDeclaredSourceBodyExecuted: true, bootstrapHelperComparedOnGenuineObjects: true,
            bootstrapIntellijSourceCommit: null, bootstrapIntellijVersion: 'unverified; helper behavior compared, not claimed as declared dependency artifact' },
        commonTypeSources: lock.probeTypes, genuineJvmSignature: lock.probeSignature, projections,
        comparison: { observations: ids.length, genuineJvmObservations: actual.original.trimEnd().split('\n').length,
            originalJvmEqualsCommonJvm: true, originalJvmEqualsNodeWasm: true, genuineJvmCanonicalIdentityEquals: true, normalizedText: false,
            contracts: ['Structural equality and entry-order last-wins signature', 'Surviving actual WasmFunctionType canonical identity and unchanged map order',
                'Exact nine-byte low-63-bit ASCII loop', 'Malformed UTF16 String bytes, full real CityHash64/128 and declaration tag', 'String extension/List<Byte> overload selection'],
            entireFragmentAndContextExecution: false, signatureGraphOnWasm: 'Explicit SignaturePayload fixture, not full IdSignature graph' },
        dependencyAdaptations: 'Only previously verified bytewriter patch, existing common assertions import, full existing generated CityHash and shared UTF8 sources; original full Wasm value types retained',
        commands, artifacts, sourceArtifacts, flagsSha256: sha256(flagsBytes), observerPins: await Promise.all(['probe.mjs', 'Probe.kt', 'JvmGenuine.kt', 'JvmEntry.kt', 'WasmEntry.kt'].map(async filename => {
            const bytes = await readRegular(path.join(here, filename)); return { path: filename, bytes: bytes.length, sha256: sha256(bytes) }; })),
        bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
        browserExecuted: false, fullCompilerBuilt: false, publicLanguageSupport: false };
    await writeJson(path.join(outputRoot, 'differential.json'), receipt);
    console.log(JSON.stringify({ outputRoot, result: receipt.result, comparison: receipt.comparison })); return { outputRoot, receipt, prepared };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    assert.equal(process.argv.length, 3, 'Usage: probe.mjs NEW_OUTPUT_ROOT');
    await runWasmConsumerProbe({ outputRoot: process.argv[2] });
}
