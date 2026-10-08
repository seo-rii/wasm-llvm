import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');

export async function prepareCommonJavaSources({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep));
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const recipeBytes = await readRegular(path.join(here, 'sources.lock.json'));
    const recipe = JSON.parse(recipeBytes);
    assert.equal(recipe.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    const originals = new Map();
    for (const pin of recipe.originals) {
        originals.set(pin.path, verifyFile(await readRegular(path.join(sourceRoot, relativePath(pin.path)), pin.bytes), pin));
    }
    const root = path.join(outputRoot, 'compiler-port-common-java');
    await mkdir(root, { recursive: true });
    const commonSources = [], sources = [];
    for (const pin of recipe.portable) {
        const bytes = await readRegular(path.join(here, relativePath(pin.path)), pin.bytes);
        assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
        const filename = path.join(root, pin.path);
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        sources.push(pin); commonSources.push(filename);
    }
    const keywordSource = originals.get(recipe.keywords.sourcePath).toString('utf8');
    const start = keywordSource.indexOf('Arrays.asList(');
    const end = keywordSource.indexOf('\n    ));', start);
    assert(start > 0 && end > start);
    const literals = keywordSource.slice(start + 'Arrays.asList('.length, end);
    assert.equal(sha256(Buffer.from(literals)), recipe.keywords.literalBlockSha256);
    const words = [...literals.matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
    assert.equal(words.length, 28); assert.equal(new Set(words).size, 28);
    assert.equal(literals.replace(/"[a-z]+"/g, '').replace(/[\s,]/g, ''), '');
    const keywordBytes = Buffer.from('/* Copyright JetBrains s.r.o. Apache-2.0. Generated from exact pinned literals. */\n' +
        'package org.jetbrains.kotlin.renderer\n\nobject KeywordStringsGenerated {\n' +
        '    val KEYWORDS: MutableSet<String> = hashSetOf(\n' + words.map((word) => '        ' + JSON.stringify(word) + ',\n').join('') + '    )\n}\n');
    const keywordFile = path.join(root, 'KeywordStringsGenerated.kt');
    await writeFile(keywordFile, keywordBytes, { flag: 'wx', mode: 0o600 });
    sources.push({ path: path.basename(keywordFile), bytes: keywordBytes.length, sha256: sha256(keywordBytes) });
    commonSources.push(keywordFile);
    const receipt = { schemaVersion: 1, kind: 'official-compiler-small-java-source-port', source: recipe.source,
        recipeSha256: sha256(recipeBytes), originals: recipe.originals, sources,
        keywordOrder: 'HashSet-unordered; original literals and mutability preserved',
        propertyAliasImport: 'org.jetbrains.kotlin.portable.common.*', fullBrowserCompiler: false };
    await writeJson(path.join(root, 'common-java-inputs.json'), receipt);
    return { receipt, commonSources, propertyAliasImport: receipt.propertyAliasImport };
}
