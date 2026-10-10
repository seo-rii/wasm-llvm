import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sha256 } from '../../scripts/source.mjs';
import { guardDiskReaders, PATHS } from './generate.mjs';
import { prepareCompilerFingerprints, verifyCompilerFingerprints } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const REPO = path.resolve(HERE, '../../../..');
const CACHE = path.join(REPO, 'out/kotlin-compiler-port/sources');
const READER = 'compiler/ir/serialization.js/src/org/jetbrains/kotlin/ir/backend/js/klib.kt';
// Exact retained manifest statements, deliberately bounded to test the fail-closed guard.
const READER_TEXT = Buffer.from('val KotlinLibrary.serializedKlibFingerprint: SerializedKlibFingerprint?\n' +
    'get() = manifestProperties.getProperty(KLIB_PROPERTY_SERIALIZED_KLIB_FINGERPRINT)?.let { SerializedKlibFingerprint.fromString(it) }\n' +
    'p.setProperty(KLIB_PROPERTY_SERIALIZED_KLIB_FINGERPRINT, SerializedKlibFingerprint(fingerprints).klibFingerprint.toString())\n');

async function fixture(run) {
    const temp = await mkdtemp(path.join(REPO, 'out/fingerprints-integrity-'));
    try {
        const sourceRoot = path.join(temp, 'source'); const outputRoot = path.join(temp, 'output'); await mkdir(sourceRoot);
        const inventory = [];
        for (const logical of PATHS) {
            const source = await readFile(path.join(CACHE, logical)); const filename = path.join(sourceRoot, logical);
            await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, source);
            inventory.push({ path: logical, filename, bytes: source.length, sha256: sha256(source), source });
        }
        const filename = path.join(temp, 'reader.kt'); await writeFile(filename, READER_TEXT);
        inventory.push({ path: READER, filename, bytes: READER_TEXT.length, sha256: sha256(READER_TEXT), source: READER_TEXT });
        await run({ temp, sourceRoot, outputRoot, inventory });
    } finally { await rm(temp, { recursive: true, force: true }); }
}
test('actual algorithms retained; disk-only declarations excluded under reader guard', async () => fixture(async ({ sourceRoot, outputRoot, inventory }) => {
    const result = await prepareCompilerFingerprints({ sourceRoot, outputRoot, retainedSources: inventory });
    const checked = await verifyCompilerFingerprints(path.dirname(result.receiptPath));
    assert.equal(checked.receipt.diskExclusionGuard.readers.length, 3);
    const fp = (await readFile(result.commonSources.find(file => file.endsWith('/FileFingerprints.kt')))).toString();
    assert(fp.includes('constructor(lib: KotlinLibrary, fileIndex: Int)')); assert(fp.includes('file.fileEntries?.let')); assert(fp.includes('acc.combineWith(x.fileFingerprint.hash)'));
    assert(!fp.includes('calculateKlibHash')); assert(!fp.includes('java.io.File')); assert(fp.includes('.mapNotNull'));
}));
test('new disk constructor reader, alias import and token in comment all block exclusion', async () => fixture(async ({ inventory }) => {
    for (const line of ['SerializedKlibFingerprint(java.io.File("x"))', 'import org.jetbrains.kotlin.backend.common.serialization.SerializedKlibFingerprint as Alias', '// calculateKlibHash is used here']) {
        assert.throws(() => guardDiskReaders([...inventory, { path: 'new-reader.kt', source: Buffer.from(line) }]), /may be read/);
    }
}));
test('missing actual fingerprint graph input or manifest reader blocks exclusion', async () => fixture(async ({ inventory }) => {
    assert.throws(() => guardDiskReaders(inventory.filter(item => item.path !== PATHS[1])), /must appear/);
    assert.throws(() => guardDiskReaders(inventory.filter(item => item.path !== READER)), /Expected actual/);
}));
test('changed retained bytes cannot publish preparation', async () => fixture(async ({ sourceRoot, outputRoot, inventory }) => {
    await writeFile(inventory[2].filename, Buffer.from('changed'));
    await assert.rejects(prepareCompilerFingerprints({ sourceRoot, outputRoot, retainedSources: inventory }));
}));
test('corrupt original, generated source and compressed guard snapshot are rejected', async () => fixture(async ({ sourceRoot, outputRoot, inventory }) => {
    const result = await prepareCompilerFingerprints({ sourceRoot, outputRoot, retainedSources: inventory }); const root = path.dirname(result.receiptPath);
    for (const file of [result.commonSources[0], path.join(root, 'original', PATHS[0]), path.join(root, 'retained-source-snapshot.json.gz')]) {
        const old = await readFile(file); await writeFile(file, Buffer.from('tampered')); await assert.rejects(verifyCompilerFingerprints(root)); await writeFile(file, old);
    }
    await verifyCompilerFingerprints(root);
}));
test('overlapping cache and repeated output cannot be overwritten', async () => fixture(async ({ sourceRoot, outputRoot, inventory }) => {
    await assert.rejects(prepareCompilerFingerprints({ sourceRoot, outputRoot: sourceRoot, retainedSources: inventory }), /overlaps/);
    await prepareCompilerFingerprints({ sourceRoot, outputRoot, retainedSources: inventory });
    await assert.rejects(prepareCompilerFingerprints({ sourceRoot, outputRoot, retainedSources: inventory }), /EEXIST/);
}));
