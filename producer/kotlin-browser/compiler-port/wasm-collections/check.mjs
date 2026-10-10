#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareIdentitySources } from '../identity/prepare.mjs';
import { prepareCompilerTextSources } from '../text/prepare.mjs';
import { prepareWasmCollectionsSources } from './prepare.mjs';
import { FRAGMENT, CONTEXT, WRITER, REPLACEMENTS, transformWasmCollections } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);

function selectSlices(lock, originals, portable) {
    const selected = new Map();
    for (const pin of lock.probeSlices) {
        const text = originals.get(pin.path).toString(); const start = text.indexOf(pin.start), end = text.indexOf(pin.end, start + pin.start.length);
        assert(start >= 0 && end > start); const original = Buffer.from(text.slice(start, end));
        assert.equal(original.length, pin.bytes); assert.equal(sha256(original), pin.sha256, 'Selected probe body changed');
        const transformed = portable && [FRAGMENT, CONTEXT, WRITER].includes(pin.path) ? transformWasmCollections(pin.path, originals.get(pin.path)).toString() : text;
        const a = transformed.indexOf(pin.start), b = transformed.indexOf(pin.end, a + pin.start.length);
        assert(a >= 0 && b > a); selected.set(pin.id, transformed.slice(a, b));
    }
    return selected;
}

export function generateObservers(lock, originals, portable) {
    const snippets = selectSlices(lock, originals, portable);
    const header = originals.get(WRITER).toString().split('package ')[0];
    const prefix = header + 'package org.jetbrains.kotlin.portable.wasmcollections.probe\n\n' +
        'import kotlin.jvm.JvmInline\nimport org.jetbrains.kotlin.wasm.ir.*\n' +
        'import org.jetbrains.kotlin.wasm.ir.WasmBinaryData.Companion.toByteArray\n' +
        'import org.jetbrains.kotlin.wasm.ir.source.location.Box\n' +
        'import org.jetbrains.kotlin.backend.wasm.ir2wasm.LiteralGlobalSymbol\n' +
        (portable ? 'import org.jetbrains.kotlin.portable.text.compilerUtf8Bytes as toByteArray\n' : '') + '\n';
    const writer = prefix + snippets.get('binary') + snippets.get('annotations') + '\n' +
        'private class SelectedMetadataWriter {\n' +
        '    private val b = ByteWriterWithOffsetWrite()\n    private var codeSectionOffset = Box(0)\n' +
        '    private val resolvedAnnotationsByFunction = mutableListOf<FunctionResolvedAnnotations>()\n' +
        snippets.get('emit') + snippets.get('payload') + snippets.get('strings') +
        '    fun observe(input: List<MetadataAnnotation>): ByteArray {\n' +
        '        for (item in input) resolvedAnnotationsByFunction.add(FunctionResolvedAnnotations(item.functionIndex, listOf(ResolvedAnnotation(AnnotationKind.entries[item.kind], item.byteOffset, item.value))))\n' +
        '        emitCodeMetadataSections()\n        return b.getBinaryData().toByteArray()\n    }\n}\n' +
        'fun metadataBytes(input: List<MetadataAnnotation>): ByteArray = SelectedMetadataWriter().observe(input)\n';
    const context = originals.get(CONTEXT).toString();
    const contextOperation = REPLACEMENTS[CONTEXT][0][portable ? 1 : 0];
    assert(context.split(REPLACEMENTS[CONTEXT][0][0]).length === 3);
    const continuationOperation = REPLACEMENTS[FRAGMENT][0][portable ? 1 : 0];
    const maps = prefix +
        '// The map owners and signature keys here are observation fixtures, not compiler host replacements.\n' +
        'class FunctionTypeProbe {\n' +
        '    val values: MutableMap<ProbeSignature, WasmFunctionType> = mutableMapOf()\n' +
        '    private val wasmFileFragment = object { val definedFunctionTypes = values }\n' +
        '    private val definedDeclarations = object { val functionTypes = values }\n' +
        '    fun referenceWasmFunctionType(signature: ProbeSignature, wasmFunctionType: WasmFunctionType) { ' + contextOperation + ' }\n' +
        '    fun referenceWasmFunctionHeapType(signature: ProbeSignature, wasmFunctionType: WasmFunctionType) { ' + contextOperation + ' }\n' +
        '    fun registerContinuation(funTypeSignature: ProbeSignature, funType: WasmFunctionType) { ' + continuationOperation + ' }\n}\n' +
        'class LiteralProbe {\n' +
        '    val globalLiteralGlobals: MutableMap<String, WasmGlobal> = mutableMapOf()\n' +
        '    private val definedDeclarations = object { val globalLiteralGlobals = this@LiteralProbe.globalLiteralGlobals }\n' +
        '    var globalCounter = 0\n    var throwImport = false\n' +
        '    private val importedStringConstants: String get() = if (throwImport) throw IllegalStateException("import-factory-failed") else "string.constants"\n' +
        '    fun bind(symbols: List<LiteralGlobalSymbol>) {\n        globalCounter = 0\n' +
        '        val linkerData = object { val globalLiterals = symbols }\n' + snippets.get('literalLoop') + '    }\n}\n';
    const symbol = originals.get(FRAGMENT).toString().split('package ')[0] +
        'package org.jetbrains.kotlin.backend.wasm.ir2wasm\n\nimport org.jetbrains.kotlin.wasm.ir.WasmImmediate\n\n' + snippets.get('literalSymbol');
    return { writer: Buffer.from(writer), maps: Buffer.from(maps), symbol: Buffer.from(symbol) };
}

