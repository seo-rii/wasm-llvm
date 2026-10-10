import assert from 'node:assert/strict';
import { sha256 } from '../../scripts/source.mjs';

const prefix = 'compiler/fir/checkers/src/org/jetbrains/kotlin/fir/analysis/';
export const NAVIGATION_PATHS = [prefix + 'checkers/SourceNavigator.kt', prefix + 'FirSourceUtils.kt',
    prefix + 'checkers/FirKeywordUtils.kt', prefix + 'checkers/type/FirUnsupportedModifiersInFunctionTypeParameterChecker.kt'];
export const TOKEN_SET_PATH = 'compiler-port-positioning/TokenSet.kt';
export const HOST_ELEMENT_PATH = 'compiler/frontend.common/src/org/jetbrains/kotlin/KtSourceElement.kt';
export const SNAPSHOT_METHOD = 'snapshotForSourceTraversal';

// Locate one whole pinned declaration/branch. String literals and comments cannot
// accidentally terminate a span; every resulting span is separately hash-bound.
export function balancedSpan(text, marker) {
    assert.equal(text.split(marker).length, 2, 'Unique pinned boundary required: ' + marker);
    const start = text.indexOf(marker), opening = text.indexOf('{', start); assert(opening >= start);
    let depth = 0, quote = '', escaped = false, block = false, line = false;
    for (let index = opening; index < text.length; index++) {
        const char = text[index], next = text[index + 1];
        if (line) { if (char === '\n') line = false; continue; }
        if (block) { if (char === '*' && next === '/') { block = false; index++; } continue; }
        if (quote) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === quote) quote = ''; continue; }
        if (char === '/' && next === '/') { line = true; index++; continue; }
        if (char === '/' && next === '*') { block = true; index++; continue; }
        if (char === '"' || char === "'") { quote = char; continue; }
        if (char === '{') depth++;
        if (char === '}' && --depth === 0) return { start, end: index + 1, text: text.slice(start, index + 1) };
    }
    throw new Error('Unclosed pinned boundary: ' + marker);
}

export function bodyWithoutImports(text) {
    return text.replace(/^import [^\r\n]+\r?\n/gm, '')
        .replace(/(^package[^\r\n]+)\r?\n(?:[ \t]*\r?\n)+/m, '$1\n');
}

