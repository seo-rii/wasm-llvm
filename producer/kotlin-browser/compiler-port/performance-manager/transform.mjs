import assert from 'node:assert/strict';
export const PREFIX = 'compiler-port-performance-manager/';
export function applyRecipe(original, recipe) {
    const source = original.toString(); let end = 0, result = '';
    for (const span of recipe) {
        assert(Number.isSafeInteger(span.start) && span.start >= end, 'Overlapping performance recipe span');
        assert.equal(source.slice(span.start, span.start + span.before.length), span.before, 'Performance recipe source span changed');
        result += source.slice(end, span.start) + span.after; end = span.start + span.before.length;
    }
    return Buffer.from(result + source.slice(end));
}
