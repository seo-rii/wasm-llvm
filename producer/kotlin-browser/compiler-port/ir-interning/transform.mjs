import assert from 'node:assert/strict';

export const TARGET = 'compiler/ir/serialization.common/src/org/jetbrains/kotlin/backend/common/serialization/IrInterningService.kt';
export const INTERNING_SET = 'compiler-port-ir-interning/CanonicalInterningSet.kt';
export const RECIPE = [
    ['import it.unimi.dsi.fastutil.Hash', 'import org.jetbrains.kotlin.portable.interning.Hash', 1],
    ['import it.unimi.dsi.fastutil.objects.ObjectOpenCustomHashSet', 'import org.jetbrains.kotlin.portable.interning.ObjectOpenCustomHashSet', 1],
    ['import it.unimi.dsi.fastutil.objects.ObjectOpenHashSet', 'import org.jetbrains.kotlin.portable.interning.ObjectOpenHashSet', 1],
];
export function transformIrInterning(original) {
    let text = original.toString('utf8');
    for (const [before, after, count] of RECIPE) {
        assert.equal(text.split(before).length - 1, count, 'Genuine interning import span changed: ' + before);
        text = text.split(before).join(after);
    }
    return Buffer.from(text);
}

export function normalizeIrInterningImports(bytes, canonical, imports = []) {
    assert(Array.isArray(imports) && imports.every(name => typeof name === 'string' && name && !/[\r\n]/.test(name)));
    assert.equal(new Set(imports).size, imports.length, 'Duplicate interning assembly imports');
    const existing = new Set([...canonical.toString().matchAll(/^import ([^\r\n]+)$/gm)].map(match => match[1]));
    const additions = imports.filter(name => !existing.has(name));
    const markers = ['\nimport kotlin.jvm.*\n', '\nimport org.jetbrains.kotlin.portable.assertions.compilerAssert as assert\n'];
    if (additions.length) markers.push('\n' + additions.map(name => 'import ' + name).join('\n') + '\n');
    let text = bytes.toString(); const seen = new Set();
    for (let step = 0; step < markers.length; step++) {
        const pkg = /^package[^\r\n]+/m.exec(text); assert(pkg, 'Missing interning source package');
        const end = pkg.index + pkg[0].length, marker = markers.find(item => text.startsWith(item, end));
        if (!marker) break;
        assert(!seen.has(marker), 'Duplicate interning assembly import block'); seen.add(marker);
        text = text.slice(0, end) + text.slice(end + marker.length);
    }
    return Buffer.from(text);
}
