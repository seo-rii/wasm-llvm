import assert from 'node:assert/strict';
import { visitorDeclarations } from '../descriptor-visitor-contract/transform.mjs';

/** Exact type-only substitutions, with original nonnull entry behavior retained. */
export function mapVisitorVoid(input, recipes) {
    let source = input.toString();
    for (const recipe of recipes) {
        const rows = visitorDeclarations(Buffer.from(recipe.input)); assert.equal(rows.length, 1);
        const row = rows[0]; assert.equal(row.method, 'acceptVoid'); assert.equal(row.bodyKind, 'block');
        assert.equal(row.nullable, recipe.originalNullable); assert.equal(row.body, recipe.originalBody);
        assert(row.header.includes('DeclarationDescriptorVisitor<Void, Void>'));
        assert.equal((row.header.match(/\bVoid\b/g) ?? []).length, 2);
        let header = row.header.replace('DeclarationDescriptorVisitor<Void, Void>', 'DeclarationDescriptorVisitor<Nothing?, Nothing?>');
        const tail = recipe.input.slice(row.header.length), bodyOffset = tail.indexOf(row.body); assert(bodyOffset >= 0);
        let after;
        if (row.nullable) { assert.equal(recipe.nullMessage, null); after = header + tail; }
        else {
            assert.equal(recipe.nullMessage, 'Parameter specified as non-null is null: method ' + recipe.owner + '.acceptVoid, parameter visitor');
            header = header.replace('Nothing?>)', 'Nothing?>?)');
            const check = '        if (visitor == null) throw NullPointerException(' + JSON.stringify(recipe.nullMessage) + ')';
            after = header + tail.slice(0, bodyOffset) + '{\n' + check + row.body.slice(1);
        }
        assert.equal(after, recipe.prepared, 'Prepared Void span exceeds the exact permitted type/check encoding');
    }
    for (const recipe of [...recipes].sort((a, b) => b.start - a.start)) {
        assert.equal(source.slice(recipe.start, recipe.start + recipe.input.length), recipe.input, 'Sealed Void declaration changed');
        source = source.slice(0, recipe.start) + recipe.prepared + source.slice(recipe.start + recipe.input.length);
    }
    let restored = source;
    const rows = visitorDeclarations(Buffer.from(source)).filter(row => row.method === 'acceptVoid');
    assert.equal(rows.length, recipes.length);
    for (let index = rows.length - 1; index >= 0; index--) {
        assert.equal(rows[index].span, recipes[index].prepared);
        restored = restored.slice(0, rows[index].start) + recipes[index].input + restored.slice(rows[index].end);
    }
    assert.equal(restored, input.toString(), 'Only sealed visitor signatures and checks may change');
    return Buffer.from(source);
}

// Preserve UTF-16 offsets; strings/comments cannot establish a type binding.
export function codeMask(text) {
    let out = '', position = 0;
    const masked = s => s.replace(/[^\r\n]/g, ' ');
    while (position < text.length) {
        const rest = text.slice(position);
        if (rest.startsWith('//')) {
            let end = text.indexOf('\n', position); if (end < 0) end = text.length;
            out += masked(text.slice(position, end)); position = end;
        } else if (rest.startsWith('/*')) {
            let end = position + 2, depth = 1;
            while (end < text.length && depth) {
                if (text.slice(end, end + 2) === '/*') { depth++; end += 2; }
                else if (text.slice(end, end + 2) === '*/') { depth--; end += 2; }
                else end++;
            }
            assert.equal(depth, 0); out += masked(text.slice(position, end)); position = end;
        } else if (rest.startsWith('"""')) {
            const last = text.indexOf('"""', position + 3); assert(last >= 0);
            const end = last + 3; out += masked(text.slice(position, end)); position = end;
        } else if (text[position] === '"' || text[position] === "'") {
            const quote = text[position]; let end = position + 1;
            while (end < text.length) {
                if (text[end] === '\\') end += 2;
                else if (text[end++] === quote) break;
            }
            out += masked(text.slice(position, end)); position = end;
        } else out += text[position++];
    }
    return out;
}

/** Reject new specialized visitor type expressions, aliases and changed bodies. */
export function inspectVoidProfile(sources, recipes, prepared = false) {
    const seen = new Set(); let declarations = 0, nullablePreserved = 0, checkedEntries = 0;
    for (const item of sources) {
        assert(!seen.has(item.path)); seen.add(item.path);
        const source = item.source.toString(), masked = codeMask(source);
        assert(!/\bimport\s+(?:java\.lang\.Void|org\.jetbrains\.kotlin\.descriptors\.DeclarationDescriptorVisitor)\s+as\s+/.test(masked), 'Unreviewed visitor/Void import alias');
        assert(!/\btypealias\s+\w+[^\n=]*=\s*(?:org\.jetbrains\.kotlin\.descriptors\.)?DeclarationDescriptorVisitor\b/.test(masked), 'Unreviewed visitor type alias');
        const expected = recipes.filter(recipe => recipe.path === item.path);
        const rows = visitorDeclarations(Buffer.from(source)).filter(row => row.method === 'acceptVoid');
        if (expected.length) {
            assert.equal(rows.length, expected.length, 'Unknown or missing Void override');
            for (let index = 0; index < expected.length; index++) {
                const recipe = expected[index], span = prepared ? recipe.prepared : recipe.input;
                assert.equal(rows[index].span, span, 'Selected Void body changed: ' + item.path);
                declarations++; if (recipe.originalNullable) nullablePreserved++; else checkedEntries++;
            }
        }
        let outside = masked;
        for (let index = rows.length - 1; index >= 0; index--) {
            if (!expected[index]) continue;
            outside = outside.slice(0, rows[index].start) + masked.slice(rows[index].start, rows[index].end).replace(/[^\r\n]/g, ' ') + outside.slice(rows[index].end);
        }
        // The canonical base is preserved by full predecessor replay, not transformed.
        if (item.path === 'compiler-port-descriptors/generated/DeclarationDescriptor.kt') continue;
        assert(!/\bDeclarationDescriptorVisitor\s*<[^>]*\b(?:Void|java\.lang\.Void)\b[^>]*>/.test(outside), 'Unknown specialized Void consumer');
        assert(!/\bDeclarationDescriptorVisitor\s*<\s*Nothing\?\s*,\s*Nothing\?\s*>/.test(outside), 'Unknown null-only visitor consumer');
    }
    for (const recipe of recipes) assert(seen.has(recipe.path), 'Missing specialized visitor source');
    assert.equal(declarations, 17); assert.equal(nullablePreserved, 14); assert.equal(checkedEntries, 3);
    return { specializedDeclarations: declarations, nullableBodiesPreserved: nullablePreserved, nonnullEntriesChecked: checkedEntries,
        genericVoidTokensMapped: prepared ? 34 : 0, javaDescriptorImplementationFamilyClosed: false };
}
