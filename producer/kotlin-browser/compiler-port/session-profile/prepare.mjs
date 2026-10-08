import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');

/** Keep actual common/Wasm checker registrations; separate other target shells. */
export async function prepareSessionProfile({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep));
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json'));
    const lock = JSON.parse(lockBytes);
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    const original = verifyFile(await readRegular(path.join(sourceRoot, lock.original.path), lock.original.bytes), lock.original);
    const source = original.toString('utf8');
    const functions = [...source.matchAll(/^fun FirSessionConfigurator\.(\w+)\(\) \{\n[\s\S]*?^\}/gm)];
    assert.equal(functions.length, lock.retainedFunctions.length + lock.excludedFunctions.length);
    assert.equal(new Set(functions.map((match) => match[1])).size, functions.length);
    let portable = source;
    const retained = [], excluded = [];
    for (const match of functions) {
        if (lock.retainedFunctions.includes(match[1])) retained.push({ name: match[1], bodySha256: sha256(Buffer.from(match[0])) });
        else {
            assert(lock.excludedFunctions.includes(match[1]), 'Unreviewed target checker function');
            excluded.push({ name: match[1], bodySha256: sha256(Buffer.from(match[0])) });
            portable = portable.replace(match[0] + '\n', '');
        }
    }
    for (const prefix of lock.excludedImportPrefixes) {
        assert(/^[a-zA-Z0-9_.]+\.$/.test(prefix));
        const lines = portable.split('\n');
        assert(lines.some((line) => line.startsWith('import ' + prefix)), 'Missing excluded target import');
        portable = lines.filter((line) => !line.startsWith('import ' + prefix)).join('\n');
    }
    for (const match of functions) {
        if (lock.retainedFunctions.includes(match[1])) assert(portable.includes(match[0]), 'Common/Wasm checker registration changed');
    }
    const bytes = Buffer.from(portable);
    assert.equal(bytes.length, lock.portable.bytes); assert.equal(sha256(bytes), lock.portable.sha256);
    const filename = path.join(outputRoot, lock.original.path);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    const receipt = { schemaVersion: 1, kind: 'official-common-wasm-checker-source-profile', source: lock.source,
        lockSha256: sha256(lockBytes), original: lock.original, portable: lock.portable,
        retained, excluded, algorithmBodiesChanged: false,
        browserCompiler: 'not-built', publicLanguageSupport: false };
    await writeJson(path.join(outputRoot, 'session-profile-inputs.json'), receipt);
    return { commonSources: [filename], receipt };
}
