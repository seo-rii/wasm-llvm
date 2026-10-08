#!/usr/bin/env node
/** Apply the pinned official KLIB host separation without modifying the original source closure. */
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
const localFiles = ['PortableBytes.kt', 'ManifestProperties.kt', 'MemoryKotlinLibrary.kt', 'LibraryPathOperations.kt', 'KlibSha256.kt'];

export async function prepareKlibSources({ sourceRoot, outputRoot }) {
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
    for (const pin of lock.sources) {
        const bytes = await readRegular(path.join(sourceRoot, relativePath(pin.path)));
        assert.equal(bytes.byteLength, pin.bytes);
        assert.equal(sha256(bytes), pin.sha256, 'Original source hash mismatch: ' + pin.path);
        assert.equal(createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex'), pin.gitBlobSha1);
        originals.push({ pin, bytes });
    }
    const generatedRoot = path.join(outputRoot, 'compiler-port-klib');
    await mkdir(generatedRoot, { recursive: true });
    const receiptPath = path.join(generatedRoot, 'klib-receipt.json');
    try { await readRegular(receiptPath); throw new Error('KLIB preparation receipt already exists; choose a fresh closure'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const { pin, bytes } of originals) {
        const destination = path.join(outputRoot, pin.path);
        await assertNoSymlink(destination);
        try { assert.equal(sha256(await readRegular(destination)), pin.sha256, 'Existing source differs from original pin'); }
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
        assert.equal(sha256(await readRegular(path.join(sourceRoot, pin.path))), pin.sha256, 'Original source cache changed');
        if (pin.path.endsWith('/lowLevelWriters.kt')) {
            // Every format encoder body is kept; adapters and host limits are outside writeData().
            const bodies = (text) => [...text.toString().matchAll(/override fun writeData\(dataOutput: DataOutput\) \{([\s\S]*?)\n    \}/g)].map((match) => match[0]);
            assert.equal(bodies(original).length, 3);
            assert.deepEqual(bodies(bytes), bodies(original), 'Official KLIB writer algorithms changed');
        } else if (pin.path.endsWith('/WobblyTF8.kt')) {
            const body = (text) => text.toString().slice(text.toString().indexOf('object WobblyTF8'));
            const portableBody = body(bytes).replace('buffer.concatToString() else buffer.concatToString(0, charsWritten)',
                'String(buffer) else String(buffer, 0, charsWritten)');
            assert.equal(portableBody, body(original), 'Official WobblyTF8 algorithm changed outside the equivalent common String constructor boundary');
        } else if (pin.path.endsWith('/Leb128.kt')) {
            const body = (text) => text.toString().slice(text.toString().indexOf('fun writeUnsignedLeb128Fixed'));
            assert.equal(body(bytes), body(original), 'Official LEB128 algorithms changed');
        } else if (pin.path.endsWith('/KlibIrComponentImpl.kt')) {
            const body = (text) => text.toString().slice(text.toString().indexOf('internal abstract class AbstractKlibIrComponentImpl')).split('\n/**\n * The default implementation')[0].trim();
            assert.equal(body(bytes), body(original), 'Official IR component indexing changed');
        }
        sources.push({ path: pin.path, bytes: bytes.byteLength, sha256: pin.portableSha256, originalSha256: pin.sha256 });
    }
    for (const filename of localFiles) {
        const bytes = await readRegular(path.join(here, filename));
        await writeFile(path.join(generatedRoot, filename), bytes, { flag: 'wx', mode: 0o600 });
        sources.push({ path: 'compiler-port-klib/' + filename, bytes: bytes.byteLength, sha256: sha256(bytes), originalSha256: null });
    }
    const receipt = {
        schemaVersion: 1, kind: 'official-klib-portable-host-preparation', source: lock.source,
        sourceLockSha256: sha256(lockBytes), patch: lock.patch, sources, commands, originalSourcesUnmodified: true,
        requiredHostSource: 'compiler-port-host/LibraryPath.kt',
        sourceSetExclusions: ['KlibLayoutReader and archive/filesystem loaders', 'KlibImpl and KlibComponentsCache',
            'Filesystem KlibMetadataComponentImpl and KlibIrComponentImpl variant',
            'IrDataWriter.writeIntoFile and layoutReader-based low-level reader overloads',
            'PropertyFileUtils filesystem read/write and Util.kt host profiling/path helpers'],
        formatPreservation: { bigEndianIndices: true, declarationIds: true, varIntLengths: true,
            officialWriterBodiesUnmodified: true, officialWobblyTF8EncodingAlgorithmPreserved: true, officialLeb128BodiesUnmodified: true,
            officialAbstractIrAccessBodyUnmodified: true },
        policyChanges: ['Finite buffer/table counts; invalid byte ranges and overlapping declaration indexes fail before allocation.',
            'SoftReference cache becomes bounded request-local strong immutable cache; fresh compiler/library lifetime is required.',
            'Library paths are canonical POSIX virtual locations; filesystem lookup and component discovery are excluded.',
            'Manifests are string-only and frozen for verified libraries; Java escapes and duplicate-key-last-wins are preserved.',
            'Actual host SHA-256 verification is required for each immutable file before reader construction.'],
        readiness: { sourcePrepared: true, klibReaderExecution: 'not-run', stdlibIntegration: 'not-run', browserCompiler: false },
    };
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { outputRoot, receiptPath, receipt, commonSources: sources.map((pin) => path.join(outputRoot, pin.path)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const args = process.argv.slice(2);
        const options = {};
        while (args.length) {
            const key = args.shift();
            assert(['--source-root', '--output-root'].includes(key) && args[0] && !options[key], 'Invalid KLIB preparation option');
            options[key] = args.shift();
        }
        const result = await prepareKlibSources({ sourceRoot: options['--source-root'], outputRoot: options['--output-root'] });
        console.log(JSON.stringify({ outputRoot: result.outputRoot, receiptPath: result.receiptPath, sourceCount: result.commonSources.length }));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
