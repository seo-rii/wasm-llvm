import assert from 'node:assert/strict';
import { sha256 } from '../../scripts/source.mjs';

function applyDeletions(text, deletions) {
    deletions.sort((a, b) => a.startUtf16 - b.startUtf16);
    let result = '', end = 0;
    for (const span of deletions) {
        assert(span.startUtf16 >= end && span.endUtf16 > span.startUtf16 && span.endUtf16 <= text.length, 'Overlapping diagnostic DSL edit');
        const bytes = Buffer.from(text.slice(span.startUtf16, span.endUtf16));
        span.bytes = bytes.length; span.sha256 = sha256(bytes);
        result += text.slice(end, span.startUtf16); end = span.endUtf16;
    }
    return { text: result + text.slice(end), deletions };
}

/** Remove recorded PSI metadata only; preserve every delegate algorithm byte. */
export function transformSourceDsl(text, sourceFreeLock) {
    const deletions = [];
    const original = Buffer.from(text);
    for (const part of sourceFreeLock.split.declarations) {
        assert.equal(sha256(original.subarray(part.start, part.end)), part.sha256);
        deletions.push({ role: 'source-free-declaration-owned-by-separate-unit', name: part.name,
            startUtf16: original.subarray(0, part.start).toString().length, endUtf16: original.subarray(0, part.end).toString().length });
    }
    function collect(pattern, role, count) {
        const matches = [...text.matchAll(pattern)]; assert.equal(matches.length, count, 'Unexpected source DSL metadata: ' + role);
        for (const match of matches) deletions.push({ role, startUtf16: match.index, endUtf16: match.index + match[0].length });
    }
    collect(/^import com\.intellij\.psi\.PsiElement\n/gm, 'psi-metadata-import', 1);
    collect(/^import kotlin\.reflect\.KClass\n/gm, 'class-metadata-import', 1);
    collect(/<reified P : PsiElement>/g, 'zero-payload-reified-psi-type-parameter', 3);
    collect(/reified P : PsiElement, /g, 'reified-psi-type-parameter', 14);
    collect(/P::class, /g, 'psi-class-literal-argument', 17);
    collect(/^    private val psiType: KClass<\*>,\n/gm, 'provider-psi-metadata-field', 10);
    collect(/psiType, /g, 'provider-psi-metadata-forwarding', 10);
    const result = applyDeletions(text, deletions);
    assert(!/\b(?:PsiElement|KClass|psiType|P)\b/.test(result.text));
    assert(!/fun (?:error|warning|info|strongWarning)WithoutSource|class SourcelessDiagnosticFactoryDelegateProvider/.test(result.text));
    for (const name of ['provideDelegate', 'DummyDelegate', 'prop.name', 'container.getRendererFactory()', 'positioningStrategy', 'featureForError'])
        assert(result.text.includes(name), 'Diagnostic algorithm omitted: ' + name);
    return result;
}

/** Each type argument is metadata, never a diagnostic payload or body use. */
export function transformDiagnosticContainer(text, requiredCount) {
    const deletions = [], bindings = [];
    const imported = /^import com\.intellij\.psi\.PsiElement\n/gm;
    const imports = [...text.matchAll(imported)]; assert.equal(imports.length, 1);
    deletions.push({ role: 'psi-metadata-import', startUtf16: imports[0].index, endUtf16: imports[0].index + imports[0][0].length });
    const calls = [...text.matchAll(/\b((?:error|warning|strongWarning|deprecationError)[0-4])<PsiElement(?:(, )|>)/g)];
    assert.equal(calls.length, requiredCount, 'Diagnostic PSI type argument inventory changed');
    for (const call of calls) {
        const genericStart = call.index + call[1].length;
        const start = call[2] ? genericStart + 1 : genericStart;
        const end = call.index + call[0].length;
        const prefix = text.slice(0, call.index);
        const properties = [...prefix.matchAll(/\bval ([A-Z0-9_]+)\s+by\s*/g)];
        const property = properties.at(-1);
        let diagnosticNames;
        if (property) diagnosticNames = [property[1]];
        else {
            assert(prefix.endsWith('private fun exportClashError() =\n    '), 'Unbound diagnostic delegate');
            diagnosticNames = [...text.matchAll(/\bval ([A-Z0-9_]+) by exportClashError\(\)/g)].map(match => match[1]);
            assert.equal(diagnosticNames.length, 4, 'Shared Wasm export-clash provider changed');
        }
        const span = { role: 'first-psi-metadata-type-argument', diagnostics: diagnosticNames, helper: call[1], startUtf16: start, endUtf16: end };
        deletions.push(span);
        for (const diagnostic of diagnosticNames) bindings.push({ diagnostic, helper: call[1], psiClass: 'com.intellij.psi.PsiElement' });
    }
    const result = applyDeletions(text, deletions);
    assert(!/\bPsiElement\b/.test(result.text), 'PSI type is used outside diagnostic metadata');
    assert(result.text.includes('getRendererFactory()'), 'Diagnostic renderer selection removed');
    return { ...result, bindings };
}
