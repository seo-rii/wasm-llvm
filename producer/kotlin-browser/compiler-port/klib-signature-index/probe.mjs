import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareKlibSources } from '../klib/prepare.mjs';
import { prepareLinkerSources } from '../linker/prepare.mjs';
import { verifyPreparation as verifyProtobufPreparation } from '../serialization/build.mjs';
import { prepareKlibSignatureIndex, verifyKlibSignatureIndex, verifyFinalKlibSignatureIndex } from './prepare.mjs';
import { INDEX, MEMORY, SIGNATURE, normalizeImports } from './transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), execute = promisify(execFile);
const pin = (path, bytes) => ({ path, bytes: bytes.length, sha256: sha256(bytes) });
const basename = file => path.basename(file);
function verifyDigest(bytes, row) { assert.equal(bytes.length, row.bytes); assert.equal(sha256(bytes), row.sha256, 'Source/artifact changed: ' + row.path); }
export async function runIndexProbe({ sourceRoot, outputRoot, frozenBuildRoot, codecRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); frozenBuildRoot = path.resolve(frozenBuildRoot); codecRoot = path.resolve(codecRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(outputRoot, { mode: 0o700 });
    const bootstrap = await verifyBootstrap(), commands = [], inputPins = [], projectionPins = [];
    async function run(phase, command, args) {
        const start = performance.now();
        try {
            const r = await execute(command, args, { cwd: outputRoot, timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
            if (r.stderr) process.stderr.write(r.stderr); commands.push({ phase, command: [command, ...args], exitCode: 0, elapsedMs: performance.now() - start }); return r.stdout;
        } catch (error) {
            await writeJson(path.join(outputRoot, 'failure.json'), { phase, exitCode: error.code, stderr: String(error.stderr ?? '').slice(-24576), commands });
            process.stderr.write(String(error.stderr ?? error).slice(-24576)); throw new Error(phase + ' failed');
        }
    }
    async function put(name, bytes) {
        const filename = path.join(outputRoot, name); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); projectionPins.push(pin(name, Buffer.from(bytes))); return filename;
    }
    const primaryBytes = await readRegular(path.join(HERE, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
    const klibLock = JSON.parse(await readRegular(path.join(HERE, '../klib/sources.lock.json'))), linkerLock = JSON.parse(await readRegular(path.join(HERE, '../linker/sources.lock.json')));
    async function original(logical) {
        const bytes = await readRegular(path.join(sourceRoot, logical));
        const expected = primary.files.find(row => row.path === logical) ?? [...klibLock.sources, ...klibLock.referenceOnlySources, ...linkerLock.sources].find(row => row.path === logical);
        assert(expected, 'Unpinned original probe dependency: ' + logical); verifyFile(bytes, { ...expected, gitBlob: expected.gitBlob ?? expected.gitBlobSha1 });
        if (!inputPins.some(row => row.path === logical)) inputPins.push(pin(logical, bytes)); return bytes;
    }
    const frozenBytes = await readRegular(path.join(frozenBuildRoot, 'compiler-build-receipt.json'), 64 * 1024 * 1024), frozen = JSON.parse(frozenBytes);
    const args = (await readRegular(path.join(frozenBuildRoot, 'compiler-klib.args'), 64 * 1024 * 1024)).toString().trim().split('\n').map(JSON.parse);
    const filenames = args.filter(value => path.isAbsolute(value) && value.endsWith('.kt')); assert.equal(filenames.length, frozen.compileSources.length);
    const actual = frozen.compileSources.map((row, n) => ({ ...row, filename: filenames[n] }));
    for (const row of actual) verifyDigest(await readRegular(row.filename), row);
    const klib = await prepareKlibSources({ sourceRoot, outputRoot: path.join(outputRoot, 'klib') });
    const linker = await prepareLinkerSources({ sourceRoot, outputRoot: path.join(outputRoot, 'linker') });
    const memoryFile = klib.commonSources.find(file => file.endsWith('/' + MEMORY)), memoryBytes = await readRegular(memoryFile), originalIndex = await original(INDEX);
    const prepared = await prepareKlibSignatureIndex({ sourceRoot, outputRoot: path.join(outputRoot, 'index'), klibComponent: klib,
        retainedSources: [{ ...pin(MEMORY, memoryBytes), filename: memoryFile }, { ...pin(INDEX, originalIndex), filename: path.join(sourceRoot, INDEX) }] });
    const preparation = await verifyKlibSignatureIndex(prepared.outputRoot);
    const actualTargets = actual.filter(row => [INDEX, MEMORY].includes(row.path)); assert.equal(actualTargets.length, 2);
    for (const row of actualTargets) assert.deepEqual(normalizeImports(await readRegular(row.filename), frozen.propertyImports.imports), row.path === INDEX ? originalIndex : memoryBytes);
    const finalSources = actual.filter(row => ![INDEX, MEMORY].includes(row.path));
    for (const file of prepared.commonSources) finalSources.push({ ...pin(path.relative(prepared.outputRoot, file), await readRegular(file)), filename: file });
    const final = await verifyFinalKlibSignatureIndex({ outputRoot: prepared.outputRoot, retainedSources: finalSources, recordedPropertyImports: frozen.propertyImports.imports });
    await writeJson(path.join(outputRoot, 'final-selection.json'), { frozenBuildRoot, frozenReceiptSha256: sha256(frozenBytes), selectedBefore: actual.length, selectedAfter: finalSources.length, final: final.receipt });

    const codecPreparation = await verifyProtobufPreparation(path.join(codecRoot, 'prepared'));
    const codecReceiptBytes = await readRegular(path.join(codecRoot, 'codec/receipt.json')), codecReceipt = JSON.parse(codecReceiptBytes);
    assert.equal(codecReceipt.preparationSha256, codecPreparation.receiptSha256); assert.equal(codecReceipt.stage, 'all');
    assert.deepEqual(codecReceipt.outputs, frozen.protobufBuildReceipt.outputs);
    for (const row of codecReceipt.outputs) verifyDigest(await readRegular(path.join(codecRoot, 'codec', row.path)), row);
    const codecJvm = path.join(codecRoot, 'codec/codec.jar'), codecWasm = path.join(codecRoot, 'codec/wasm/compiler-protobuf.klib');
    const observers = {};
    for (const name of ['IndexObserver.kt', 'OriginalJvmEntry.kt', 'PortableObserver.kt', 'PortableJvmEntry.kt', 'WasmEntry.kt']) {
        const bytes = await readRegular(path.join(HERE, name)); inputPins.push(pin(name, bytes)); observers[name] = await put('observer/' + name, bytes);
    }
    const unitPaths = linkerLock.sources.filter(row => row.path.includes('/util-klib/') && !row.path.includes('/loader/')).map(row => row.path), unitSet = new Set(unitPaths);
    const originals = [];
    for (const row of [...klibLock.sources, ...klibLock.referenceOnlySources, ...linkerLock.sources.filter(row => unitSet.has(row.path))]) {
        if (originals.some(file => file.endsWith('/' + row.path))) continue;
        let bytes = await original(row.path);
        if (row.path.endsWith('/KlibImpl.kt')) {
            const t = bytes.toString();
            bytes = Buffer.from(t.slice(0, t.indexOf('import org.jetbrains.kotlin.io.ZipFileSystemAccessor')) +
                'import org.jetbrains.kotlin.library.KlibComponentLayout\nimport org.jetbrains.kotlin.library.KlibConstants.KLIB_DEFAULT_COMPONENT_NAME\n' +
                'import org.jetbrains.kotlin.library.KlibConstants.KLIB_MANIFEST_FILE_NAME\nimport java.nio.file.Path\n\n' + t.slice(t.indexOf('internal class KlibManifestComponentLayout(')));
        }
        originals.push(await put('original/' + row.path, bytes));
    }
    originals.push(await put('original/' + INDEX, originalIndex));
    const common = [...klib.commonSources.filter(file => file !== memoryFile), ...prepared.commonSources,
        ...linker.commonSources.filter(file => unitPaths.some(logical => file.endsWith('/' + logical)) || ['MemoryKlibOutput.kt', 'SourcePathOperations.kt', 'MemoryJarManifest.kt'].includes(basename(file)))];
    for (const name of ['../host/LibraryPath.kt', '../core/Name.kt', '../assertions/CompilerAssertions.kt']) {
        const bytes = await readRegular(path.join(HERE, name)); inputPins.push(pin(name, bytes)); common.push(await put('support/' + basename(name), bytes));
    }
    const IR = 'compiler/ir/serialization.common/src/org/jetbrains/kotlin/backend/common/';
    const supporting = [SIGNATURE, 'compiler/ir/ir.tree/src/org/jetbrains/kotlin/ir/util/IdSignatureRenderer.kt',
        IR + 'IdSignaturesExtractor.kt', IR + 'serialization/IrStringSerializer.kt',
        'core/names/src/org/jetbrains/kotlin/name/FqName.kt', 'core/names/src/org/jetbrains/kotlin/name/FqNameUnsafe.kt'];
    for (const logical of supporting) {
        const raw = await original(logical); let reference = raw.toString(), portable = reference;
        if (logical === SIGNATURE) {
            const constructor = '        constructor(fileSymbol: IrFileSymbol) : this(\n            fileSymbol, fileSymbol.owner.packageFqName, fileSymbol.owner.fileEntry.name\n        )\n';
            assert.equal(reference.split(constructor).length, 2); reference = reference.replace(constructor, '');
            const split = reference.indexOf('\ninterface IdSignatureComposer {'); assert(split > 0); reference = reference.slice(0, split) + '\n';
            for (const imp of ['org.jetbrains.kotlin.descriptors.ClassDescriptor', 'org.jetbrains.kotlin.descriptors.DeclarationDescriptor', 'org.jetbrains.kotlin.descriptors.PropertyDescriptor', 'org.jetbrains.kotlin.ir.symbols.IrFileSymbol']) reference = reference.replace('import ' + imp + '\n', '');
            const before = '            if (javaClass != other?.javaClass) return false\n\n            other as SpecialFakeOverrideSignature';
            assert.equal(reference.split(before).length, 2); portable = reference.replace(before, '            if (other !is SpecialFakeOverrideSignature) return false');
            portable = portable.replace('package org.jetbrains.kotlin.ir.util\n', 'package org.jetbrains.kotlin.ir.util\nimport org.jetbrains.kotlin.portable.assertions.compilerAssert as assert\n');
        } else if (logical.endsWith('/FqNameUnsafe.kt')) {
            const unused = '        private val SPLIT_BY_DOTS: Pattern = Pattern.compile("\\\\.")\n'; assert.equal(portable.split(unused).length, 2);
            portable = portable.replace('import java.util.regex.Pattern\n', '').replace(unused, '');
        }
        portable = portable.replace(/(^package[^\n]+)/m, '$1\nimport kotlin.jvm.*');
        originals.push(await put('original-support/' + basename(logical), reference));
        common.push(await put('common-support/' + basename(logical), portable));
    }
    const serializer = (await original(IR + 'serialization/IdSignatureSerializer.kt')).toString();
    const declaration = serializer.slice(serializer.indexOf('class CommonSignatureSerializer(')); assert(declaration.startsWith('class CommonSignatureSerializer('));
    const serializerFile = await put('support/CommonSignatureSerializer.kt', 'package org.jetbrains.kotlin.backend.common.serialization\nimport org.jetbrains.kotlin.ir.util.IdSignature\nimport org.jetbrains.kotlin.backend.common.serialization.proto.CommonIdSignature as ProtoCommonIdSignature\n' + declaration);
    originals.push(serializerFile); common.push(serializerFile);
    const collection = (await original('core/util.runtime/src/org/jetbrains/kotlin/utils/collections.kt')).toString();
    const set = /fun <E> newHashSetWithExpectedSize\(expectedSize: Int\): HashSet<E> =\n    HashSet\(capacity\(expectedSize\)\)/.exec(collection)?.[0];
    const capacity = /private fun capacity\(expectedSize: Int\): Int =\n    if \(expectedSize < 3\) 3 else expectedSize \+ expectedSize \/ 3 \+ 1/.exec(collection)?.[0]; assert(set && capacity);
    const collectionFile = await put('support/ExpectedSet.kt', 'package org.jetbrains.kotlin.utils\n' + set + '\n\n' + capacity + '\n'); originals.push(collectionFile); common.push(collectionFile);
    for (const name of ['CommonIdSignature.java', 'CommonIdSignatureOrBuilder.java']) await put('reference-java/' + name, await original(IR + 'serialization/proto/' + name));
    await mkdir(path.join(outputRoot, 'reference-classes'));
    await run('original-java-protobuf-build', 'javac', ['-J-Xmx512m', '-cp', bootstrap.classPath, '-d', path.join(outputRoot, 'reference-classes'), ...['CommonIdSignature.java', 'CommonIdSignatureOrBuilder.java'].map(name => path.join(outputRoot, 'reference-java', name))]);
    const flagsBytes = await readRegular(path.join(HERE, '../build-flags.json')), flags = JSON.parse(flagsBytes);
    const stdlib = bootstrap.artifacts.find(row => row.id === 'stdlib-jvm').path;
    for (const dir of ['jvm', 'wasm', 'wasm-klib']) await mkdir(path.join(outputRoot, dir));
    const jvm = ['-Xmx1024m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', '2.5', '-api-version', '2.5'];
    const originalClasspath = path.join(outputRoot, 'reference-classes') + path.delimiter + bootstrap.classPath;
    await run('original-jvm-build', 'java', [...jvm, ...flags.compilerFlags.map(arg => arg === '-Xname-based-destructuring=complete' ? '-Xname-based-destructuring=only-syntax' : arg), '-classpath', originalClasspath, '-d', path.join(outputRoot, 'jvm/original.jar'), ...originals, observers['IndexObserver.kt'], observers['OriginalJvmEntry.kt']]);
    const observations = {};
    observations.original = await run('original-jvm-observe', 'java', ['-ea', '-cp', path.join(outputRoot, 'jvm/original.jar') + path.delimiter + originalClasspath, 'org.jetbrains.kotlin.backend.common.indexprobe.OriginalJvmEntryKt']);
    const commonSources = [...common, observers['IndexObserver.kt'], observers['PortableObserver.kt']];
    await run('common-jvm-build', 'java', [...jvm, ...flags.compilerFlags, '-Xmulti-platform', '-Xcommon-sources=' + commonSources.join(','), '-classpath', [stdlib, codecJvm].join(path.delimiter), '-d', path.join(outputRoot, 'jvm/common.jar'), ...commonSources, observers['PortableJvmEntry.kt']]);
    observations.common = await run('common-jvm-observe', 'java', ['-ea', '-cp', [path.join(outputRoot, 'jvm/common.jar'), stdlib, codecJvm].join(path.delimiter), 'org.jetbrains.kotlin.backend.common.indexprobe.PortableJvmEntryKt']);
    assert.equal(observations.common, observations.original, 'Common JVM differs from selected original index');
    const wasm = ['-Xmx1024m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-language-version', '2.5', '-api-version', '2.5', ...flags.compilerFlags, '-libraries', [bootstrap.wasmJsStdlib, codecWasm].join(path.delimiter)];
    await run('common-wasm-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + commonSources.join(','), '-Xir-produce-klib-file', '-ir-output-dir', path.join(outputRoot, 'wasm-klib'), '-ir-output-name', 'index-probe', ...commonSources, observers['WasmEntry.kt']]);
    await run('common-wasm-link', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'wasm-klib/index-probe.klib'), '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'index-probe', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
    observations.wasm = await run('common-node-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e', 'const m=await import(process.argv[1]);process.stdout.write(m.signatureIndexProbe());', pathToFileURL(path.join(outputRoot, 'wasm/index-probe.mjs')).href]);
    assert.equal(observations.wasm, observations.original, 'Wasm differs from selected original index');
    const outputs = [];
    for (const [name, text] of Object.entries(observations)) { const filename = name + '-observations.txt'; await writeFile(path.join(outputRoot, filename), text, { flag: 'wx', mode: 0o600 }); outputs.push(pin(filename, Buffer.from(text))); }
    for (const name of ['jvm/original.jar', 'jvm/common.jar', 'wasm-klib/index-probe.klib', ...(await readdir(path.join(outputRoot, 'wasm'))).map(name => 'wasm/' + name)]) outputs.push(pin(name, await readRegular(path.join(outputRoot, name), 64 * 1024 * 1024)));
    for (const name of ['probe.mjs', 'prepare.mjs', 'transform.mjs', 'sources.lock.json']) inputPins.push(pin(name, await readRegular(path.join(HERE, name))));
    const evidence = { schemaVersion: 1, kind: 'genuine-memory-klib-signature-index-differential', result: 'pass', source: primary.source,
        sourceLockSha256: sha256(await readRegular(path.join(HERE, 'sources.lock.json'))), frozenReceiptSha256: sha256(frozenBytes), actualFinalSelection: { before: actual.length, after: finalSources.length, checked: final.receipt.checked },
        preparation, commands, inputPins, projectionPins, codec: { root: codecRoot, preparationSha256: codecPreparation.receiptSha256, receiptSha256: sha256(codecReceiptBytes), outputs: codecReceipt.outputs },
        bootstrap: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
        sourceFlagsSha256: sha256(flagsBytes), outputs, records: observations.original.trimEnd().split('\n').length, exactRawObservationEquality: true,
        completeShippingIndexExecuted: true, completeMemoryLibraryExecuted: true, allNineActualSealedSignatureTypes: true,
        dependencyProjections: ['IdSignature: omit only IR-symbol auxiliary constructor and unrelated composer interface; keep all nine subtype bodies; one exact final-type equality bridge on common.',
            'CommonSignatureSerializer is the full genuine declaration from IdSignatureSerializer.kt. IrStringSerializer and IdSignatureRenderer are complete.',
            'FqNameUnsafe: omit unused Pattern import/constant on common. Name is the existing independently tested actual common port.',
            'collections.kt: exact newHashSetWithExpectedSize and its capacity helper; KlibImpl: exact manifest-layout declaration as used by the existing linker component proof.'],
        malformedInputParity: 'Both reject; exception details follow the already declared bounded portable byte/protobuf host policies.',
        fullIdSignatureIrClosureWasmExecuted: false, browserExecution: 'not-run', fullCompilerBuilt: false, languageReadiness: false };
    await writeJson(path.join(outputRoot, 'differential.json'), evidence);
    return { outputRoot, records: evidence.records, result: 'pass' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const options = {}; for (let n = 2; n < process.argv.length; n += 2) { assert(['--source-root', '--output', '--frozen-build-root', '--codec-root'].includes(process.argv[n])); options[process.argv[n]] = process.argv[n + 1]; }
    console.log(JSON.stringify(await runIndexProbe({ sourceRoot: options['--source-root'], outputRoot: options['--output'], frozenBuildRoot: options['--frozen-build-root'], codecRoot: options['--codec-root'] })));
}
