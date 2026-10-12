import assert from 'node:assert/strict';
import { balancedSpan } from '../fir-navigation/transform.mjs';
import { lexicalReferenceView } from '../native-js-output-profile/references.mjs';

const BASE = 'compiler/fir/checkers/src/org/jetbrains/kotlin/fir/analysis/checkers/';
export const TARGETS = [BASE + 'type/FirContextualFunctionTypeChecker.kt', BASE + 'expression/FirParenthesizedPackageQualifierChecker.kt'];
export const REGISTRIES = [BASE + 'CommonTypeCheckers.kt', BASE + 'CommonExpressionCheckers.kt'];
export const SYMBOLS = TARGETS.map(p => p.split('/').at(-1).slice(0, -3));
export const HOST = 'compiler/frontend.common/src/org/jetbrains/kotlin/KtSourceElement.kt';
export const PARSER = 'compiler/fir/raw-fir/mp-parsing2fir/src/org/jetbrains/kotlin/fir/builder/MultiplatformParsing2Fir.kt';
export const ENTRY = 'compiler-port-entry/BrowserCompiler.kt';
export const PIPELINE = 'compiler-port-entry/BrowserCompilerPipeline.kt';
export const BOUNDARIES = [...REGISTRIES, HOST, PARSER, ENTRY, PIPELINE,
    'compiler-port-host/PortableLightTree.kt', 'compiler-port-positioning/KtTokenSets.kt',
    'compiler-port-positioning/sourceElementUtils.kt', 'compiler-port-positioning/UnwrappableTokenTypes.kt',
    'compiler-port-positioning/LightTreePositioningStrategies.kt', 'compiler-port-positioning/LightTreeUtils.kt',
    'compiler/fir/checkers/src/org/jetbrains/kotlin/fir/analysis/FirSourceUtils.kt'];

// Conservative reference closure includes aliases, escaped names, interpolation
// and concatenated literal spellings; this is not a name-resolution claim.
export function checkerReferences(text) {
    const decoded = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    const view = lexicalReferenceView(decoded), joined = decoded.replace(/"\s*\+\s*"/g, '');
    return SYMBOLS.filter(name => new RegExp('\\b' + name + '\\b').test(decoded + '\n' + view + '\n' + joined));
}

export function checkerChanges(logical, original) {
    assert(TARGETS.includes(logical)); let text = original.toString(); const changes = [];
    function replace(before, after, reason) {
        assert(before.length && text.split(before).length === 2, 'Unique semantic checker span: ' + logical + ':' + reason);
        changes.push({ before, after, reason }); text = text.replace(before, after);
    }
    function remove(before, reason) {
        replace(before, '/* sealed LightTree checker profile: ' + reason + ' */' + (before.endsWith('\n') ? '\n' : ''), reason);
    }
    function removeImport(name) { remove('import ' + name + '\n', 'unavailable-psi-import-' + changes.length); }
    if (logical === TARGETS[0]) {
        remove(balancedSpan(text, '        fun PsiElement.findContextReceiverListSource(): KtPsiSourceElement? {').text, 'unavailable-local-psi-recursion');
        remove('            is KtPsiSourceElement -> psi.findContextReceiverListSource()\n', 'unavailable-psi-dispatch');
        for (const name of ['com.intellij.psi.PsiElement', 'org.jetbrains.kotlin.psi.KtFunctionType', 'org.jetbrains.kotlin.psi.KtNullableType', 'org.jetbrains.kotlin.psi.KtTypeReference']) removeImport(name);
        for (const [from, name] of [['com.intellij.lang.LighterASTNode', 'LighterASTNode'], ['com.intellij.util.diff.FlyweightCapableTreeStructure', 'FlyweightCapableTreeStructure']])
            replace('import ' + from + '\n', 'import org.jetbrains.kotlin.portable.source.' + name + '\n', 'existing-portable-carrier-' + name);
    } else {
        remove(balancedSpan(text, '                        is KtPsiSourceElement -> {').text, 'unavailable-psi-dispatch');
        for (const name of ['org.jetbrains.kotlin.KtPsiSourceElement', 'org.jetbrains.kotlin.psi.psiUtil.getExplicitReceiverOfDotQualified', 'org.jetbrains.kotlin.toKtPsiSourceElement']) removeImport(name);
        replace('import com.intellij.psi.tree.IElementType\n', 'import org.jetbrains.kotlin.portable.source.IElementType\n', 'existing-portable-carrier-IElementType');
    }
    assert(!/\b(?:KtPsiSourceElement|PsiElement|KtFunctionType|KtNullableType|KtTypeReference)\b/.test(lexicalReferenceView(text)), 'PSI remains in complete semantic checker');
    return changes;
}

export function applyCheckerChanges(bytes, changes, reverse = false) {
    let text = bytes.toString();
    for (const { before, after } of reverse ? changes.slice().reverse() : changes) {
        const from = reverse ? after : before, to = reverse ? before : after;
        assert(from.length && text.split(from).length === 2, 'Exact reversible semantic checker span: ' + from.slice(0, 100));
        text = text.replace(from, to);
    }
    return Buffer.from(text);
}
