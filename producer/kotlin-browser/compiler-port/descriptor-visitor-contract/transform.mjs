import assert from 'node:assert/strict';

export const ORIGINAL = 'core/descriptors/src/org/jetbrains/kotlin/descriptors/DeclarationDescriptor.java';
export const MODULE = 'core/descriptors/src/org/jetbrains/kotlin/descriptors/ModuleDescriptor.kt';
export const OUTPUT = 'compiler-port-descriptors/generated/DeclarationDescriptor.kt';

// Lexical offsets only reject unrecorded declarations. Exact sealed source spans authorize edits.
function codeMask(text) {
    const out = text.split(''); let i = 0;
    const hide = (start, end) => { for (let j = start; j < end; j++) if (out[j] !== '\n' && out[j] !== '\r') out[j] = ' '; };
    while (i < text.length) {
        const start = i;
        if (text.startsWith('//', i)) {
            i = text.indexOf('\n', i); if (i < 0) i = text.length; hide(start, i);
        } else if (text.startsWith('/*', i)) {
            i += 2; let depth = 1;
            while (i < text.length && depth) {
                if (text.startsWith('/*', i)) { depth++; i += 2; }
                else if (text.startsWith('*/', i)) { depth--; i += 2; }
                else i++;
            }
            assert.equal(depth, 0, 'Unclosed Kotlin comment'); hide(start, i);
        } else if (text.startsWith('"""', i)) {
            i = text.indexOf('"""', i + 3); assert(i >= 0, 'Unclosed Kotlin raw string'); i += 3; hide(start, i);
        } else if (text[i] === '"' || text[i] === "'") {
            const quote = text[i++];
            while (i < text.length) { if (text[i] === '\\') i += 2; else if (text[i++] === quote) break; }
            assert.equal(text[i - 1], quote, 'Unclosed Kotlin string'); hide(start, i);
        } else i++;
    }
    return out.join('');
}

