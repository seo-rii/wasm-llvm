import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);

export async function prepareFlagsSources({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot);
    outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep));
    await assertNoSymlink(sourceRoot);
    await assertNoSymlink(outputRoot);
    const recipe = JSON.parse(await readRegular(path.join(here, 'sources.lock.json')));
    for (const pin of recipe.sources) {
        verifyFile(await readRegular(path.join(sourceRoot, relativePath(pin.path)), pin.bytes), pin);
    }
    const generated = path.join(outputRoot, 'compiler-port-flags');
    await execute('python3', [path.join(here, 'generate.py'), '--source-root', sourceRoot, '--output', generated],
        { timeout: 10000, maxBuffer: 65536 });
    const receipt = JSON.parse(await readRegular(path.join(generated, 'receipt.json')));
    assert.equal(receipt.source.commit, recipe.source.commit);
    const commonSources = [];
    for (const pin of receipt.sources) {
        const filename = path.join(generated, relativePath(pin.path));
        const bytes = await readRegular(filename, pin.bytes);
        assert.equal(bytes.length, pin.bytes);
        assert.equal(sha256(bytes), pin.sha256);
        commonSources.push(filename);
    }
    return { receipt, commonSources };
}
