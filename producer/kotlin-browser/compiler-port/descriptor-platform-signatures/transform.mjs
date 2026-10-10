import assert from 'node:assert/strict';
import { sha256 } from '../../scripts/source.mjs';

export const GENERATED = 'compiler-port-descriptors/generated/';
export const IR = 'compiler/ir/ir.tree/src/org/jetbrains/kotlin/ir/descriptors/IrBasedDescriptors.kt';
export const BUILTIN = 'compiler/ir/ir.tree/src/org/jetbrains/kotlin/ir/descriptors/IrBuiltinFunctionDescriptor.kt';
export const CONSTRUCTOR = 'core/descriptors/src/org/jetbrains/kotlin/descriptors/ClassConstructorDescriptor.kt';
export const ALIAS = 'core/descriptors/src/org/jetbrains/kotlin/descriptors/impl/TypeAliasConstructorDescriptor.kt';
export const ERROR = 'core/descriptors/src/org/jetbrains/kotlin/types/error/ErrorFunctionDescriptor.kt';
export const METHODS = ['getUserData', 'setOverriddenDescriptors', 'copy', 'getMemberScope'];

/** Offsets only: comments and literals are hidden, never transformed. */
export function maskCode(text) {
    const out = text.split(''); let i = 0;
    const hide = (a, b) => { for (let j = a; j < b; j++) if (!'\r\n'.includes(out[j])) out[j] = ' '; };
    while (i < text.length) {
        const a = i;
        if (text.startsWith('//', i)) { i = text.indexOf('\n', i); if (i < 0) i = text.length; hide(a, i); }
        else if (text.startsWith('/*', i)) {
            i += 2; let depth = 1;
            while (i < text.length && depth) {
                if (text.startsWith('/*', i)) { depth++; i += 2; }
                else if (text.startsWith('*/', i)) { depth--; i += 2; } else i++;
            }
            assert.equal(depth, 0, 'Unclosed comment'); hide(a, i);
        } else if (text.startsWith('"""', i)) {
            i = text.indexOf('"""', i + 3); assert(i >= 0, 'Unclosed raw string'); i += 3; hide(a, i);
        } else if (text[i] === '"' || text[i] === "'") {
            const quote = text[i++];
            while (i < text.length) { if (text[i] === '\\') i += 2; else if (text[i++] === quote) break; }
            assert.equal(text[i - 1], quote, 'Unclosed literal'); hide(a, i);
        } else i++;
    }
    return out.join('');
}

