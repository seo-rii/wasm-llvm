import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256, writeJson } from '../../scripts/source.mjs';
import { verifyJvmUtilityFinalSources } from './prepare.mjs';
import { DECLARATIONS, FACADES, REQUIRED, TARGETS, utilityDeclarations, utilityReferences } from './references.mjs';

test('all twelve pinned declarations and both JVM facades are conservatively recognized', () => {
    const declarations = Object.values(DECLARATIONS).flat(); assert.equal(declarations.length, 12);
    for (const { packageName, name } of declarations) {
        for (const source of [
            `package probe\nimport ${packageName}.${name} as Other\nval use = Other`,
            `package probe\nval use = ${packageName.split('.').join(' /* nested /* comment */ */ . ')} . \`${name}\``,
            `package ${packageName}\nval name = "${name.slice(0, 3)}" + "${name.slice(3)}"`,
            `package probe\n// ${name}`,
            `package probe\nval name = "${name.slice(0, -1)}\\u${name.charCodeAt(name.length - 1).toString(16).padStart(4, '0')}"`,
        ]) assert(utilityReferences(source).length > 0, source);
    }
    for (const facade of FACADES) assert(utilityReferences(`Class.forName("${facade}")`).length > 0);
    assert.deepEqual(utilityReferences('import com.intellij.util.PathUtil\nval file = PathUtil.getFileName(name)'), []);
    assert.deepEqual(utilityReferences('package org.jetbrains.kotlin.utils\nval paths: KotlinPaths = KotlinPathsFromHomeDir(home)'), []);
});

const sourceRoot = process.env.KOTLIN_JVM_UTILITY_SOURCE_ROOT;
test('exact generic Constructor extension inventory includes private helpers', { skip: !sourceRoot }, async () => {
    for (const target of TARGETS) {
        const text = (await readFile(path.join(sourceRoot, target))).toString();
        assert.deepEqual(utilityDeclarations(target, text), DECLARATIONS[target]);
        assert.throws(() => utilityDeclarations(target, text + '\nfun unrecordedTopLevelDeclaration() = Unit\n'), /declaration inventory changed/);
    }
});

const fixturePath = process.env.KOTLIN_JVM_UTILITY_FIXTURE;
test('public final guards protect the full actual graph, original bytes, receipt digest and physical owners', { skip: !fixturePath }, async () => {
    const fixture = JSON.parse(await readFile(fixturePath)), root = path.dirname(fixturePath), checks = [];
    const options = { outputRoot: fixture.outputRoot, expectedReceiptSha256: fixture.expectedReceiptSha256, retainedSources: fixture.afterUtilities };
    const reject = async (name, supplied, pattern) => { await assert.rejects(verifyJvmUtilityFinalSources(supplied), pattern); checks.push(name); };
    const pin = (logical, filename, bytes) => ({ path: logical, filename, bytes: bytes.length, sha256: sha256(bytes) });
    const initial = await verifyJvmUtilityFinalSources(options);
    await reject('external receipt digest is required', { ...options, expectedReceiptSha256: undefined }, /preparation receipt digest required/);
    const receiptPath = path.join(fixture.outputRoot, 'receipt.json'), receiptBytes = await readFile(receiptPath);
    try {
        const receipt = JSON.parse(receiptBytes); receipt.selection.sources.reverse();
        await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
        await reject('receipt inventory edits cannot self-attest', options, /preparation receipt changed/);
    } finally { await writeFile(receiptPath, receiptBytes); }
    const originalPath = path.join(fixture.outputRoot, 'original', TARGETS[4]), originalBytes = await readFile(originalPath);
    try {
        await writeFile(originalPath, Buffer.concat([originalBytes, Buffer.from('\n')]));
        await reject('full original reflection source snapshot is immutable', options, /Pinned source content mismatch/);
    } finally { await writeFile(originalPath, originalBytes); }
    const target = fixture.recovered.find(row => row.path === TARGETS[0]); assert(target);
    await reject('excluded target reintroduction', { ...options, retainedSources: [target, ...options.retainedSources] }, /Exact five utility targets/);
    await reject('target copied under replacement path', { ...options, retainedSources: [{ ...target, path: 'replacement/' + target.path }, ...options.retainedSources] }, /copied under a replacement path/);
    await reject('duplicate logical source', { ...options, retainedSources: [...options.retainedSources, options.retainedSources[0]] }, /Duplicate utility profile logical/);
    await reject('duplicate physical owner', { ...options, retainedSources: [{ ...options.retainedSources[0], path: 'DuplicateOwner.kt' }, ...options.retainedSources] }, /Duplicate utility profile physical/);
    await reject('stale actual input hash', { ...options, retainedSources: [{ ...options.retainedSources[0], sha256: '0'.repeat(64) }, ...options.retainedSources.slice(1)] }, /source hash changed/);
    for (const [name, source] of [
        ['new alias reference', 'package probe\nimport org.jetbrains.kotlin.utils.LibraryUtils as Libraries\nval use = Libraries.META_INF\n'],
        ['generic extension imported by alias', 'package probe\nimport org.jetbrains.kotlin.utils.genericParameterTypesWithEnclosingThis as types\n'],
        ['private-helper or reflective facade spelling', 'package probe\nval name = "MemoryLeak" + "DetectorKt"\n'],
    ]) {
        const filename = path.join(root, name.replaceAll(' ', '-') + '.kt'), bytes = Buffer.from(source);
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        await reject(name, { ...options, retainedSources: [pin(path.basename(filename), filename, bytes), ...options.retainedSources] }, /Actual selected source refers to an excluded JVM utility/);
    }
    const first = options.retainedSources[0], filename = path.join(root, 'IdenticalOwnerCopy.kt');
    await writeFile(filename, await readFile(first.filename), { flag: 'wx', mode: 0o600 });
    await reject('identical content cannot switch physical owner', { ...options, retainedSources: [{ ...first, filename }, ...options.retainedSources.slice(1)] }, /Final graph changed beyond exactly five/);
    const reordered = options.retainedSources.slice(); [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
    await reject('unrelated source ordering is preserved', { ...options, retainedSources: reordered }, /Final graph changed beyond exactly five/);
    await reject('reached KotlinPaths is not removable', { ...options, retainedSources: options.retainedSources.filter(row => row.path !== REQUIRED[5]) }, /Required reached algorithm boundary missing/);
    await reject('later disk and service mutations require verified receipt composition', { ...options, retainedSources: fixture.retainedSources }, /Final graph changed beyond exactly five/);
    const restored = await verifyJvmUtilityFinalSources(options); assert.deepEqual(restored, initial);
    assert.deepEqual(await readFile(receiptPath), receiptBytes); assert.deepEqual(await readFile(originalPath), originalBytes);
    const evidence = { schemaVersion: 1, kind: 'jvm-utility-actual-graph-integrity', result: 'pass', negativeGuards: checks.length, checks,
        actualSources: options.retainedSources.length, restoredFinalReceiptSha256: sha256(Buffer.from(JSON.stringify(restored))),
        fixture: { filename: fixturePath, bytes: (await readFile(fixturePath)).length, sha256: sha256(await readFile(fixturePath)) },
        fullCompilerBuilt: false, languageReadiness: false };
    await writeJson(path.join(root, 'integrity.json'), evidence); console.log(JSON.stringify({ result: 'pass', negativeGuards: checks.length, actualSources: options.retainedSources.length }));
});
