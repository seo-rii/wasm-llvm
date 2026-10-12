import assert from 'node:assert/strict';
import { balancedSpan } from '../fir-navigation/transform.mjs';
import { lexicalReferenceView } from '../native-js-output-profile/references.mjs';

const ROOT = 'compiler/fir/checkers/src/org/jetbrains/kotlin/fir/analysis/checkers/';
export const BASE = ROOT + 'syntax/FirSyntaxChecker.kt';
export const EXCLUDED = ROOT + 'syntax/FirPrefixAndSuffixSyntaxChecker.kt';
export const ROSTER = ROOT + 'CommonExpressionCheckers.kt';
export const HOST = 'compiler/frontend.common/src/org/jetbrains/kotlin/KtSourceElement.kt';
export const ENTRY = 'compiler-port-entry/BrowserCompiler.kt';
export const PIPELINE = 'compiler-port-entry/BrowserCompilerPipeline.kt';
export const PARSER = 'compiler/fir/raw-fir/mp-parsing2fir/src/org/jetbrains/kotlin/fir/builder/MultiplatformParsing2Fir.kt';
export const FAMILY = [BASE, ...[
    'FirAnnotatedBinaryExpressionChecker', 'FirCommaInWhenConditionChecker', 'FirConfusingWhenBranchSyntaxChecker',
    'FirDelegationInExpectClassSyntaxChecker', 'FirDelegationInInterfaceSyntaxChecker', 'FirExplicitApiDeclarationChecker',
    'FirFunctionTypeParametersSyntaxChecker', 'FirLocalVariableTypeParametersSyntaxChecker', 'FirMissingConstructorKeywordSyntaxChecker',
    'FirPrefixAndSuffixSyntaxChecker', 'FirTypeParameterSyntaxChecker', 'FirUnderscoredTypeArgumentSyntaxChecker',
    'FirUnresolvedInMiddleOfImportChecker', 'FirWhenGuardChecker',
].map(name => ROOT + 'syntax/' + name + '.kt'),
ROOT + 'extra/RedundantModalityModifierSyntaxChecker.kt', ROOT + 'extra/RedundantVisibilityModifierSyntaxChecker.kt',
ROOT + 'type/FirFunctionalTypeParameterSyntaxChecker.kt'];
export const REPLACED = [...FAMILY.filter(p => p !== EXCLUDED), ROSTER];
export const FAMILY_NAMES = ['FirSyntaxChecker', 'FirDeclarationSyntaxChecker', 'FirExpressionSyntaxChecker'];
export const SYMBOLS = [...FAMILY_NAMES, ...FAMILY.filter(p => p !== BASE).map(p => p.split('/').at(-1).slice(0, -3))];

export function referenceNames(text, names = SYMBOLS) {
    const view = lexicalReferenceView(text), decoded = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    const joined = decoded.replace(/"\s*\+\s*"/g, '');
    return names.filter(name => new RegExp('\\b' + name + '\\b').test(text + '\n' + view + '\n' + joined));
}

