import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { prepareNullConstantValue } from '../null-constant-value-profile/prepare.mjs';
import { prepareJsAstSources } from '../js-ast/prepare.mjs';
import { bindCharConstant, prepareCharConstantFormat, projectCharFormatting, verifyCharConstantFormat } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources');
const root = await mkdtemp(path.join(repository, 'out/kotlin-char-constant-guards-'));
const preparedNullConstant = await prepareNullConstantValue({ sourceRoot, outputRoot: path.join(root, 'null') });
const preparedJsAst = await prepareJsAstSources({ sourceRoot, outputRoot: path.join(root, 'ast') });
const base = { sourceRoot, preparedNullConstant, preparedJsAst };
after(async () => rm(root, { recursive: true, force: true }));

test('nine exact formatting spans preserve every unrelated source byte', async () => {
    const before = await readFile(preparedNullConstant.commonSources[0]), transformed = bindCharConstant(before);
    assert.equal(transformed.changes.length, 9); let recovered = transformed.bytes.toString();
    for (const [original, common] of [...transformed.changes].reverse()) recovered = recovered.replace(common, original);
    assert.equal(recovered, before.toString());
    assert.throws(() => bindCharConstant(transformed.bytes));
    assert.throws(() => bindCharConstant(Buffer.concat([before, Buffer.from(transformed.changes[0][0])])));
    const projection = projectCharFormatting(transformed.bytes).toString();
    assert(projection.includes('class CharValue(val value: Char)')); assert(!projection.includes('ModuleDescriptor'));
    assert(!projection.includes('AnnotationArgumentVisitor'));
});

test('actual canonical predecessor and full AST dependencies are mandatory', async () => {
    const options = { ...base, outputRoot: path.join(root, 'replay') };
    const prepared = await prepareCharConstantFormat(options); await verifyCharConstantFormat(options);
    assert.equal(prepared.commonSources.length, 1); assert.equal(prepared.predecessorBindings.length, 1);
    await assert.rejects(prepareCharConstantFormat({ ...base, outputRoot: path.join(root, 'forged-predecessor'),
        preparedNullConstant: { ...preparedNullConstant, commonSources: prepared.commonSources } }));
    await assert.rejects(prepareCharConstantFormat({ ...base, outputRoot: path.join(root, 'forged-ast'),
        preparedJsAst: { ...preparedJsAst, receiptPath: preparedNullConstant.receiptPath } }));
});

test('changed methods and inflated readiness claims fail replay', async () => {
    const options = { ...base, outputRoot: path.join(root, 'changed') }, prepared = await prepareCharConstantFormat(options);
    const file = prepared.commonSources[0], bytes = await readFile(file);
    await writeFile(file, bytes.toString().replace('getPrintablePart(value)', '"?"'));
    await assert.rejects(verifyCharConstantFormat(options)); await writeFile(file, bytes);
    const receipt = JSON.parse(await readFile(prepared.receiptPath)); receipt.fullConstantsWasmExecuted = true;
    await writeFile(prepared.receiptPath, JSON.stringify(receipt)); await assert.rejects(verifyCharConstantFormat(options));
});

test('reused or overlapping output cannot overwrite predecessor/AST/source', async () => {
    for (const outputRoot of [sourceRoot, preparedNullConstant.outputRoot, preparedJsAst.outputRoot])
        await assert.rejects(prepareCharConstantFormat({ ...base, outputRoot }));
    const options = { ...base, outputRoot: path.join(root, 'reuse') };
    await prepareCharConstantFormat(options); await assert.rejects(prepareCharConstantFormat(options));
});
