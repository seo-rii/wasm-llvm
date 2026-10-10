import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readJson, readRegular, verifyFile } from '../../scripts/source.mjs';
import { prepareHostSources } from './prepare.mjs';
import { assertMappingBodyPreserved, mappingPath, originalJvmMapping } from './source-lines-probe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources');
const execute = promisify(execFile);

test('common search pins identify the same official compiler/stdlib source and actual live view algorithm', async () => {
    const host = await readJson(path.join(here, 'sources.lock.json'));
    const stdlib = await readJson(path.join(here, '../../stdlib-probe/recipe.json'));
    assert.equal(host.source.commit, stdlib.source.commit);
    assert.equal(host.sourceLinesSearch.commonApi, 'IntArray.asList() live view and List.binarySearch(Int)');
    for (const pin of host.sourceLinesSearch.references) {
        const expected = stdlib.files.find(value => value.path === pin.path); assert(expected);
        for (const key of ['bytes', 'sha256', 'gitBlob']) assert.equal(pin[key], expected[key]);
        verifyFile(await readRegular(path.join(repository, 'out/kotlin-stdlib-probe/builds/run-c4fcdcdc/sources', pin.path)), pin);
    }
});

test('the applied host patch changes only the common search receiver in retained official mapping bodies', async () => {
    const parent = path.join(repository, 'out/kotlin-source-lines-integrity'); await mkdir(parent, { recursive: true });
    const outputRoot = await mkdtemp(path.join(parent, 'run-')); await execute('git', ['init', '--quiet', outputRoot]);
    const original = (await readRegular(path.join(sourceRoot, mappingPath))).toString('utf8');
    const result = await prepareHostSources({ sourceRoot, outputRoot });
    const portable = (await readRegular(path.join(outputRoot, mappingPath))).toString('utf8');
    assertMappingBodyPreserved(original, portable);
    assert.throws(() => assertMappingBodyPreserved(original, portable.replace('return if (index >= 0) index else -index - 2', 'return index')), /mapping methods changed/);
    assert.throws(() => assertMappingBodyPreserved(original, portable.replace("if (c == '\\n')", "if (c == '\\r')")), /offset construction changed/);
    const relocated = originalJvmMapping(original);
    assert.equal(relocated.replaceAll('import org.jetbrains.kotlin.com.intellij.', 'import com.intellij.'), original);
    assert.equal(result.receipt.commands.length, 3);
    assert.equal((await readRegular(path.join(sourceRoot, mappingPath))).toString('utf8'), original);
});