/** Record real override signatures/bodies, including the already-nullable ones. */
export function visitorDeclarations(input) {
    const text = input.toString('utf8'), masked = codeMask(text), rows = [];
    const names = new Set(['DeclarationDescriptorVisitor']);
    for (const match of masked.matchAll(/^import\s+org\.jetbrains\.kotlin\.descriptors\.DeclarationDescriptorVisitor\s+as\s+(\w+)\s*$/gm)) names.add(match[1]);
    for (const match of masked.matchAll(/\boverride\s+fun\s+/g)) {
        let position = match.index + match[0].length;
        if (masked[position] === '<') {
            let angles = 1; position++;
            while (position < masked.length && angles) {
                if (masked[position] === '<') angles++;
                else if (masked[position] === '>' && masked[position - 1] !== '-') angles--;
                position++;
            }
            assert.equal(angles, 0, 'Unclosed override type parameters');
            while (/\s/.test(masked[position] ?? '') && position < masked.length) position++;
        }
        const name = /^accept(?:Void)?\s*\(/.exec(masked.slice(position));
        if (!name) continue;
        let end = position + name[0].length, depth = 1;
        while (end < masked.length && depth) { if (masked[end] === '(') depth++; else if (masked[end] === ')') depth--; end++; }
        assert.equal(depth, 0, 'Unclosed visitor override');
        const header = text.slice(match.index, end);
        const type = new RegExp('\\b[A-Za-z_]\\w*\\s*:\\s*(?:org\\.jetbrains\\.kotlin\\.descriptors\\.)?(?:' + [...names].join('|') + ')\\s*<').exec(header);
        if (!type) continue;
        let typeEnd = type.index + type[0].length, angles = 1;
        while (typeEnd < header.length && angles) { if (header[typeEnd] === '<') angles++; else if (header[typeEnd] === '>') angles--; typeEnd++; }
        assert.equal(angles, 0, 'Unclosed visitor generic type');
        let bodyStart = end;
        while (bodyStart < masked.length && !['{', '='].includes(masked[bodyStart])) bodyStart++;
        assert(bodyStart < masked.length, 'Visitor declaration has no selected body');
        const kind = masked[bodyStart] === '{' ? 'block' : 'expression';
        let bodyEnd;
        if (kind === 'block') {
            bodyEnd = bodyStart + 1; depth = 1;
            while (bodyEnd < masked.length && depth) { if (masked[bodyEnd] === '{') depth++; else if (masked[bodyEnd] === '}') depth--; bodyEnd++; }
            assert.equal(depth, 0, 'Unclosed visitor body');
        } else {
            let first = bodyStart + 1; while (first < masked.length && /\s/.test(masked[first])) first++;
            bodyEnd = masked.indexOf('\n', first); if (bodyEnd < 0) bodyEnd = masked.length;
        }
        rows.push({ method: /\bacceptVoid\s*\(/.test(header) ? 'acceptVoid' : 'accept', nullable: /^\s*\?/.test(header.slice(typeEnd)),
            start: match.index, end: bodyEnd, header, bodyKind: kind, body: text.slice(bodyStart, bodyEnd),
            span: text.slice(match.index, bodyEnd), visitorTypeEnd: typeEnd });
    }
    return rows;
}

/** Only the twelve sealed nonnull generic overrides gain a checked nullable entry. */
export function encodeVisitorEntries(input, recipes) {
    let text = input.toString('utf8');
    for (const recipe of recipes) {
        assert.equal(text.split(recipe.original).length, 2, 'Pinned nonnull visitor span changed: ' + recipe.owner);
        const declaration = visitorDeclarations(Buffer.from(recipe.original));
        assert.equal(declaration.length, 1); const row = declaration[0];
        assert.equal(row.method, 'accept'); assert.equal(row.nullable, false);
        assert.equal(row.body, recipe.originalBody); assert.equal(row.bodyKind, recipe.bodyKind);
        const header = row.header.slice(0, row.visitorTypeEnd) + '?' + row.header.slice(row.visitorTypeEnd);
        const tail = recipe.original.slice(row.header.length), bodyOffset = tail.indexOf(row.body);
        assert(bodyOffset >= 0);
        const check = '        if (visitor == null) throw NullPointerException(' + JSON.stringify(recipe.nullMessage) + ')';
        let after;
        if (row.bodyKind === 'block') after = header + tail.slice(0, bodyOffset) + '{\n' + check + row.body.slice(1);
        else {
            const expression = row.body.slice(1).trim();
            after = header + tail.slice(0, bodyOffset).replace(/\s+$/, ' ') + '{\n' + check + '\n        return ' + expression + '\n    }';
        }
        assert.equal(after, recipe.prepared, 'Prepared checked entry differs from sealed recipe');
        text = text.replace(recipe.original, after);
    }
    return Buffer.from(text);
}

/** Bind the full actual selection to every known nullable/nonnullable override. */
export function inspectVisitorConsumers(sources, contracts, prepared = false) {
    const expected = new Map(contracts.map(contract => [contract.path, contract]));
    const found = [], consumers = [], seen = new Set();
    for (const { path, source } of sources) {
        assert(!seen.has(path), 'Duplicate selected Kotlin path'); seen.add(path);
        const text = source.toString('utf8'), rows = visitorDeclarations(source);
        const names = ['DeclarationDescriptorVisitor'];
        for (const match of codeMask(text).matchAll(/^import\s+org\.jetbrains\.kotlin\.descriptors\.DeclarationDescriptorVisitor\s+as\s+(\w+)\s*$/gm)) names.push(match[1]);
        for (const name of names) assert(!new RegExp('\\btypealias\\s+[^\\n]*\\b' + name + '\\b').test(codeMask(text)), 'Unreviewed visitor type alias: ' + path);
        if (text.includes('DeclarationDescriptorVisitor')) consumers.push(path);
        if (!rows.length && !expected.has(path)) continue;
        const contract = expected.get(path); assert(contract, 'Unrecorded descriptor visitor override: ' + path);
        const wanted = prepared ? contract.preparedDeclarations : contract.declarations;
        assert.deepEqual(rows.map(({ span }) => span), wanted, 'Visitor override contract changed: ' + path);
        found.push({ path, generic: rows.filter(row => row.method === 'accept').length,
            nullable: rows.filter(row => row.nullable).length, nonnullVoid: rows.filter(row => row.method === 'acceptVoid' && !row.nullable).length });
    }
    for (const path of expected.keys()) assert(seen.has(path), 'Missing real visitor override source: ' + path);
    return { inspectedKotlinSources: sources.length, overrideFiles: found, consumerFiles: consumers,
        genericNonnullEntriesEncoded: prepared ? 12 : 0, originalNullableOverridesPreserved: 29, untouchedNonnullVoidOverrides: 3,
        lexicalOnly: true, limitation: 'Exact recorded declaration/body spans plus source pins. Lexical checks do not infer arbitrary Kotlin aliases, inherited methods or reflective calls; strings/interpolations are masked and compiler typechecking remains necessary.' };
}
