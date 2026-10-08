import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, responseBytes, sha256, verifyFile } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
export const defaultParserProfileSourceCache = path.join(repository, 'out/kotlin-parser-profile-sources');

/** Fetch only the exact pure-helper source absent from the selected compiler source closure. */
export async function prepareParserProfileSourceCache({ cache = defaultParserProfileSourceCache, fetcher = fetch } = {}) {
    cache = path.resolve(cache);
    assert(cache.startsWith(path.join(repository, 'out') + path.sep), 'Parser profile source cache must stay under repository out/');
    await assertNoSymlink(cache);
    const recipeBytes = await readRegular(path.join(here, 'parser-profile.recipe.json'));
    const recipe = JSON.parse(recipeBytes);
    const acquired = [];
    for (const pin of recipe.supplementalSources) {
        const filename = path.join(cache, relativePath(pin.path));
        let bytes;
        try { bytes = verifyFile(await readRegular(filename, pin.bytes), pin); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            const url = 'https://raw.githubusercontent.com/JetBrains/kotlin/' + recipe.source.commit + '/' + pin.path;
            bytes = verifyFile(await responseBytes(url, pin.bytes, fetcher), pin);
            await assertNoSymlink(filename);
            await mkdir(path.dirname(filename), { recursive: true });
            try { await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); }
            catch (error) {
                if (error.code !== 'EEXIST') throw error;
                verifyFile(await readRegular(filename, pin.bytes), pin);
            }
        }
        acquired.push({ ...pin, acquisitionUrl: 'https://raw.githubusercontent.com/JetBrains/kotlin/' + recipe.source.commit + '/' + pin.path });
    }
    const receipt = { schemaVersion: 1, kind: 'official-parser-profile-supplemental-source-cache',
        source: recipe.source, recipeSha256: sha256(recipeBytes), sources: acquired, browserCompiler: 'not-built', languageReadiness: false };
    const receiptPath = path.join(cache, 'parser-profile-source-cache.json');
    const encoded = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
    await assertNoSymlink(receiptPath);
    try { assert.equal((await readRegular(receiptPath)).toString(), encoded.toString(), 'Existing source cache receipt differs'); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await writeFile(receiptPath, encoded, { flag: 'wx', mode: 0o600 });
    }
    return { supplementalSourceRoot: cache, receiptPath, receipt };
}