export function signatureDeclarations(bytes) {
    const text = bytes.toString(), code = maskCode(text), result = [];
    assert(!/`(?:getUserData|setOverriddenDescriptors|copy|getMemberScope)`/.test(code), 'Unreviewed escaped descriptor method');
    for (const m of code.matchAll(/\bfun\s+(?:<[^{};]*?>\s+)?(?:[\w.<>?*]+\s*\.\s*)?(getUserData|setOverriddenDescriptors|copy|getMemberScope)\s*\(/g)) {
        let end = m.index + m[0].length, depth = 1;
        while (end < code.length && depth) { if (code[end] === '(') depth++; else if (code[end] === ')') depth--; end++; }
        assert.equal(depth, 0, 'Unclosed descriptor signature');
        const header = text.slice(m.index, end), method = m[1];
        if (method === 'copy' && !(header.includes('modality:') && header.includes('visibility:') && header.includes('copyOverrides:'))) continue;
        if (method === 'getUserData' && !header.includes('UserDataKey')) continue;
        if (method === 'setOverriddenDescriptors' && /\bmember\s*:/.test(header)) continue;
        if (method === 'getMemberScope' && !header.includes('typeArguments:')) continue;
        result.push({ method, header, start: m.index, end, line: text.slice(0, m.index).split('\n').length });
    }
    return result;
}

export function applySignatureRecipes(input, recipes) {
    const original = input.toString(); let text = original, last = original.length;
    const ordered = [...recipes].sort((a, b) => b.startUtf16 - a.startUtf16);
    // Exact file pins and nonoverlapping offsets also distinguish identical method bodies.
    for (const recipe of ordered) {
        assert(Number.isSafeInteger(recipe.startUtf16) && Number.isSafeInteger(recipe.endUtf16));
        assert(recipe.startUtf16 >= 0 && recipe.endUtf16 <= last && recipe.endUtf16 > recipe.startUtf16);
        assert.equal(original.slice(recipe.startUtf16, recipe.endUtf16), recipe.original, 'Original platform span changed: ' + recipe.owner);
        assert.equal(Buffer.byteLength(recipe.original), recipe.originalBytes);
        assert.equal(sha256(Buffer.from(recipe.original)), recipe.originalSha256);
        assert.equal(Buffer.byteLength(recipe.prepared), recipe.preparedBytes);
        assert.equal(sha256(Buffer.from(recipe.prepared)), recipe.preparedSha256);
        text = text.slice(0, recipe.startUtf16) + recipe.prepared + text.slice(recipe.endUtf16); last = recipe.startUtf16;
    }
    const result = Buffer.from(text); let reversed = result.toString();
    for (const recipe of ordered) {
        const start = recipe.startUtf16 + recipes.filter(item => item.endUtf16 <= recipe.startUtf16)
            .reduce((delta, item) => delta + item.prepared.length - item.original.length, 0);
        assert.equal(reversed.slice(start, start + recipe.prepared.length), recipe.prepared, 'Noninvertible descriptor recipe');
        reversed = reversed.slice(0, start) + recipe.original + reversed.slice(start + recipe.prepared.length);
    }
    assert.deepEqual(Buffer.from(reversed), input, 'Other selected bytes changed');
    return result;
}

export function inspectSignatureGraph(sources, contracts, prepared = false) {
    const wanted = new Map(contracts.map(item => [item.path, item])), seen = new Set(), declarations = [], callers = [];
    for (const { path, source } of sources) {
        assert(!seen.has(path), 'Duplicate selected logical path'); seen.add(path);
        const text = source.toString(), code = maskCode(text), rows = signatureDeclarations(source);
        if (rows.length || wanted.has(path)) {
            const contract = wanted.get(path); assert(contract, 'Unrecorded descriptor signature family: ' + path);
            assert.deepEqual(rows.map(row => row.header), prepared ? contract.prepared : contract.original,
                'Selected descriptor declarations changed: ' + path);
            declarations.push({ path, headers: rows.map(row => ({ method: row.method, header: row.header })) });
        }
        // Record all homonyms conservatively. These are lexical calls, not typed call-graph claims.
        for (const m of code.matchAll(/\b(getUserData|setOverriddenDescriptors|copy|getMemberScope)\s*(?:<[^>\n]*>)?\s*\(/g)) {
            if (rows.some(row => m.index >= row.start && m.index < row.end)) continue;
            callers.push({ path, method: m[1], line: code.slice(0, m.index).split('\n').length,
                context: text.slice(Math.max(0, m.index - 80), Math.min(text.length, m.index + 180)) });
        }
        assert(!/^\s*typealias\s+[^\n]*(?:CallableDescriptor|CallableMemberDescriptor|SimpleFunctionDescriptor|PropertyAccessorDescriptor|ClassDescriptor|ConstructorDescriptor|FunctionDescriptor|UserDataKey)\b/m.test(code),
            'Unreviewed descriptor type alias: ' + path);
        assert(!/^import\s+[^\n]*(?:\.(?:getUserData|setOverriddenDescriptors|copy|getMemberScope)|descriptors\.(?:CallableDescriptor|CallableMemberDescriptor|SimpleFunctionDescriptor|PropertyAccessorDescriptor|ClassDescriptor|ConstructorDescriptor|FunctionDescriptor|UserDataKey))\s+as\s+/m.test(code),
            'Unreviewed descriptor method/type alias: ' + path);
    }
    for (const logical of wanted.keys()) assert(seen.has(logical), 'Missing descriptor signature source: ' + logical);
    return { inspectedSources: sources.length, declarations, callers,
        lexicalOnly: true, limitation: 'Exact known signatures plus all lexical homonym calls. No arbitrary alias, inheritance, reflection or string interpolation resolution; whole compiler typecheck remains required.' };
}

export function algorithm(bytes) {
    return bytes.toString().replace(/^import[^\r\n]*\r?\n/gm, '').replace(/(^package[^\r\n]*\r?\n)\s*/m, '$1');
}