// Every removal has a unique reversible marker. No reachable method body is synthesized.
export function syntaxChanges(logical, original) {
    assert(REPLACED.includes(logical)); let text = original.toString(); const changes = [];
    function replace(before, after, reason) {
        assert(before.length && text.split(before).length === 2, 'Unique syntax span: ' + logical + ':' + before.slice(0, 100));
        changes.push({ before, after, reason }); text = text.replace(before, after);
    }
    function remove(before, reason) { replace(before, '/* browser syntax profile: ' + reason + ' */' + (before.endsWith('\n') ? '\n' : ''), reason); }
    function declaration(marker, reason) { remove(balancedSpan(text, marker).text, reason); }
    if (logical === ROSTER) {
        replace('        FirPrefixAndSuffixSyntaxChecker,\n', '        // PSI-only literal affix checker is inapplicable to the sealed light-tree source host.\n', 'unreachable-psi-registration');
    } else {
        if (logical === BASE) {
            for (const before of ['D : FirElement, P : PsiElement', 'D : FirDeclaration, P : PsiElement', 'E : FirStatement, P : PsiElement'])
                replace(before, before.split(',')[0], 'erase-psi-type-parameter-' + before.split(' : ')[1].split(',')[0]);
            replace('FirSyntaxChecker<D, P>', 'FirSyntaxChecker<D>', 'declaration-base-arity');
            replace('FirSyntaxChecker<E, P>', 'FirSyntaxChecker<E>', 'expression-base-arity');
            remove('            is KtPsiSourceElement -> checkPsi(element, source, source.psi as P)\n', 'unavailable-psi-dispatch');
            declaration('    context(context: CheckerContext, reporter: DiagnosticReporter)\n    fun checkPsi(', 'unavailable-base-psi-method');
        } else {
            const generic = [...text.matchAll(/Fir(?:Declaration|Expression)?SyntaxChecker<([^<>]+), (?:PsiElement|Kt\w+)>/g)];
            assert.equal(generic.length, 1, 'Exact syntax superclass');
            replace(generic[0][0], generic[0][0].replace(/, [^,>]+>/, '>'), 'erase-psi-type-argument');
            if (text.includes('    override fun checkPsi(')) {
                declaration('    context(context: CheckerContext, reporter: DiagnosticReporter)\n    override fun checkPsi(', 'unavailable-psi-override');
            }
            if (logical.endsWith('/FirConfusingWhenBranchSyntaxChecker.kt')) {
                declaration('    context(context: CheckerContext, reporter: DiagnosticReporter)\n    private fun checkCondition(', 'unavailable-psi-condition');
                declaration('    context(context: CheckerContext, reporter: DiagnosticReporter)\n    private fun checkConditionExpression(\n        booleanSubject: Boolean,\n        rawExpression: KtExpression?,', 'unavailable-psi-expression');
            }
            if (logical.endsWith('/FirAnnotatedBinaryExpressionChecker.kt')) {
                replace('get() = (psi as? KtBinaryExpression)?.left is KtAnnotatedExpression\n                || treeStructure', 'get() = treeStructure', 'null-psi-or-light-tree-predicate');
            }
        }
        for (const match of [...text.matchAll(/^import (?:com\.intellij\.psi\.PsiElement|org\.jetbrains\.kotlin\.Kt(?:Real)?PsiSourceElement|org\.jetbrains\.kotlin\.psi(?:\.[^\r\n]+)?|org\.jetbrains\.kotlin\.fir\.psi)\n/gm)])
            remove(match[0], 'psi-import-' + changes.length);
        for (const match of [...text.matchAll(/^import com\.intellij\.[\w.]+\.(LighterASTNode|IElementType|TokenSet|FlyweightCapableTreeStructure)\n/gm)])
            replace(match[0], 'import org.jetbrains.kotlin.portable.source.' + match[1] + '\n', 'existing-portable-tree-type-' + match[1]);
    }
    assert(!/\b(?:KtPsiSourceElement|KtRealPsiSourceElement|PsiElement)\b/.test(lexicalReferenceView(text).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')), 'PSI type remains: ' + logical);
    return changes;
}

export function applyChanges(bytes, changes, reverse = false) {
    let text = bytes.toString();
    for (const { before, after } of reverse ? changes.slice().reverse() : changes) {
        const from = reverse ? after : before, to = reverse ? before : after;
        assert(from.length && text.split(from).length === 2, 'Exact reversible syntax span: ' + from.slice(0, 100)); text = text.replace(from, to);
    }
    return Buffer.from(text);
}

export function expandObjectImports(bytes, owners) {
    let text = bytes.toString();
    for (const [owner, members] of Object.entries(owners)) {
        const before = 'import ' + owner + '.*';
        if (text.includes(before)) { assert.equal(text.split(before).length, 2); text = text.replace(before, members.map(m => 'import ' + owner + '.' + m).join('\n')); }
    }
    return Buffer.from(text);
}
