import assert from 'node:assert/strict';
import { sha256 } from '../../scripts/source.mjs';

/** Lift the locked traversal, parameterizing its three concrete symbol operations. */
export function projectTraversal(source, pin) {
    const start = source.indexOf(pin.start);
    assert(start >= 0 && source.indexOf(pin.start, start + 1) === -1, 'Traversal start must be unique');
    const end = source.indexOf(pin.end, start) + pin.end.length;
    assert(end > start, 'Missing traversal end');
    const body = source.slice(start, end);
    assert.equal(Buffer.byteLength(body), pin.bytes);
    assert.equal(sha256(Buffer.from(body)), pin.sha256, 'Pinned fillUnboundSymbols traversal changed');
    let projected = body;
    const replacements = [
        [pin.start, 'fun <Declaration, Symbol> visitUnbound(cache: Map<out Declaration, Symbol>, isBound: (Symbol) -> Boolean, resolve: (Declaration) -> Unit, generate: (Declaration) -> Unit) {'],
        ['irSymbol.isBound', 'isBound(irSymbol)'],
        ['firDeclaration.lazyResolveToPhase(FirResolvePhase.ANNOTATION_ARGUMENTS)', 'resolve(firDeclaration)'],
        ['generateDeclaration(firDeclaration.symbol)', 'generate(firDeclaration)'],
    ];
    for (const [original, replacement] of replacements) {
        assert.equal(projected.split(original).length, 2, 'Traversal substitution must be unique');
        projected = projected.replace(original, replacement);
    }
    assert(!/\bFirCallableDeclaration\b|\bIrSymbol\b|\bFirResolvePhase\b/.test(projected));
    return {
        source: 'package org.jetbrains.kotlin.portable.firstorageprobe\n\n' + projected + '\n',
        originalSha256: pin.sha256,
        substitutions: replacements.map(([original, replacement]) => ({ original, replacement })),
        fullFirExecution: false,
    };
}
