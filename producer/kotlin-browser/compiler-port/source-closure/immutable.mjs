import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertNoSymlink, readRegular, relativePath, responseBytes, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareSourceClosureReferences } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); const REPO = path.resolve(HERE, '../../../..');
const execute = promisify(execFile);
const defaultCache = path.join(REPO, 'out/kotlin-source-closure-reference/immutable');

async function verifyInputs(root) {
    await assertNoSymlink(root);
    const lockBytes = await readRegular(path.join(HERE, 'immutable.lock.json')); const lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'official-compiler-immutable-wasmjs-dependency');
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775'); assert.equal(lock.version, '0.5.1');
    assert.equal(lock.languageReadiness, false); assert.equal(lock.files.length, 5);
    const files = new Map();
    for (const pin of lock.files) {
        const filename = relativePath(pin.path); assert(!files.has(filename));
        const bytes = await readRegular(path.join(root, filename), pin.bytes);
        assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'Immutable dependency content mismatch'); files.set(filename, bytes);
    }
    const property = verifyFile(await readRegular(path.join(root, 'upstream-versions.properties')), lock.upstreamVersionDeclaration).toString();
    for (const key of lock.declarationKeys) assert(property.split(/\r?\n/).includes(key + '=' + lock.version), 'Upstream immutable version changed');
    const metadata = JSON.parse(files.get(lock.rootModule)); const wasmMetadata = JSON.parse(files.get(lock.wasmModule));
    assert.deepEqual(metadata.variants.find(value => value.name === lock.selectedRootVariant.name), lock.selectedRootVariant);
    assert.equal(lock.selectedRootVariant['available-at'].version, lock.version);
    assert.equal(lock.selectedRootVariant['available-at'].module, 'kotlinx-collections-immutable-wasm-js');
    assert.deepEqual(wasmMetadata.variants.find(value => value.name === lock.selectedWasmVariant.name), lock.selectedWasmVariant);
    assert.equal(lock.selectedWasmVariant.attributes['org.jetbrains.kotlin.platform.type'], 'wasm');
    assert.equal(lock.selectedWasmVariant.attributes['org.jetbrains.kotlin.wasm.target'], 'js');
    const artifact = lock.selectedWasmVariant.files[0]; assert.equal(artifact.name, lock.library);
    assert.equal(artifact.size, files.get(lock.library).length); assert.equal(artifact.sha256, sha256(files.get(lock.library)));
    const manifestOutput = await execute('unzip', ['-p', path.join(root, lock.library), 'default/manifest'], { timeout: 10000, maxBuffer: 65536 });
    const manifest = Object.fromEntries(manifestOutput.stdout.trimEnd().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
    for (const [key, value] of Object.entries(lock.manifest)) assert.equal(manifest[key], value, 'Immutable KLIB target/ABI identity changed');
    assert.equal(manifest.wasm_targets, 'wasm-js'); assert.equal(manifest.depends, 'kotlin');
    return { lock, lockBytes, files, manifest: lock.manifest };
}

function receiptFor(input, toolHash) {
    return { schemaVersion: 1, kind: 'official-compiler-immutable-wasmjs-preparation', source: input.lock.source,
        version: input.lock.version, sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: toolHash,
        upstreamVersionDeclaration: input.lock.upstreamVersionDeclaration, files: input.lock.files, manifest: input.manifest,
        sourceProvenance: input.lock.sourceProvenance, library: input.lock.library,
        compilerCompatibility: 'not-run by artifact preparation', fullCompilerBuilt: false, languageReadiness: false };
}

export async function prepareImmutableDependency({ outputRoot, cacheRoot = defaultCache,
    sourceRoot, fetcher = fetch }) {
    if (sourceRoot === undefined) sourceRoot = (await prepareSourceClosureReferences({ fetcher })).sourceRoot;
    outputRoot = path.resolve(outputRoot); cacheRoot = path.resolve(cacheRoot); sourceRoot = path.resolve(sourceRoot);
    const versionSource = path.join(sourceRoot, 'gradle/versions.properties');
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    for (const cache of [cacheRoot, sourceRoot]) assert(outputRoot !== cache && !outputRoot.startsWith(cache + path.sep) && !cache.startsWith(outputRoot + path.sep), 'Immutable output overlaps original cache');
    for (const filename of [outputRoot, cacheRoot, versionSource]) await assertNoSymlink(filename);
    const lock = JSON.parse(await readRegular(path.join(HERE, 'immutable.lock.json')));
    const property = verifyFile(await readRegular(versionSource), lock.upstreamVersionDeclaration);
    const downloaded = [];
    for (const pin of lock.files) {
        const name = relativePath(pin.path); assert.equal(name, path.basename(name)); let bytes;
        try { bytes = await readRegular(path.join(cacheRoot, name), pin.bytes); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            assert(pin.url.startsWith('https://repo.maven.apache.org/maven2/org/jetbrains/kotlinx/'));
            bytes = await responseBytes(pin.url, pin.bytes, fetcher);
        }
        assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'Immutable dependency content mismatch'); downloaded.push([name, bytes]);
    }
    const root = path.join(outputRoot, 'compiler-immutable'); await assertNoSymlink(root);
    await mkdir(outputRoot, { recursive: true, mode: 0o700 }); await mkdir(root, { mode: 0o700 });
    for (const [name, bytes] of [...downloaded, ['upstream-versions.properties', property]]) await writeFile(path.join(root, name), bytes, { flag: 'wx', mode: 0o600 });
    const input = await verifyInputs(root); const receipt = receiptFor(input, sha256(await readRegular(fileURLToPath(import.meta.url))));
    const receiptPath = path.join(root, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { libraryPath: path.join(root, receipt.library), receipt, receiptPath };
}

export async function verifyImmutableDependency(root) {
    root = path.resolve(root); const input = await verifyInputs(root); const receiptBytes = await readRegular(path.join(root, 'receipt.json'));
    const receipt = JSON.parse(receiptBytes);
    assert.deepEqual(receipt, receiptFor(input, sha256(await readRegular(fileURLToPath(import.meta.url)))), 'Stale immutable dependency receipt');
    return { libraryPath: path.join(root, receipt.library), receipt, receiptSha256: sha256(receiptBytes) };
}
