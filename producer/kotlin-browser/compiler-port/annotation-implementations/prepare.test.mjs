import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { prepareAnnotationImplementations, verifyAnnotationImplementations } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../../../..');
const sourceRoot = path.join(repo, 'out/kotlin-compiler-port/sources'), root = await mkdtemp(path.join(repo, 'out/kotlin-annotation-guards-'));
after(() => rm(root, { recursive: true, force: true }));
test('exact genuine references and complete generated output independently replay', async () => {
    const component = await prepareAnnotationImplementations({ sourceRoot, outputRoot: path.join(root, 'valid') });
    assert.deepEqual(await verifyAnnotationImplementations(component.outputRoot), component.receipt);
    assert.equal(component.receipt.originals.length, 5); assert.equal(component.replacedOriginalPaths.length, 2);
});
test('getter aliasing or renderer output edits are rejected', async () => {
    const component = await prepareAnnotationImplementations({ sourceRoot, outputRoot: path.join(root, 'body') });
    const filename = component.commonSources[0], original = await readFile(filename);
    const changed = Buffer.from(original.toString().replace('get() = valueArguments', 'get() = valueArguments.toMap()'));
    assert.notDeepEqual(changed, original); await writeFile(filename, changed);
    await assert.rejects(verifyAnnotationImplementations(component.outputRoot));
});
test('genuine default interface bytes and readiness claims cannot drift', async () => {
    const component = await prepareAnnotationImplementations({ sourceRoot, outputRoot: path.join(root, 'references') });
    const receipt = JSON.parse(await readFile(component.receiptPath)); receipt.fullCompilerBuilt = true;
    await writeFile(component.receiptPath, JSON.stringify(receipt)); await assert.rejects(verifyAnnotationImplementations(component.outputRoot));
    await writeFile(component.receiptPath, JSON.stringify(component.receipt));
    const filename = path.join(component.outputRoot, 'reference', component.receipt.originals.find(pin => pin.path.endsWith('/AnnotationDescriptor.kt')).path);
    await writeFile(filename, Buffer.concat([await readFile(filename), Buffer.from('\n// changed default interface\n')]));
    await assert.rejects(verifyAnnotationImplementations(component.outputRoot));
});
test('source overlap and existing output overwrite fail before replacing files', async () => {
    await assert.rejects(prepareAnnotationImplementations({ sourceRoot, outputRoot: sourceRoot }), /overlap/);
    const outputRoot = path.join(root, 'overwrite'); await prepareAnnotationImplementations({ sourceRoot, outputRoot });
    await assert.rejects(prepareAnnotationImplementations({ sourceRoot, outputRoot }), { code: 'EEXIST' });
});
