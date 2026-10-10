import assert from 'node:assert/strict';
import { sha256 } from '../../scripts/source.mjs';
import { maskCode } from '../descriptor-platform-signatures/transform.mjs';

export function applyBuilderRecipes(bytes, recipes) {
    const original = bytes.toString(); let text = original, upper = original.length;
    for (const recipe of [...recipes].sort((a, b) => b.startUtf16 - a.startUtf16)) {
        assert(Number.isSafeInteger(recipe.startUtf16) && Number.isSafeInteger(recipe.endUtf16));
        assert(recipe.startUtf16 >= 0 && recipe.endUtf16 <= upper && recipe.endUtf16 > recipe.startUtf16);
        assert.equal(original.slice(recipe.startUtf16, recipe.endUtf16), recipe.original);
        assert.equal(sha256(Buffer.from(recipe.original)), recipe.originalSha256);
        assert.equal(sha256(Buffer.from(recipe.prepared)), recipe.preparedSha256);
        assert.equal(recipe.prepared, recipe.original.slice(0, -1) + '?>');
        text = text.slice(0, recipe.startUtf16) + recipe.prepared + text.slice(recipe.endUtf16);
        upper = recipe.startUtf16;
    }
    let reversed = text;
    for (const recipe of [...recipes].sort((a, b) => b.startUtf16 - a.startUtf16)) {
        const start = recipe.startUtf16 + recipes.filter(item => item.endUtf16 <= recipe.startUtf16)
            .reduce((delta, item) => delta + item.prepared.length - item.original.length, 0);
        assert.equal(reversed.slice(start, start + recipe.prepared.length), recipe.prepared);
        reversed = reversed.slice(0, start) + recipe.original + reversed.slice(start + recipe.prepared.length);
    }
    assert.deepEqual(Buffer.from(reversed), bytes, 'Untargeted builder bytes changed');
    return Buffer.from(text);
}

export function builderReferences(bytes) {
    const text = bytes.toString(), code = maskCode(text), references = [];
    assert(!/`(?:CopyBuilder|newCopyBuilder)`/.test(code), 'Unreviewed escaped builder name');
    assert(!/^\s*typealias\s+[^\n]*\bCopyBuilder\b/m.test(code), 'Unreviewed builder type alias');
    assert(!/^import\s+[^\n]*\.(?:CopyBuilder|newCopyBuilder)\s+as\s+/m.test(code), 'Unreviewed builder import alias');
    for (const match of code.matchAll(/\bCopyBuilder\s*</g)) {
        let end = match.index + match[0].length, depth = 1;
        while (end < code.length && depth) { if (code[end] === '<') depth++; else if (code[end] === '>') depth--; end++; }
        assert.equal(depth, 0, 'Unclosed builder type argument');
        references.push(text.slice(match.index, end));
    }
    return references;
}

export function guardBuilderSelection(sources, contracts, prepared = false) {
    const known = new Map(contracts.map(item => [item.path, item])), seen = new Set(), declarations = [], callers = [];
    for (const { path, source } of sources) {
        assert(!seen.has(path)); seen.add(path);
        const references = builderReferences(source), contract = known.get(path);
        if (references.length || contract || /\b(?:CopyBuilder|newCopyBuilder)\b/.test(maskCode(source.toString()))) {
            assert(contract, 'Unrecorded selected CopyBuilder family: ' + path);
            assert.deepEqual(references, prepared ? contract.prepared : contract.original, 'Selected builder contract changed: ' + path);
            declarations.push({ path, references });
        }
        for (const match of maskCode(source.toString()).matchAll(/\bnewCopyBuilder\s*\(/g))
            callers.push({ path, line: source.toString().slice(0, match.index).split('\n').length });
    }
    for (const path of known.keys()) assert(seen.has(path), 'Missing selected builder source: ' + path);
    return { inspectedSources: sources.length, declarations, callers, lexicalOnly: true,
        limitation: 'Exact selected generic type expressions and conservative homonym calls; arbitrary inheritance, reflection, aliases and string interpolation are unresolved.' };
}

export function algorithm(bytes) {
    return bytes.toString().replace(/^import[^\r\n]*\r?\n/gm, '').replace(/(^package[^\r\n]*\r?\n)\s*/m, '$1');
}
