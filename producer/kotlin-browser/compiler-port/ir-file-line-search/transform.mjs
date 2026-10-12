import assert from 'node:assert/strict';

export const TARGET = 'compiler/ir/ir.tree/src/org/jetbrains/kotlin/ir/IrFileEntry.kt';
export const RECIPE = [
    ['lineStartOffsets.binarySearch(offset)', 'lineStartOffsets.asList().binarySearch(offset)', 1],
];
export function transformIrFileLineSearch(original) {
    let text = original.toString('utf8');
    for (const [before, after, count] of RECIPE) {
        assert.equal(text.split(before).length - 1, count, 'Genuine IR line search span changed');
        text = text.split(before).join(after);
    }
    return Buffer.from(text);
}
