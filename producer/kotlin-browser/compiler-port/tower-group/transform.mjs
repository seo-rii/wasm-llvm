import assert from 'node:assert/strict';

export const TARGET = 'compiler/fir/resolve/src/org/jetbrains/kotlin/fir/resolve/calls/tower/TowerGroup.kt';
export const NUMBERS = 'compiler-port-tower-group/TowerGroupNumbers.kt';
export const RECIPE = [
    ['import java.lang.Long.compareUnsigned', 'import org.jetbrains.kotlin.portable.tower.compareUnsigned', 1],
    ['import java.lang.Long.toBinaryString', 'import org.jetbrains.kotlin.portable.tower.toBinaryString', 1],
    ['if (javaClass != other?.javaClass) return false', 'if (other == null || this::class != other::class) return false', 2],
    ['Integer.bitCount(KIND_MASK)', 'KIND_MASK.countOneBits()', 1],
    ['Integer.bitCount(DEPTH_MASK)', 'DEPTH_MASK.countOneBits()', 1],
    ['java.lang.Long.numberOfLeadingZeros(USED_BITS_MASK)', 'USED_BITS_MASK.countLeadingZeroBits()', 1],
    ['invokeResolvePriority.compareTo(other.invokeResolvePriority)', 'invokeResolvePriority.ordinal - other.invokeResolvePriority.ordinal', 2],
];

export function transformTowerGroup(original) {
    let text = original.toString('utf8');
    for (const [before, after, count] of RECIPE) {
        assert.equal(text.split(before).length - 1, count, 'Genuine tower host span changed: ' + before);
        text = text.split(before).join(after);
    }
    return Buffer.from(text);
}

export function normalizeTowerImports(bytes, canonical, imports = []) {
    assert(Array.isArray(imports) && imports.every(name => typeof name === 'string' && name && !/[\r\n]/.test(name)));
    assert.equal(new Set(imports).size, imports.length, 'Duplicate tower assembly imports');
    const existing = new Set([...canonical.toString().matchAll(/^import ([^\r\n]+)$/gm)].map(match => match[1]));
    const additions = imports.filter(name => !existing.has(name));
    const markers = ['\nimport kotlin.jvm.*\n', '\nimport org.jetbrains.kotlin.portable.assertions.compilerAssert as assert\n'];
    if (additions.length) markers.push('\n' + additions.map(name => 'import ' + name).join('\n') + '\n');
    let text = bytes.toString(); const seen = new Set();
    for (let step = 0; step < markers.length; step++) {
        const pkg = /^package[^\r\n]+/m.exec(text); assert(pkg, 'Missing tower source package');
        const end = pkg.index + pkg[0].length, marker = markers.find(item => text.startsWith(item, end));
        if (!marker) break;
        assert(!seen.has(marker), 'Duplicate tower assembly import block'); seen.add(marker);
        text = text.slice(0, end) + text.slice(end + marker.length);
    }
    return Buffer.from(text);
}
