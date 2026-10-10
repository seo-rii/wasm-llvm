import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const originalRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');

async function withFixture(action) {
    const temporary = await mkdtemp(path.join(REPO, 'out/kotlin-identity-guard-'));
    const repository = path.join(temporary, 'repository');
    const unit = path.join(repository, 'producer/kotlin-browser/compiler-port/identity');
    const sourceRoot = path.join(repository, 'selected');
    const outputRoot = path.join(repository, 'out/common');
    try {
        const lock = JSON.parse(await readFile(path.join(HERE, 'sources.lock.json')));
        await mkdir(path.join(unit, 'patches'), { recursive: true, mode: 0o700 });
        for (const name of ['prepare.mjs', 'sources.lock.json', lock.adapter.path, lock.generator.path, lock.patch.path]) {
            await copyFile(path.join(HERE, name), path.join(unit, name));
        }
        const scripts = path.join(repository, 'producer/kotlin-browser/scripts');
        await mkdir(scripts, { recursive: true, mode: 0o700 });
        await copyFile(path.join(HERE, '../../scripts/source.mjs'), path.join(scripts, 'source.mjs'));
        for (const pin of [...lock.sources, ...lock.referenceDependencies]) {
            const filename = path.join(sourceRoot, pin.path);
            await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
            await copyFile(path.join(originalRoot, pin.path), filename);
        }
        const { prepareIdentitySources } = await import(pathToFileURL(path.join(unit, 'prepare.mjs')).href);
        await action({ repository, unit, lock, sourceRoot, outputRoot, prepareIdentitySources });
    } finally {
        assert(temporary.startsWith(path.join(REPO, 'out/kotlin-identity-guard-')));
        await rm(temporary, { recursive: true, force: true });
    }
}

test('preparation binds every original/patch/index byte and leaves the source unchanged', async () => {
    await withFixture(async ({ lock, sourceRoot, outputRoot, prepareIdentitySources }) => {
        const before = await Promise.all(lock.sources.map(pin => readFile(path.join(sourceRoot, pin.path))));
        const result = await prepareIdentitySources({ sourceRoot, outputRoot });
        assert.equal(result.commonSources.length, 8);
        assert.deepEqual(result.replacedOriginalPaths, lock.sources.map(pin => pin.path));
        assert.equal(result.receipt.readiness, false);
        for (let index = 0; index < lock.sources.length; index++) {
            assert.deepEqual(await readFile(path.join(sourceRoot, lock.sources[index].path)), before[index]);
        }
    });
});

test('changed selected upstream bytes are rejected', async () => {
    await withFixture(async ({ lock, sourceRoot, outputRoot, prepareIdentitySources }) => {
        const file = path.join(sourceRoot, lock.sources[0].path);
        await writeFile(file, Buffer.concat([await readFile(file), Buffer.from('\n')]));
        await assert.rejects(prepareIdentitySources({ sourceRoot, outputRoot }));
    });
});

test('changed sealed sibling reference bytes are rejected', async () => {
    await withFixture(async ({ lock, sourceRoot, outputRoot, prepareIdentitySources }) => {
        const file = path.join(sourceRoot, lock.referenceDependencies[0].path);
        await writeFile(file, Buffer.concat([await readFile(file), Buffer.from('\n')]));
        await assert.rejects(prepareIdentitySources({ sourceRoot, outputRoot }));
    });
});

test('changed portable key comparison source is rejected', async () => {
    await withFixture(async ({ unit, lock, sourceRoot, outputRoot, prepareIdentitySources }) => {
        const file = path.join(unit, lock.adapter.path);
        await writeFile(file, (await readFile(file, 'utf8')).replace('keysArray[index] === key', 'keysArray[index] == key'));
        await assert.rejects(prepareIdentitySources({ sourceRoot, outputRoot }));
    });
});

test('changed mechanical source generator is rejected', async () => {
    await withFixture(async ({ unit, lock, sourceRoot, outputRoot, prepareIdentitySources }) => {
        const file = path.join(unit, lock.generator.path);
        await writeFile(file, Buffer.concat([await readFile(file), Buffer.from('\n')]));
        await assert.rejects(prepareIdentitySources({ sourceRoot, outputRoot }));
    });
});

test('changed patch bytes are rejected', async () => {
    await withFixture(async ({ unit, lock, sourceRoot, outputRoot, prepareIdentitySources }) => {
        const file = path.join(unit, lock.patch.path);
        await writeFile(file, Buffer.concat([await readFile(file), Buffer.from('\n')]));
        await assert.rejects(prepareIdentitySources({ sourceRoot, outputRoot }));
    });
});

test('duplicate original path declarations are rejected', async () => {
    await withFixture(async ({ unit, lock, sourceRoot, outputRoot, prepareIdentitySources }) => {
        lock.sources[1] = lock.sources[0];
        await writeFile(path.join(unit, 'sources.lock.json'), JSON.stringify(lock));
        await assert.rejects(prepareIdentitySources({ sourceRoot, outputRoot }));
    });
});

test('production output cannot overwrite the selected original source root', async () => {
    await withFixture(async ({ sourceRoot, prepareIdentitySources }) => {
        await assert.rejects(prepareIdentitySources({ sourceRoot, outputRoot: sourceRoot }));
    });
});

test('prepared source output is write-once', async () => {
    await withFixture(async ({ sourceRoot, outputRoot, prepareIdentitySources }) => {
        await prepareIdentitySources({ sourceRoot, outputRoot });
        await assert.rejects(prepareIdentitySources({ sourceRoot, outputRoot }), { code: 'EEXIST' });
    });
});

test('a symlinked selected source file is rejected', async () => {
    await withFixture(async ({ lock, sourceRoot, outputRoot, prepareIdentitySources }) => {
        const file = path.join(sourceRoot, lock.sources[0].path);
        const copied = file + '.actual';
        await copyFile(file, copied); await rm(file); await symlink(copied, file);
        await assert.rejects(prepareIdentitySources({ sourceRoot, outputRoot }));
    });
});
