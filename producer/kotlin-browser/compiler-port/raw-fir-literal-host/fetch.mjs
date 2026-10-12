import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertNoSymlink, readRegular, relativePath, responseBytes, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), execute = promisify(execFile);
// curl honors this environment's CA/proxy configuration; all returned content is still bounded and hash verified by the source reader.
async function curlFetcher(url) {
    const result = await execute('curl', ['--fail', '--location', '--silent', '--show-error', '--max-time', '30', url], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
    return new Response(result.stdout, { status: 200 });
}
export async function prepareRawFirLiteralSourceCache({ fetcher = curlFetcher } = {}) {
    const lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
    const identity = sha256(Buffer.from(JSON.stringify(lock.supplementalSources)));
    const sourceRoot = path.join(REPO, 'out/kotlin-raw-fir-literal-sources', identity);
    await assertNoSymlink(sourceRoot);
    const acquired = [];
    for (const pin of lock.supplementalSources) {
        const filename = path.join(sourceRoot, relativePath(pin.path)); let bytes;
        try { bytes = verifyFile(await readRegular(filename), pin); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            const url = 'https://raw.githubusercontent.com/JetBrains/kotlin/' + lock.source.commit + '/' + pin.path;
            bytes = verifyFile(await responseBytes(url, pin.bytes, fetcher), pin);
            await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
            try { await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); }
            catch (error) { if (error.code !== 'EEXIST') throw error; verifyFile(await readRegular(filename), pin); }
        }
        acquired.push(pin);
    }
    const receipt = { schemaVersion: 1, kind: 'pinned-raw-fir-literal-supplemental-cache', source: lock.source,
        sources: acquired, sourceTreeProof: lock.sourceTreeProof, fullCompilerBuilt: false, languageReadiness: false };
    const receiptPath = path.join(sourceRoot, 'receipt.json'), encoded = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
    try { assert.deepEqual(await readRegular(receiptPath), encoded); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await writeJson(receiptPath, receipt); }
    return { sourceRoot, receiptPath, receipt };
}
