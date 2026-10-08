import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');

export async function prepareVisibilitySources({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep));
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const recipeBytes = await readRegular(path.join(here, 'sources.lock.json'));
    const recipe = JSON.parse(recipeBytes);
    assert.equal(recipe.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    for (const pin of recipe.originals) verifyFile(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), pin);
    const source = await readRegular(path.join(here, recipe.portable.path), recipe.portable.bytes);
    assert.equal(source.length, recipe.portable.bytes); assert.equal(sha256(source), recipe.portable.sha256);
    const host = await readRegular(path.join(here, '../config/ConfigurationHost.kt'));
    assert.equal(sha256(host), recipe.readOnlyHost.sha256);
    const root = path.join(outputRoot, 'compiler-port-visibility'); await mkdir(root, { recursive: true });
    const filename = path.join(root, recipe.portable.path);
    await writeFile(filename, source, { flag: 'wx', mode: 0o600 });
    const receipt = { schemaVersion: 1, kind: 'official-descriptor-visibility-host-preparation', source: recipe.source,
        lockSha256: sha256(recipeBytes), originals: recipe.originals, portable: recipe.portable, readOnlyHost: recipe.readOnlyHost,
        explicitService: 'ModuleVisibilityHelper.EMPTY; original no-plugin default; real shouldSeeInternalsOf retained',
        parentTraversal: 'original strict/non-strict walk with reified instanceof rather than java.lang.Class',
        remainingConcreteDependencies: ['DescriptorUtils', 'actual class/module/type descriptors', 'TypeAliasConstructorDescriptor'],
        browserCompiler: 'not-built', publicLanguageSupport: false };
    await writeJson(path.join(root, 'visibility-inputs.json'), receipt);
    return { commonSources: [filename], receipt };
}
