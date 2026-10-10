import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, responseBytes, sha256, validateFilePin, verifyFile, writeJson } from '../../scripts/source.mjs';
import { transformGeneratedDiagnostics, encodeBindings } from '../diagnostic-factories/transform.mjs';
import { CLI_CONFIGURATION, CLI_REPORTING, CLI_DIAGNOSTICS, CLI_KEYS, WEB_MODULE, WEB_FACTORY,
    configurationSplit, reportingSplit } from './generate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });

async function readLock() {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
    assert.equal(lock.kind, 'official-compiler-supplemental-source-closure'); assert.equal(lock.schemaVersion, 1);
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775'); assert.equal(lock.languageReadiness, false);
    assert.deepEqual(lock.cliKeys, CLI_KEYS);
    assert.equal(sha256(await readRegular(path.join(HERE, 'generate.mjs'))), lock.generatorSha256);
    assert.equal(sha256(await readRegular(path.join(HERE, '../diagnostic-factories/transform.mjs'))), lock.factoryTransformSha256);
    assert.equal(lock.files.filter(pin => pin.path.startsWith(WEB_MODULE + '/') && pin.compile).length, 16);
    assert.equal(lock.files.length, 23);
    const seen = new Set();
    for (const pin of lock.files) {
        relativePath(pin.path); validateFilePin(pin); assert(!seen.has(pin.path)); seen.add(pin.path);
    }
    return { lock, lockBytes };
}

/** Reproducible original source cache; only exact locked commit URLs are downloaded. */
export async function prepareSourceClosureReferences({ outputRoot = path.join(REPO, 'out/kotlin-source-closure-reference'), fetcher = fetch } = {}) {
    outputRoot = path.resolve(outputRoot); assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    await assertNoSymlink(outputRoot); const sourceRoot = path.join(outputRoot, 'sources'); await assertNoSymlink(sourceRoot);
    const { lock, lockBytes } = await readLock();
    for (let offset = 0; offset < lock.files.length; offset += 4) {
        const results = await Promise.allSettled(lock.files.slice(offset, offset + 4).map(async pin => {
            const filename = path.join(sourceRoot, pin.path); await assertNoSymlink(filename); let bytes;
            try { bytes = await readRegular(filename, pin.bytes); }
            catch (error) {
                if (error.code !== 'ENOENT') throw error;
                const url = 'https://raw.githubusercontent.com/JetBrains/kotlin/' + lock.source.commit + '/' + pin.path.split('/').map(encodeURIComponent).join('/');
                bytes = verifyFile(await responseBytes(url, pin.bytes, fetcher), pin);
                await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
                try { await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); }
                catch (error) { if (error.code !== 'EEXIST') throw error; }
            }
            verifyFile(await readRegular(filename, pin.bytes), pin);
        }));
        for (const result of results) if (result.status !== 'fulfilled') throw result.reason;
    }
    const receipt = { schemaVersion: 1, kind: 'official-compiler-supplemental-original-source-cache', source: lock.source,
        sourceLockSha256: sha256(lockBytes), files: lock.files, languageReadiness: false };
    const receiptPath = path.join(outputRoot, 'source-references.json');
    try { await writeJson(receiptPath, receipt); }
    catch (error) { if (error.code !== 'EEXIST') throw error; assert.deepEqual(JSON.parse(await readRegular(receiptPath)), receipt); }
    return { sourceRoot, receipt, receiptPath };
}

async function inputs(sourceRoot) {
    await assertNoSymlink(sourceRoot); const { lock, lockBytes } = await readLock();
    const originals = new Map();
    for (const pin of lock.files) {
        const filename = relativePath(pin.path); assert(!originals.has(filename));
        originals.set(filename, verifyFile(await readRegular(path.join(sourceRoot, filename), pin.bytes), pin));
    }
    const outputs = []; const splits = [];
    for (const pin of lock.files.filter(pin => pin.compile)) {
        const original = originals.get(pin.path); let bytes = original;
        if (pin.path === WEB_FACTORY) {
            const transformed = transformGeneratedDiagnostics(original.toString('utf8'), 'web.common', 30);
            bytes = Buffer.from(transformed.text);
            outputs.push({ path: 'web-common-psi-bindings.reference.json', bytes: encodeBindings(transformed.bindings), compile: false });
        }
        outputs.push({ path: pin.path, bytes, compile: true });
    }
    for (const [filename, transform] of [[CLI_CONFIGURATION, configurationSplit], [CLI_REPORTING, reportingSplit]]) {
        const result = transform(originals.get(filename));
        splits.push({ path: filename, fragments: result.fragments.map(identity) });
        outputs.push({ path: filename, bytes: result.bytes, compile: true });
    }
    assert(outputs.some(value => value.path === CLI_DIAGNOSTICS));
    assert.deepEqual(outputs.map(({ path: filename, bytes, compile }) => ({ path: filename, ...identity(bytes), compile })), lock.outputs);
    assert.deepEqual(splits, lock.splits);
    return { lock, lockBytes, originals, outputs };
}