export async function checkWasmCollections({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep)); await assertNoSymlink(outputRoot);
    await mkdir(outputRoot, { mode: 0o700 });
    const preparedIdentity = await prepareIdentitySources({ sourceRoot, outputRoot: path.join(outputRoot, 'identity') });
    const preparedText = await prepareCompilerTextSources({ sourceRoot, outputRoot: path.join(outputRoot, 'text') });
    const prepared = await prepareWasmCollectionsSources({ sourceRoot, outputRoot: path.join(outputRoot, 'layer'), preparedIdentity, preparedText });
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
    const originals = new Map();
    for (const pin of [...lock.sources, ...lock.probeTypes]) originals.set(pin.path, verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin));
    const bootstrap = await verifyBootstrap(), commands = [], outputs = [], observers = [];
    async function run(phase, command, args, cwd = outputRoot) {
        console.log('phase: ' + phase);
        const result = await execute(command, args, { cwd, timeout: 240000, maxBuffer: 20 * 1024 * 1024 });
        if (result.stderr) process.stderr.write(result.stderr); commands.push({ phase, command: [command, ...args], exitCode: 0 }); return result.stdout;
    }
    for (const name of ['original', 'common', 'jvm', 'klib', 'wasm']) await mkdir(path.join(outputRoot, name));
    const writerHere = path.resolve(here, '../../writer-probe');
    assert.equal(sha256(await readRegular(path.join(writerHere, 'sources.lock.json'))), lock.writerDependency.sourceLockSha256);
    const allSources = { original: [], common: [] };
    async function store(variant, filename, bytes) {
        const destination = path.join(outputRoot, variant, filename); await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 }); allSources[variant].push(destination); outputs.push({ path: variant + '/' + filename, bytes: bytes.length, sha256: sha256(bytes) });
    }
    for (const variant of ['original', 'common']) {
        for (const pin of lock.writerDependency.sources) {
            const bytes = verifyFile(await readRegular(path.join(sourceRoot, pin.path)), { ...pin, gitBlob: pin.gitBlobSha1 });
            await store(variant, pin.path, bytes);
        }
        for (const pin of lock.probeTypes.filter(pin => !pin.path.endsWith('/WasmIrSymbols.kt'))) {
            let bytes = originals.get(pin.path);
            if (variant === 'common' && pin.path.endsWith('/WasmExpressionBuilder.kt')) {
                const marker = 'package org.jetbrains.kotlin.wasm.ir\n'; const text = bytes.toString(); assert.equal(text.split(marker).length, 2);
                bytes = Buffer.from(text.replace(marker, marker + '\nimport org.jetbrains.kotlin.portable.assertions.compilerAssert as assert\n'));
            }
            await store(variant, pin.path, bytes);
        }
        const generated = generateObservers(lock, originals, variant === 'common');
        for (const [name, bytes] of Object.entries(generated)) await store(variant, 'Selected' + name + '.kt', bytes);
    }
    const writerPatch = path.join(writerHere, 'writer-portable.patch');
    assert.equal(sha256(await readRegular(writerPatch)), lock.writerDependency.patchSha256);
    for (const args of [['apply', '--check'], ['apply'], ['apply', '--reverse', '--check']]) await run('verified-byte-writer-port', 'git', [...args, writerPatch], path.join(outputRoot, 'common'));
    for (const pin of lock.writerDependency.sources) {
        const bytes = await readRegular(path.join(outputRoot, 'common', pin.path)); assert.equal(bytes.length, pin.portableBytes); assert.equal(sha256(bytes), pin.portableSha256);
    }
    const sink = await readRegular(path.join(writerHere, 'BoundedByteSink.kt')); assert.equal(sha256(sink), lock.writerDependency.sinkSha256); await store('common', 'BoundedByteSink.kt', sink);
    const assertionHelper = await readRegular(path.resolve(here, lock.probeAssertionHelper.path));
    assert.equal(assertionHelper.length, lock.probeAssertionHelper.bytes); assert.equal(sha256(assertionHelper), lock.probeAssertionHelper.sha256);
    await store('common', 'CompilerAssertions.kt', assertionHelper);
    for (const filename of preparedText.commonSources.filter(filename => !/WasmIrTo(?:Binary|Text)\.kt$/.test(filename))) {
        allSources.common.push(filename);
        const bytes = await readRegular(filename); outputs.push({ path: path.relative(outputRoot, filename), bytes: bytes.length, sha256: sha256(bytes) });
    }
    for (const name of ['Probe.kt', 'JvmEntry.kt', 'WasmEntry.kt']) {
        const bytes = await readRegular(path.join(here, name)), filename = path.join(outputRoot, name); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        observers.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const probe = path.join(outputRoot, 'Probe.kt'), entry = path.join(outputRoot, 'JvmEntry.kt');
    const stdlib = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path;
    const java = ['-Xmx768m', '-cp', bootstrap.classPath];
    const jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', '2.5', '-api-version', '2.5', '-classpath', stdlib];
    const originalJar = path.join(outputRoot, 'jvm/original.jar'), commonJar = path.join(outputRoot, 'jvm/common.jar');
    await run('selected-original-jvm-build', 'java', [...jvm, '-d', originalJar, ...allSources.original, probe, entry]);
    const common = [...allSources.common, probe];
    await run('selected-common-jvm-build', 'java', [...jvm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-d', commonJar, ...common, entry]);
    const main = 'org.jetbrains.kotlin.portable.wasmcollections.probe.JvmEntryKt';
    const original = await run('selected-original-jvm-observe', 'java', ['-ea', '-cp', [originalJar, stdlib].join(path.delimiter), main]);
    const commonJvm = await run('selected-common-jvm-observe', 'java', ['-ea', '-cp', [commonJar, stdlib].join(path.delimiter), main]);
    assert(original === commonJvm, 'Original/common JVM raw observations differ');
    const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-libraries', bootstrap.wasmJsStdlib, '-language-version', '2.5', '-api-version', '2.5'];
    await run('selected-common-wasm-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-ir-output-dir', path.join(outputRoot, 'klib'), '-ir-output-name', 'wasm-collections', ...common, path.join(outputRoot, 'WasmEntry.kt')]);
    await run('selected-common-wasm-module-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/wasm-collections.klib'), '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'wasm-collections', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
    const nodeWasm = await run('selected-common-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e', 'const m=await import(process.argv[1]);process.stdout.write(m.wasmCollectionsObservation());', pathToFileURL(path.join(outputRoot, 'wasm/wasm-collections.mjs')).href]);
    assert(original === nodeWasm, 'Original/Node Wasm raw observations differ');
    for (const [name, text] of [['original.txt', original], ['common-jvm.txt', commonJvm], ['common-wasm.txt', nodeWasm]]) {
        await writeFile(path.join(outputRoot, name), text, { flag: 'wx', mode: 0o600 }); outputs.push({ path: name, bytes: Buffer.byteLength(text), sha256: sha256(Buffer.from(text)) });
    }
    // Re-read frozen files after patching before claiming their recorded output hashes.
    for (const pin of outputs) { const bytes = await readRegular(path.join(outputRoot, pin.path)); pin.bytes = bytes.length; pin.sha256 = sha256(bytes); }
    const artifactNames = ['jvm/original.jar', 'jvm/common.jar', 'klib/wasm-collections.klib'];
    for (const item of await readdir(path.join(outputRoot, 'wasm'), { withFileTypes: true })) {
        assert(item.isFile(), 'Wasm artifact must be a regular file'); artifactNames.push('wasm/' + item.name);
    }
    for (const name of artifactNames) {
        const bytes = await readRegular(path.join(outputRoot, name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const receipt = { schemaVersion: 1, kind: 'selected-wasm-collections-body-jvm-common-wasm-differential', source: lock.source,
        sourceLockSha256: sha256(lockBytes), preparation: prepared.receipt, predecessors: { identity: preparedIdentity.receipt, text: preparedText.receipt },
        probeSlices: lock.probeSlices, probeTypes: lock.probeTypes,
        probeAssertionHelper: lock.probeAssertionHelper, probeOnlyImportAdaptation: 'WasmExpressionBuilder uses the existing genuine enabled common assertion helper; all other whole-type source bodies unchanged',
        buildToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), observers, commands, outputs,
        bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
        comparison: { observations: original.trimEnd().split('\n').length, originalJvmEqualsCommonJvm: true, originalJvmEqualsNodeWasm: true, normalizedText: false,
            metadataSections: 'Exact selected original annotation grouping, emission, payload-size backpatch and string writer bodies; 1026 raw byte cases',
            actualValueTypes: ['WasmFunctionType', 'WasmGlobal', 'WasmRefType', 'WasmImportDescriptor', 'WasmSymbol', 'LiteralGlobalSymbol'],
            mapOwners: 'Explicit observation fixtures; signature keys test ordinary equality/collisions. Full IdSignature owner graph, full fragment and full writer are not executed.',
            scope: 'Only the three selected serial nonnull Map operations and ascending metadata snapshot; no nullable map, concurrent callback or arbitrary SortedMap API emulation' },
        browserExecuted: false, fullCompilerBuilt: false, publicLanguageSupport: false };
    await writeJson(path.join(outputRoot, 'receipt.json'), receipt);
    return { outputRoot, receipt, preparedIdentity, preparedText, prepared };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        assert.equal(process.argv.length, 3, 'Usage: check.mjs NEW_OUTPUT_ROOT');
        const result = await checkWasmCollections({ sourceRoot: path.join(repository, 'out/kotlin-compiler-port/sources'), outputRoot: process.argv[2] });
        console.log(JSON.stringify({ outputRoot: result.outputRoot, comparison: result.receipt.comparison }));
    } catch (error) { console.error(error); process.exitCode = 1; }
}
