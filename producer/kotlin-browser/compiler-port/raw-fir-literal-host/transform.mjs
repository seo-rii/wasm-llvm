import assert from 'node:assert/strict';
import { normalizeTowerImports } from '../tower-group/transform.mjs';
export { assembleImports as assembleRawFirLiteralImports } from '../type-substitutor-getter/prepare.mjs';

export const TARGET = 'compiler/fir/raw-fir/raw-fir.common/src/org/jetbrains/kotlin/fir/builder/AbstractRawFirBuilder.kt';
export const HELPERS = 'compiler-port-raw-fir-literal/RawFirLiteralHelpers.kt';
export const RECIPE = [
    ['import com.intellij.psi.PsiElement\n', '', 1],
    ['import org.jetbrains.kotlin.parsing.*', 'import org.jetbrains.kotlin.portable.rawfir.*', 1],
    ['import org.jetbrains.kotlin.psi.KtPsiUtil', 'import org.jetbrains.kotlin.fir.lightTree.converter.unquoteParserIdentifier', 1],
    ['import org.jetbrains.kotlin.psi.utils.hasIllegallyPositionedUnderscore', 'import org.jetbrains.kotlin.portable.rawfir.hasIllegallyPositionedUnderscore', 1],
    ['import org.jetbrains.kotlin.psi.utils.parseNumericLiteral', 'import org.jetbrains.kotlin.portable.rawfir.parseNumericLiteral as parseRawFirNumericLiteral', 1],
    ['import org.jetbrains.kotlin.utils.exceptions.withPsiEntry\n', '', 1],
    ['KtPsiUtil.unquoteIdentifier(rawName)', 'unquoteParserIdentifier(rawName)', 1],
    ['        when (element) {\n            is PsiElement -> withPsiEntry(name, element)\n            else -> withEntry(name, element) { it.asText }\n        }', '        withEntry(name, element) { it.asText }', 1],
    ['parseNumericLiteral(this, isFloatingPointLiteral = false)', 'parseRawFirNumericLiteral(this, isFloatingPointLiteral = false)', 1],
    ['parseNumericLiteral(this, isFloatingPointLiteral = true)', 'parseRawFirNumericLiteral(this, isFloatingPointLiteral = true)', 1],
    ['${it::class.java.name}', '${it::class.qualifiedName ?: "<anonymous>"}', 1],
];
export const NUMERIC_RECIPE = [
    ['LiteralFormatUtil.removeUnderscores(text)', 'text.replace("_", "")', 1],
    ['java.lang.Long.parseUnsignedLong(number, radix)', 'number.toULong(radix).toLong()', 1],
    ['java.lang.Long.parseLong(number, radix)', 'number.toLong(radix)', 1],
    ['java.lang.Double.parseDouble(text)', 'text.toDouble()', 1],
    ['java.lang.Float.parseFloat(text)', 'text.toFloat()', 1],
];
function replace(text, changes) {
    for (const [before, after, count] of changes) {
        assert.equal(text.split(before).length - 1, count, 'Raw FIR host span changed: ' + before);
        text = text.split(before).join(after);
    }
    return text;
}
export function transformRawFirLiteral(original) { return Buffer.from(replace(original.toString(), RECIPE)); }
export function extractLiteralHelpers(constantOriginal, parsingOriginal, common = true) {
    const original = constantOriginal.toString(), start = original.indexOf('/**\n * Checks whether the [text] representation'),
        end = original.indexOf('/**\n * Converts the given [ConstantValueKind]');
    assert(start > 0 && end > start, 'Complete pure literal declaration range missing');
    let pure = original.slice(start, end);
    if (common) pure = replace(pure, NUMERIC_RECIPE);
    const wrappers = parsingOriginal.toString().split('\n').filter(line => /^(?:fun hasLongSuffix|fun hasUnsignedSuffix|fun hasUnsignedLongSuffix|fun parseBoolean\()/u.test(line));
    assert.equal(wrappers.length, 4, 'Complete parsing wrappers changed');
    const header = original.slice(0, original.indexOf('@file:')) + 'package org.jetbrains.kotlin.portable.rawfir\n\n'
        + 'import org.jetbrains.kotlin.utils.extractRadix\n'
        + (common ? '' : 'import org.jetbrains.kotlin.com.intellij.util.text.LiteralFormatUtil\n');
    return Buffer.from(header + '\n' + pure + wrappers.join('\n') + '\n');
}
export const normalizeRawFirImports = normalizeTowerImports;