function receiptFor(root, input, toolHash) {
    return { schemaVersion: 1, kind: 'official-compiler-supplemental-source-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: toolHash,
        sourceFiles: input.lock.files, files: input.lock.outputs, cliKeys: input.lock.cliKeys, splits: input.lock.splits,
        webCommonKotlinFiles: 16, webCommonDiagnosticDeclarations: 30, metadataOnlyFactoryAdaptation: true,
        commonSources: input.outputs.filter(value => value.compile).map(value => path.join(root, value.path)),
        replacedOriginalPaths: [WEB_FACTORY, CLI_CONFIGURATION, CLI_REPORTING],
        additionalOriginalPaths: input.lock.files.filter(pin => pin.compile || [CLI_CONFIGURATION, CLI_REPORTING].includes(pin.path)).map(pin => pin.path),
        originalSourcesUnmodified: true, checkerAlgorithmsUnmodified: true, excludedCheckerFiles: [],
        compilerBuild: 'not-run by source preparation', browserCompilerBuilt: false, languageReadiness: false };
}

export async function prepareSourceClosure({ sourceRoot, outputRoot }) {
    if (sourceRoot === undefined) sourceRoot = (await prepareSourceClosureReferences()).sourceRoot;
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep), 'Supplemental source output must stay under repository out/');
    assert(sourceRoot !== outputRoot && !outputRoot.startsWith(sourceRoot + path.sep) && !sourceRoot.startsWith(outputRoot + path.sep),
        'Supplemental output overlaps original source cache');
    await assertNoSymlink(outputRoot);
    const input = await inputs(sourceRoot); const root = path.join(outputRoot, 'compiler-port-source-closure');
    await assertNoSymlink(root); await mkdir(outputRoot, { recursive: true, mode: 0o700 }); await mkdir(root, { recursive: false, mode: 0o700 });
    for (const [filename, bytes] of [...input.originals].map(([filename, bytes]) => ['original/' + filename, bytes]).concat(input.outputs.map(value => [value.path, value.bytes]))) {
        const output = path.join(root, relativePath(filename)); await assertNoSymlink(output); await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
        await writeFile(output, bytes, { flag: 'wx', mode: 0o600 });
    }
    for (const pin of input.lock.files) verifyFile(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), pin);
    const receipt = receiptFor(root, input, sha256(await readRegular(fileURLToPath(import.meta.url))));
    const receiptPath = path.join(root, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { commonSources: receipt.commonSources, replacedOriginalPaths: receipt.replacedOriginalPaths,
        additionalOriginalPaths: receipt.additionalOriginalPaths, sourceFiles: receipt.sourceFiles,
        originalSourceRoot: path.join(root, 'original'), receipt, receiptPath };
}

export async function verifySourceClosure(root) {
    root = path.resolve(root); await assertNoSymlink(root);
    const input = await inputs(path.join(root, 'original')); const receiptBytes = await readRegular(path.join(root, 'receipt.json'));
    const receipt = JSON.parse(receiptBytes);
    assert.deepEqual(receipt, receiptFor(root, input, sha256(await readRegular(fileURLToPath(import.meta.url)))), 'Stale supplemental source receipt');
    for (const output of input.outputs) assert.deepEqual(await readRegular(path.join(root, output.path)), output.bytes, 'Supplemental compiler source changed');
    return { root, receipt, commonSources: receipt.commonSources, receiptSha256: sha256(receiptBytes) };
}
