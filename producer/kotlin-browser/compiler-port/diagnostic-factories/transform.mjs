import assert from 'node:assert/strict';
import { sha256 } from '../../scripts/source.mjs';

function removeMetadata(text, deletions) {
    deletions.sort((a, b) => a.startUtf16 - b.startUtf16);
    let output = '', offset = 0;
    for (const entry of deletions) {
        assert(entry.startUtf16 >= offset && entry.endUtf16 > entry.startUtf16 && entry.endUtf16 <= text.length, 'Overlapping diagnostic metadata edit');
        output += text.slice(offset, entry.startUtf16);
        entry.bytes = Buffer.byteLength(text.slice(entry.startUtf16, entry.endUtf16));
        entry.sha256 = sha256(Buffer.from(text.slice(entry.startUtf16, entry.endUtf16)));
        offset = entry.endUtf16;
    }
    return { text: output + text.slice(offset), deletions };
}

/** Delete only the source-pinned metadata declaration/forwarding spans. All algorithm bytes stay. */
export function transformFactorySource(text) {
    const deletions = [];
    function collect(pattern, role, required) {
        const matches = [...text.matchAll(pattern)];
        assert.equal(matches.length, required, 'Unexpected diagnostic factory constructor metadata form: ' + role);
        for (const match of matches) deletions.push({ role, startUtf16: match.index, endUtf16: match.index + match[0].length });
    }
    const classes = [...text.matchAll(/^(?:sealed )?class (KtDiagnosticFactory(?:N|ForDeprecation[0-4]|[0-4]))(?:<[^\n]+>)?\(/gm)].map((match) => match[1]);
    assert.equal(classes.length, 11, 'Unexpected diagnostic factory constructor set');
    assert.equal(new Set(classes).size, 11);
    collect(/^import kotlin\.reflect\.KClass\n/gm, 'jvm-metadata-import', 1);
    collect(/^    val psiType: KClass<\*>,\n/gm, 'jvm-metadata-property', 1);
    collect(/^    psiType: KClass<\*>,\n/gm, 'jvm-metadata-parameter', 10);
    collect(/\bpsiType, /g, 'jvm-metadata-forwarding', 15);
    const result = removeMetadata(text, deletions);
    assert(!/\b(?:psiType|KClass)\b/.test(result.text), 'Unexpected remaining diagnostic metadata reference');
    for (const name of ['getEffectiveSeverity', 'onOrFallback', 'createFallbackDiagnostic', 'KtMissingSourceElement', 'defaultPositioningStrategy', 'rendererFactory'])
        assert(result.text.includes(name), 'Diagnostic algorithm was removed: ' + name);
    return { ...result, constructorClasses: classes };
}

/** The generated source grammar is intentionally exact: unsupported new constructor forms fail. */
export function transformGeneratedDiagnostics(text, tableId, required) {
    const imports = new Map();
    const importRecords = [];
    for (const match of text.matchAll(/^import ((?:com\.intellij\.psi|org\.jetbrains\.kotlin\.psi)\.[A-Za-z0-9_.]+)\n/gm)) {
        const shortName = match[1].split('.').at(-1);
        assert(!imports.has(shortName), 'Ambiguous diagnostic PSI metadata import');
        imports.set(shortName, match[1]);
        importRecords.push({ name: shortName, text: match[0], startUtf16: match.index, endUtf16: match.index + match[0].length });
    }
    const declaration = /^    val ([A-Z0-9_]+): (KtDiagnosticFactory(?:ForDeprecation)?[0-4](?:<.+>)?) = (KtDiagnosticFactory(?:ForDeprecation)?[0-4])\("([A-Z0-9_]+)", ([A-Za-z0-9_.]+), (SourceElementPositioningStrategies\.[A-Z0-9_]+), ([A-Za-z0-9_]+)::class, getRendererFactory\(\)\)$/;
    const bindings = [], deletions = [];
    let offset = 0;
    for (const line of text.split('\n')) {
        if (/^    val /.test(line)) {
            const match = declaration.exec(line);
            assert(match, 'Unexpected generated diagnostic constructor form in ' + tableId + ': ' + line.slice(0, 120));
            const [, name, typedFactory, constructor, factoryName, severityOrFeature, strategy, psiName] = match;
            assert.equal(name, factoryName, 'Diagnostic registration name mismatch');
            assert(typedFactory === constructor || typedFactory.startsWith(constructor + '<'), 'Typed diagnostic factory constructor mismatch');
            assert(imports.has(psiName), 'Unbound PSI metadata class literal: ' + psiName);
            const metadata = ' ' + psiName + '::class,';
            assert.equal(line.split(metadata).length, 2, 'Ambiguous diagnostic metadata argument');
            const startUtf16 = offset + line.indexOf(metadata), endUtf16 = startUtf16 + metadata.length;
            deletions.push({ role: 'jvm-metadata-class-binding', startUtf16, endUtf16 });
            bindings.push({ table: tableId, diagnostic: name, factory: constructor, psiClass: imports.get(psiName),
                startUtf16, endUtf16 });
            assert(severityOrFeature && strategy);
        }
        offset += line.length + 1;
    }
    assert.equal(bindings.length, required, 'Generated diagnostic declaration count changed');
    assert.equal([...text.matchAll(/::class/g)].length, required, 'Unexpected class literal outside diagnostic metadata');
    let withoutBindings = removeMetadata(text, deletions.map((entry) => ({ ...entry }))).text;
    for (const record of importRecords) {
        const remaining = withoutBindings.replace(record.text, '');
        assert(!new RegExp('\\b' + record.name + '\\b').test(remaining), 'PSI import remains in a genuine diagnostic parameter/body: ' + record.name);
        deletions.push({ role: 'jvm-metadata-import', startUtf16: record.startUtf16, endUtf16: record.endUtf16 });
    }
    const result = removeMetadata(text, deletions);
    assert(!/::class|^import (?:com\.intellij\.psi|org\.jetbrains\.kotlin\.psi)\./m.test(result.text));
    assert(result.text.includes('override fun getRendererFactory(): BaseDiagnosticRendererFactory ='), 'Renderer selection was removed');
    return { ...result, bindings };
}

export function encodeBindings(bindings) {
    return Buffer.from('[\n' + bindings.map((record) => '  ' + JSON.stringify(record)).join(',\n') + '\n]\n');
}
