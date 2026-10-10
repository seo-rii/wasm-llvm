import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readRegular, sha256, verifyFile } from '../../scripts/source.mjs';
import { prepareCompilerMessageSources, transformCompilerMessages } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const lock = JSON.parse(await readRegular(path.join(here, 'sources.lock.json')));

async function fixture() {
    const root = await mkdtemp(path.join(repository, 'out/compiler-messages-guard-'));
    const sourceRoot = path.join(root, 'original');
    for (const pin of lock.sources) {
        const bytes = verifyFile(await readRegular(path.join(repository, 'out/kotlin-compiler-port/sources', pin.path)), pin);
        const filename = path.join(sourceRoot, pin.path);
        await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    }
    return { root, sourceRoot, outputRoot: path.join(root, 'prepared') };
}

test('message preparation binds actual original and portable content without mutating sources', async () => {
    const f = await fixture();
    try {
        const result = await prepareCompilerMessageSources(f);
        assert.equal(result.commonSources.length, 5);
        assert.deepEqual(result.replacedOriginalPaths, lock.sources.map(pin => pin.path));
        for (const pin of lock.sources) {
            verifyFile(await readRegular(path.join(f.sourceRoot, pin.path)), pin);
            assert.equal(sha256(await readRegular(path.join(f.outputRoot, 'compiler-port-messages', path.basename(pin.path)))), pin.portableSha256);
        }
        assert.equal(result.receipt.readiness.publicLanguageSupport, false);
    } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('changed original message source is rejected before publishing preparation receipt', async () => {
    const f = await fixture();
    try {
        await writeFile(path.join(f.sourceRoot, lock.sources[0].path), 'changed');
        await assert.rejects(prepareCompilerMessageSources(f), /Pinned source content mismatch/);
        await assert.rejects(readRegular(path.join(f.outputRoot, 'compiler-port-messages/receipt.json')), { code: 'ENOENT' });
    } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('completed preparation cannot be silently overwritten', async () => {
    const f = await fixture();
    try {
        const result = await prepareCompilerMessageSources(f);
        const before = sha256(await readRegular(result.receiptPath));
        await assert.rejects(prepareCompilerMessageSources(f), { code: 'EEXIST' });
        assert.equal(sha256(await readRegular(result.receiptPath)), before);
    } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('preparation rejects symlink and original-cache output paths', async () => {
    const f = await fixture();
    try {
        await symlink(f.sourceRoot, path.join(f.root, 'alias'));
        await assert.rejects(prepareCompilerMessageSources({ sourceRoot: path.join(f.root, 'alias'), outputRoot: f.outputRoot }), /Symlink/);
        await assert.rejects(prepareCompilerMessageSources({ sourceRoot: f.sourceRoot, outputRoot: path.join(f.sourceRoot, 'new') }));
    } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('source transformations reject changed host-boundary declarations', () => {
    assert.throws(() => transformCompilerMessages('different', 'CompilerMessageSeverity.kt'));
    assert.throws(() => transformCompilerMessages('different', 'CompilerMessageLocation.kt'));
    assert.throws(() => transformCompilerMessages('different', 'MessageCollector.kt'));
    assert.throws(() => transformCompilerMessages('different', 'unreviewed.kt'));
});
