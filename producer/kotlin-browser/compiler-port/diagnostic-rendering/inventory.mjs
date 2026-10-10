import assert from 'node:assert/strict';
import { sha256 } from '../../scripts/source.mjs';

// Source bookkeeping only. This lexer never receives or compiles user Kotlin.
function endQuoted(text, start) {
    const quote = text[start];
    if (text.startsWith('"""', start)) {
        const end = text.indexOf('"""', start + 3);
        assert(end >= 0, 'Unterminated checked-in raw string');
        return end + 3;
    }
    for (let i = start + 1; i < text.length; i++) {
        if (text[i] === '\\') { i++; continue; }
        if (text[i] === quote) return i + 1;
    }
    assert.fail('Unterminated checked-in quoted source');
}

function endComment(text, start) {
    if (text.startsWith('//', start)) {
        const end = text.indexOf('\n', start + 2);
        return end < 0 ? text.length : end;
    }
    let depth = 1;
    for (let i = start + 2; i < text.length; i++) {
        if (text.startsWith('/*', i)) { depth++; i++; }
        else if (text.startsWith('*/', i)) { if (--depth === 0) return i + 2; i++; }
    }
    assert.fail('Unterminated checked-in block comment');
}

function masked(text) {
    const result = text.split('');
    for (let i = 0; i < text.length;) {
        let end;
        if (text[i] === '"' || text[i] === "'") end = endQuoted(text, i);
        else if (text.startsWith('//', i) || text.startsWith('/*', i)) end = endComment(text, i);
        else { i++; continue; }
        for (let j = i; j < end; j++) if (result[j] !== '\n') result[j] = ' ';
        i = end;
    }
    return result.join('');
}

function argumentsAt(text, mask, open) {
    const arguments_ = [];
    const stack = ['('];
    let start = open + 1;
    for (let i = start; i < text.length; i++) {
        const ch = mask[i];
        if ('([{<'.includes(ch)) stack.push(ch);
        else if (ch === '>' && stack.at(-1) === '<') stack.pop();
        else if (')]}'.includes(ch)) {
            assert.equal(stack.pop(), { ')': '(', ']': '[', '}': '{' }[ch], 'Unexpected selected renderer source nesting');
            if (stack.length === 0) {
                const tail = text.slice(start, i).trim();
                if (tail) arguments_.push(tail);
                return { arguments: arguments_, end: i + 1 };
            }
        } else if (ch === ',' && stack.length === 1) {
            arguments_.push(text.slice(start, i).trim()); start = i + 1;
        }
    }
    assert.fail('Unterminated selected renderer registration');
}

function typeArguments(value) {
    const result = [];
    let depth = 0, start = 0;
    for (let i = 0; i < value.length; i++) {
        if (value[i] === '<') depth++;
        else if (value[i] === '>') depth--;
        else if (value[i] === ',' && depth === 0) { result.push(value.slice(start, i).trim()); start = i + 1; }
    }
    if (value.trim()) result.push(value.slice(start).trim());
    return result;
}

function literals(text) {
    const values = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '"') continue;
        const end = endQuoted(text, i), source = text.slice(i, end);
        const interpolation = /(^|[^\\])\$/.test(source);
        let value = null;
        if (!interpolation && !source.startsWith('"""')) {
            value = source.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, escaped) => {
                if (escaped.startsWith('u')) return String.fromCharCode(Number.parseInt(escaped.slice(1), 16));
                const chars = { t: '\t', b: '\b', n: '\n', r: '\r', "'": "'", '"': '"', '\\': '\\', '$': '$' };
                assert(Object.hasOwn(chars, escaped), 'Unexpected checked-in Kotlin string escape');
                return chars[escaped];
            });
        }
        values.push({ source, value, interpolation });
        i = end - 1;
    }
    return values;
}

/** Pair every checked-in map.put call with its actual generated factory types and source expression. */
export function inventoryTemplates(tables) {
    const records = [];
    for (const { id, path, text, declarations } of tables) {
        const factories = new Map();
        for (const match of declarations.matchAll(/^    val ([A-Z0-9_]+): KtDiagnosticFactory(?:ForDeprecation)?([0-4])(?:<(.+)>)? = /gm)) {
            const types = typeArguments(match[3] ?? '');
            assert.equal(types.length, Number(match[2]));
            factories.set(match[1], types);
        }
        const mask = masked(text);
        for (const match of mask.matchAll(/\bmap\s*\.\s*put\s*\(/g)) {
            const open = match.index + match[0].length - 1;
            const call = argumentsAt(text, mask, open);
            const [factory, patternExpression, ...renderers] = call.arguments;
            const factoryPath = factory.split('.');
            const selector = factoryPath.at(-1);
            const pairedFactory = selector === 'warningFactory' || selector === 'errorFactory';
            const name = factoryPath.at(pairedFactory ? -2 : -1);
            assert(factories.has(name), 'Unknown real factory in renderer registration: ' + name);
            const types = factories.get(name);
            assert.equal(renderers.length, types.length, 'Renderer/typed parameter arity mismatch: ' + name);
            assert(patternExpression, 'Missing actual diagnostic pattern');
            const raw = renderers.flatMap((renderer, index) => renderer === 'null' ? [{ index, type: types[index] }] : []);
            records.push({ table: id, path, diagnostic: name, factorySelector: pairedFactory ? selector : null,
                startUtf16: match.index, endUtf16: call.end,
                sourceSha256: sha256(Buffer.from(text.slice(match.index, call.end))),
                mode: types.length === 0 ? 'simple-no-MessageFormat' : 'parameterized-MessageFormat',
                parameterTypes: types, rendererExpressions: renderers, rawParameters: raw,
                patternExpression, literalParts: literals(patternExpression) });
        }
    }
    const raw = records.filter((record) => record.rawParameters.length);
    assert.equal(raw.length, 5, 'Selected unrendered-parameter profile changed');
    assert(raw.every((record) => record.rawParameters.length === 1 && record.rawParameters[0].index === 0 && record.rawParameters[0].type === 'Int'), 'Unclosed actual raw diagnostic parameter type');
    const expected = ['NO_TYPE_ARGUMENTS_ON_RHS', 'WRONG_NUMBER_OF_TYPE_ARGUMENTS', 'WRONG_NUMBER_OF_TYPE_ARGUMENTS_IN_GET_CLASS_WARNING', 'WRONG_NUMBER_OF_TYPE_ARGUMENTS_IN_LOCAL_CLASS_IN_LHS_WARNING', 'WRONG_NUMBER_OF_TYPE_ARGUMENTS_WARNING'];
    assert.deepEqual(raw.map((record) => record.diagnostic).sort(), expected);
    return { schemaVersion: 1, kind: 'selected-official-diagnostic-pattern-and-argument-inventory', records,
        rawParameterProfile: { diagnostics: raw.map((record) => record.diagnostic), type: 'Int', format: 'choice with nested number,integer' },
        formatterParameterBoundary: 'DiagnosticParameterRenderer.render returns String; exactly five approved null renderer arguments retain Int',
        tableRuntimeExecution: 'not-run' };
}