export function transformNavigation(originals, tokenSet) {
    const outputs = [], changes = [];
    for (let index = 0; index < NAVIGATION_PATHS.length; index++) {
        const path = NAVIGATION_PATHS[index]; assert(originals.has(path)); let text = originals.get(path).toString();
        function replace(before, after, kind) {
            assert.equal(text.split(before).length, 2, 'Pinned transformation is not unique: ' + before.slice(0, 80));
            const start = text.indexOf(before);
            changes.push({ path, kind, startUtf16: start, endUtf16: start + before.length,
                originalBytes: Buffer.byteLength(before), originalSha256: sha256(Buffer.from(before)),
                replacementBytes: Buffer.byteLength(after), replacementSha256: sha256(Buffer.from(after)) });
            text = text.replace(before, after);
        }
        function removeDeclaration(marker) { const span = balancedSpan(text, marker); replace(span.text, '', 'unavailable-psi-declaration'); }
        function removeImport(line) { replace('import ' + line + '\n', '', 'psi-only-import'); }
        if (index === 0) {
            replace('            is KtPsiSourceElement -> PsiSourceNavigator\n', '', 'unavailable-psi-dispatch');
            removeDeclaration('private object PsiSourceNavigator : LightTreeSourceNavigator()');
            for (const name of ['com.intellij.psi.PsiElement', 'com.intellij.psi.PsiNameIdentifierOwner',
                'com.intellij.psi.impl.source.tree.LeafPsiElement', 'org.jetbrains.kotlin.psi.*']) removeImport(name);
            replace('source.treeStructure.getChildren(node, ref)', 'source.treeStructure.getChildren(node, ref.asChildrenRef())', 'same-ref-carrier-binding');
            replace('ref.get().firstOrNull()', 'ref.get()!!.firstOrNull()', 'explicit-java-platform-dereference');
            replace('import org.jetbrains.kotlin.util.getChildren\n', 'import org.jetbrains.kotlin.util.getChildren\nimport org.jetbrains.kotlin.portable.source.asChildrenRef\n', 'carrier-import');
        } else if (index === 1) {
            replace('getChild(types.types.toSet(), index, depth, reverse)', 'getChild(types.' + SNAPSHOT_METHOD + '(), index, depth, reverse)', 'selected-token-membership-snapshot');
            removeDeclaration('        is KtPsiSourceElement -> psi.forEachChildOfType(types, depth, reverse)');
            removeDeclaration('inline fun PsiElement.forEachChildOfType(');
            for (const name of ['com.intellij.psi.PsiElement', 'org.jetbrains.kotlin.psi.psiUtil.allChildren']) removeImport(name);
        } else if (index === 2) {
            removeDeclaration('    class FirPsiModifierList(');
            removeDeclaration('    class FirPsiModifier(');
            removeDeclaration('        is KtPsiSourceElement -> {');
            replace('        is KtPsiSourceElement -> (psi as? KtValVarKeywordOwner)?.valOrVarKeyword?.let { it.node?.elementType as? KtKeywordToken }\n', '', 'unavailable-psi-dispatch');
            for (const name of ['com.intellij.lang.ASTNode', 'org.jetbrains.kotlin.psi.KtModifierList',
                'org.jetbrains.kotlin.psi.KtModifierListOwner', 'org.jetbrains.kotlin.psi.KtProperty', 'org.jetbrains.kotlin.psi.KtValVarKeywordOwner',
                'org.jetbrains.kotlin.utils.exceptions.errorWithAttachment', 'org.jetbrains.kotlin.utils.exceptions.withPsiEntry']) removeImport(name);
        } else {
            replace('            is KtPsiSourceElement ->\n                (source.psi as? KtValVarKeywordOwner)?.valOrVarKeyword?.toKtPsiSourceElement()\n', '', 'unavailable-psi-dispatch');
            removeDeclaration('            is FirModifierList.FirPsiModifierList -> {');
            for (const name of ['org.jetbrains.kotlin.psi.KtValVarKeywordOwner', 'org.jetbrains.kotlin.psi.psiUtil.children']) removeImport(name);
        }
        text = text.replace(/^import com\.intellij\.[\w.]+\.(LighterASTNode|Ref|IElementType|TokenSet|FlyweightCapableTreeStructure)$/gm,
            (_, name) => 'import org.jetbrains.kotlin.portable.source.' + name);
        assert(!/\b(?:KtPsiSourceElement|KtRealPsiSourceElement|FirPsiModifier(?:List)?|PsiSourceNavigator|PsiElement|ASTNode)\b/.test(text), 'PSI dependency remains in complete output');
        outputs.push({ path, bytes: Buffer.from(text) });
    }
    const before = '    operator fun contains(element: IElementType?): Boolean = element != null && element in elements\n';
    const after = before + '\n    // Only the selected traversal observes this copied membership set, never the JVM cached getTypes array.\n' +
        '    fun ' + SNAPSHOT_METHOD + '(): Set<IElementType> = elements.toSet()\n';
    const tokenText = tokenSet.toString(); assert.equal(tokenText.split(before).length, 2);
    changes.push({ path: TOKEN_SET_PATH, kind: 'selected-token-membership-snapshot', startUtf16: tokenText.indexOf(before),
        endUtf16: tokenText.indexOf(before) + before.length, originalBytes: Buffer.byteLength(before), originalSha256: sha256(Buffer.from(before)),
        replacementBytes: Buffer.byteLength(after), replacementSha256: sha256(Buffer.from(after)) });
    outputs.push({ path: TOKEN_SET_PATH, bytes: Buffer.from(tokenText.replace(before, after)) });
    return { outputs, changes };
}
