import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, responseBytes, sha256 } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
export async function verifySourceMapTestLibraries({ root = path.join(REPO, 'out/kotlin-js-source-map-audit/test-libraries'), fetcher = fetch } = {}) {
    root = path.resolve(root); assert(root.startsWith(path.join(REPO, 'out') + path.sep)); await assertNoSymlink(root);
    const lockBytes = await readRegular(path.join(HERE, 'test-libraries.lock.json')), lock = JSON.parse(lockBytes);
    assert.equal(lock.version, '2.5.0-dev-10106'); assert.equal(lock.files.length, 4);
    const verified = [];
    for (const pin of lock.files) {
        const filename = path.join(root, pin.file); let bytes;
        try { bytes = await readRegular(filename, pin.bytes); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!bytes) {
            assert(pin.url.startsWith('https://redirector.kotlinlang.org/maven/bootstrap/org/jetbrains/kotlin/'));
            bytes = await responseBytes(pin.url, pin.bytes, fetcher, {}, { publicRedirect: true });
            assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
            await mkdir(root, { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        }
        assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256); verified.push({ ...pin, filename });
    }
    for (const [artifact, variantName, extension] of [['kotlin-test', 'jvmApiElements', '.jar'], ['kotlin-test-wasm-js', 'wasmJsApiElements', '.klib']]) {
        const metadata = JSON.parse(await readRegular(verified.find(pin => pin.file === artifact + '-' + lock.version + '.module').filename));
        const component = { group: 'org.jetbrains.kotlin', module: 'kotlin-test', version: lock.version,
            attributes: { 'org.gradle.status': 'release' } };
        if (artifact.endsWith('-wasm-js')) component.url = '../../kotlin-test/' + lock.version + '/kotlin-test-' + lock.version + '.module';
        assert.deepEqual(metadata.component, component);
        const variant = metadata.variants.find(value => value.name === variantName); assert(variant);
        const file = variant.files.find(value => value.name === artifact + '-' + lock.version + extension);
        const pin = verified.find(value => value.file === file.name); assert.equal(file.size, pin.bytes); assert.equal(file.sha256, pin.sha256);
        assert.equal(variant.dependencies.find(value => value.module === 'kotlin-stdlib').version.requires, lock.version);
        assert.equal(pin.publishedChecksum.algorithm, 'sha256'); assert.equal(pin.publishedChecksum.value, pin.sha256);
    }
    return { version: lock.version, lockSha256: sha256(lockBytes), artifacts: verified,
        jvm: verified.find(pin => pin.file.endsWith('.jar')).filename, wasm: verified.find(pin => pin.file.endsWith('.klib')).filename };
}
