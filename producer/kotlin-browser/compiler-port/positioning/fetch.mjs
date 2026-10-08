#!/usr/bin/env node
/** Bounded producer-only acquisition of the exact additional positioning source members. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile } from '../../scripts/source.mjs';
import { defaultPositioningSourceRoot } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export async function preparePositioningSourceCache({ positioningSourceRoot = defaultPositioningSourceRoot } = {}) {
const repository = path.resolve(here, '../../../..');
positioningSourceRoot = path.resolve(positioningSourceRoot);
assert(positioningSourceRoot.startsWith(path.join(repository, 'out') + path.sep), 'Positioning source cache must remain under repository out/');
const recipeBytes = await readRegular(path.join(here, 'positioning.recipe.json'));
const recipe = JSON.parse(recipeBytes);
assert.equal(recipe.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
await assertNoSymlink(positioningSourceRoot);
await mkdir(positioningSourceRoot, { recursive: true, mode: 0o700 });
let fetched = 0;
for (const pin of recipe.originals.filter((pin) => pin.sourceRoot === 'positioning-cache')) {
    const destination = path.join(positioningSourceRoot, relativePath(pin.path));
    await assertNoSymlink(destination);
    try { verifyFile(await readRegular(destination, pin.bytes), pin); continue; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const response = await fetch('https://raw.githubusercontent.com/JetBrains/kotlin/' + recipe.source.commit + '/' + pin.path,
        { signal: AbortSignal.timeout(30000), redirect: 'error' });
    assert.equal(response.status, 200, 'Pinned source unavailable: ' + pin.path);
    const reader = response.body.getReader();
    const parts = []; let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            assert(size <= pin.bytes, 'Pinned source exceeds reviewed size: ' + pin.path);
            parts.push(Buffer.from(value));
        }
    } catch (error) { await reader.cancel(); throw error; }
    const bytes = verifyFile(Buffer.concat(parts), pin);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await assertNoSymlink(destination);
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    fetched++;
}
// This describes verified immutable source members, not an executed compiler gate.
const pins = recipe.originals.filter((pin) => pin.sourceRoot === 'positioning-cache');
for (const pin of pins) verifyFile(await readRegular(path.join(positioningSourceRoot, relativePath(pin.path)), pin.bytes), pin);
const receipt = { schemaVersion: 1, kind: 'official-positioning-source-cache', source: recipe.source,
    sourceLockSha256: sha256(Buffer.from(JSON.stringify({ source: recipe.source, files: pins }))),
    files: pins, status: 'source-identity-verified', languageReadiness: false };
const receiptPath = path.join(positioningSourceRoot, 'positioning-cache.json');
const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
await assertNoSymlink(receiptPath);
try { assert.deepEqual(await readRegular(receiptPath, receiptBytes.byteLength), receiptBytes, 'Existing positioning cache receipt differs; use a fresh source cache'); }
catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(receiptPath, receiptBytes, { flag: 'wx', mode: 0o600 }); }
return { positioningSourceRoot, receiptPath, receipt, fetched };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    assert.equal(process.argv.length, 2, 'Source acquisition accepts no arbitrary URL or revision');
    const result = await preparePositioningSourceCache();
    console.log(JSON.stringify({ sourceRoot: result.positioningSourceRoot, verified: result.receipt.files.length, fetched: result.fetched, receiptPath: result.receiptPath }));
}
