#!/usr/bin/env node
/** Keep official serialization/linking algorithms and move only their source/library/output host boundaries. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertNoSymlink, readRegular, relativePath } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const localFiles = ['MemoryKlibOutput.kt', 'SourcePathOperations.kt', 'MemoryJarManifest.kt', 'MemoryKlibLoader.kt', 'LoadMemoryWebKlibs.kt'];

export const linkerSourceExclusions = [
    'compiler/ir/serialization.js/src/org/jetbrains/kotlin/ir/backend/js/loadWebKlibs.kt',
    'compiler/util-klib/src/org/jetbrains/kotlin/library/loader/KlibLoader.kt',
    'compiler/util-klib/src/org/jetbrains/kotlin/library/loader/KlibLibraryProvider.kt',
    'compiler/util-klib/src/org/jetbrains/kotlin/library/loader/KlibLoadingCancellationChecker.kt',
    'compiler/util-klib/src/org/jetbrains/kotlin/library/impl/KlibComponentsCache.kt',
    'compiler/util-klib/src/org/jetbrains/kotlin/library/impl/KlibLayoutReaderImpl.kt',
];

export async function prepareLinkerSources({ sourceRoot, outputRoot }) {
    assert(sourceRoot && outputRoot, 'sourceRoot and outputRoot are required');
    sourceRoot = path.resolve(sourceRoot);
    outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep), 'Prepared sources must stay under repository out/');
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep), 'Do not mutate the original source cache');
    await assertNoSymlink(sourceRoot);
    await assertNoSymlink(outputRoot);
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json'));
    const lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1);
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    const patchPath = path.join(here, relativePath(lock.patch.path));
    const patchBytes = await readRegular(patchPath);
    assert.equal(patchBytes.byteLength, lock.patch.bytes);
    assert.equal(sha256(patchBytes), lock.patch.sha256);
    const originals = [];
    for (const pin of [...lock.sources, ...lock.referenceOnlySources]) {
        const bytes = await readRegular(path.join(sourceRoot, relativePath(pin.path)));
        assert.equal(bytes.byteLength, pin.bytes);
        assert.equal(sha256(bytes), pin.sha256, 'Original source mismatch: ' + pin.path);
        assert.equal(createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex'), pin.gitBlobSha1);
        if (pin.portableSha256) originals.push({ pin, bytes });
    }
    const generatedRoot = path.join(outputRoot, 'compiler-port-linker');
    await mkdir(generatedRoot, { recursive: true });
    const receiptPath = path.join(generatedRoot, 'linker-receipt.json');
    try { await readRegular(receiptPath); throw new Error('Linker receipt already exists; choose fresh preparation output'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const { pin, bytes } of originals) {
        const destination = path.join(outputRoot, pin.path);
        await assertNoSymlink(destination);
        try { assert.equal(sha256(await readRegular(destination)), pin.sha256, 'Existing source differs from original'); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await mkdir(path.dirname(destination), { recursive: true });
            await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
        }
    }
    const commands = [];
    for (const args of [['apply', '--check', patchPath], ['apply', patchPath], ['apply', '--reverse', '--check', patchPath]]) {
        await execute('git', args, { cwd: outputRoot, timeout: 10000, maxBuffer: 65536 });
        commands.push({ argv: ['git', ...args], exitCode: 0 });
    }
    const sources = [];
    for (const { pin, bytes: original } of originals) {
        const bytes = await readRegular(path.join(outputRoot, pin.path));
        assert.equal(bytes.byteLength, pin.portableBytes);
        assert.equal(sha256(bytes), pin.portableSha256, 'Prepared source mismatch: ' + pin.path);
        assert.equal(sha256(await readRegular(path.join(sourceRoot, pin.path))), pin.sha256, 'Original cache changed');
        const text = bytes.toString();
        const upstream = original.toString();
        if (pin.path.endsWith('/ModulesStructure.kt') || pin.path.endsWith('/JsIrModuleSerializer.kt') || pin.path.endsWith('/KlibWriterUtils.kt') ||
            pin.path.endsWith('/KlibLoaderResult.kt') || pin.path.endsWith('/KlibPlatformChecker.kt') || pin.path.endsWith('/WasmLibrarySpecialCompatibilityChecker.kt')) {
            assert(bytes.equals(original), 'Core source body must stay unchanged: ' + pin.path);
        } else if (pin.path.endsWith('/Fir2KlibMetadataSerializer.kt')) {
            assert.equal(text.slice(text.indexOf('class Fir2KlibMetadataSerializer')), upstream.slice(upstream.indexOf('class Fir2KlibMetadataSerializer')),
                'Official FIR metadata serialization body changed');
        } else if (pin.path.endsWith('/LibrarySpecialCompatibilityChecker.kt')) {
            const body = (value) => value.slice(value.indexOf('    fun check('), value.indexOf('\nprivate class JarManifestComponent(') < 0 ? undefined : value.indexOf('\nprivate class JarManifestComponent(')).trim();
            assert.equal(body(text), body(upstream), 'Official special compatibility checking algorithm changed');
        } else if (pin.path.endsWith('/klib.kt')) {
            const body = (value) => value.slice(value.indexOf('fun loadIrForSingleModule('), value.indexOf('private const val FILE_FINGERPRINTS_SEPARATOR'));
            assert.equal(body(text), body(upstream).replace('        filesToLoad = configuration[JSConfigurationKeys.IC_FILES_TO_LOAD],\n', ''),
                'Mandatory single-module linking/inlining dependency algorithm changed outside the excluded IC branch');
        } else if (pin.path.endsWith('/KlibWriter.kt')) {
            const body = (value) => value.slice(value.indexOf('    private fun validateManifestProperties'), value.indexOf('\n    companion object'));
            assert.equal(body(text), body(upstream), 'Official writer validation changed');
        }
        sources.push({ path: pin.path, bytes: bytes.byteLength, sha256: pin.portableSha256, originalSha256: pin.sha256 });
    }
    for (const filename of localFiles) {
        const bytes = await readRegular(path.join(here, filename));
        await writeFile(path.join(generatedRoot, filename), bytes, { flag: 'wx', mode: 0o600 });
        sources.push({ path: 'compiler-port-linker/' + filename, bytes: bytes.byteLength, sha256: sha256(bytes), originalSha256: null });
    }
    const receipt = {
        schemaVersion: 1, kind: 'official-fir-metadata-ir-memory-klib-linker-host-preparation', source: lock.source,
        sourceLockSha256: sha256(lockBytes), patch: lock.patch, sources, referenceOnlySources: lock.referenceOnlySources,
        commands, originalSourcesUnmodified: true, requiredHostSource: 'compiler-port-host/LibraryPath.kt',
        requiredKlibPreparation: '../klib/prepare.mjs', sourceSetExclusions: linkerSourceExclusions,
        declarationExclusions: ['LoadedNativeKlibs', 'Filesystem/ZIP KlibImpl implementation; only original KlibManifestComponentLayout remains',
            'Filesystem KlibLoaderExtensions.selectLibrariesByPaths', 'IncrementalDataProvider.getSerializedData and shouldGoToNextIcRound',
            'IC dirty-file dependency loading branches and incremental result consumer callbacks', 'Private filesystem JarManifestComponent implementation'],
        policies: ['Initial profile requires fresh full source rebuild; cleanFiles must be empty.',
            'Approved library paths/files are supplied explicitly and hash checked; no filesystem or transitive library discovery.',
            'All ABI/platform/target problems are fatal; duplicate unique names and skipped special checks are rejected.',
            'KLIB output files/directory counts and decoded bytes are bounded; failed writes yield no library result.',
            'Metadata fragment numbers use ASCII decimal names under a fixed ROOT locale reference policy.',
            'JAR manifests are bounded and continuation bytes are joined before UTF-8 decoding.'],
        preservation: { officialFirMetadataSerializerBody: true, officialJsIrModuleSerializer: true, officialModulesStructure: true,
            officialKlibWriterValidationBody: true, mandatoryLinkerDependenciesAndPostProcess: true, officialSpecialCompatibilityCheckBody: true },
        readiness: { sourcePrepared: true, componentWriterExecution: 'not-run', sourceToKlib: 'not-run', klibToIr: 'not-run', browserCompiler: false },
    };
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { outputRoot, receiptPath, receipt, commonSources: sources.map((pin) => path.join(outputRoot, pin.path)), sourceSetExclusions: linkerSourceExclusions };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const args = process.argv.slice(2);
        const options = {};
        while (args.length) {
            const key = args.shift();
            assert(['--source-root', '--output-root'].includes(key) && args[0] && !options[key], 'Invalid linker option');
            options[key] = args.shift();
        }
        const result = await prepareLinkerSources({ sourceRoot: options['--source-root'], outputRoot: options['--output-root'] });
        console.log(JSON.stringify({ outputRoot: result.outputRoot, receiptPath: result.receiptPath, sourceCount: result.commonSources.length }));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
