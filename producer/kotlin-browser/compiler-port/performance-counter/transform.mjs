import assert from 'node:assert/strict';
export const COUNTER = 'core/util.runtime/src/org/jetbrains/kotlin/utils/PerformanceCounter.kt';
export const HOST = 'compiler-port-performance-counter/PerformanceCounterHost.kt';
export function transformCounter(original, recipe) {
    let source = original.toString('utf8'), boundary = source.length;
    for (const row of [...recipe].sort((a, b) => b.start - a.start)) {
        assert(row.start >= 0 && row.start + row.before.length <= boundary, 'Overlapping counter recipe');
        assert.equal(source.slice(row.start, row.start + row.before.length), row.before, 'Counter recipe source mismatch');
        source = source.slice(0, row.start) + row.after + source.slice(row.start + row.before.length);
        boundary = row.start;
    }
    return Buffer.from(source);
}
