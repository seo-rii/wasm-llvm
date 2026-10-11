import assert from 'node:assert/strict';

export const TARGET = 'compiler/fir/resolve/src/org/jetbrains/kotlin/fir/extensions/FirPredicateBasedProviderImpl.kt';
export const MULTIMAP = 'compiler-port-fir-predicate/FirPredicateMultimap.kt';
export const RECIPE = [
    ['import com.google.common.collect.LinkedHashMultimap', 'import org.jetbrains.kotlin.portable.predicate.LinkedHashMultimap', 1],
    ['import com.google.common.collect.Multimap', 'import org.jetbrains.kotlin.portable.predicate.Multimap', 1],
];
export function transformFirPredicate(original) {
    let text = original.toString('utf8');
    for (const [before, after, count] of RECIPE) {
        assert.equal(text.split(before).length - 1, count, 'Genuine predicate host span changed: ' + before);
        text = text.split(before).join(after);
    }
    return Buffer.from(text);
}

export function normalizeFirPredicateImports(bytes, canonical, imports = []) {
    assert(Array.isArray(imports) && imports.every(name => typeof name === 'string' && name && !/[\r\n]/.test(name)));
    assert.equal(new Set(imports).size, imports.length, 'Duplicate predicate assembly imports');
    const existing = new Set([...canonical.toString().matchAll(/^import ([^\r\n]+)$/gm)].map(match => match[1]));
    const additions = imports.filter(name => !existing.has(name));
    const markers = ['\nimport kotlin.jvm.*\n', '\nimport org.jetbrains.kotlin.portable.assertions.compilerAssert as assert\n'];
    if (additions.length) markers.push('\n' + additions.map(name => 'import ' + name).join('\n') + '\n');
    let text = bytes.toString(); const seen = new Set();
    for (let step = 0; step < markers.length; step++) {
        const pkg = /^package[^\r\n]+/m.exec(text); assert(pkg, 'Missing predicate source package');
        const end = pkg.index + pkg[0].length, marker = markers.find(item => text.startsWith(item, end));
        if (!marker) break;
        assert(!seen.has(marker), 'Duplicate predicate assembly import block'); seen.add(marker);
        text = text.slice(0, end) + text.slice(end + marker.length);
    }
    return Buffer.from(text);
}
