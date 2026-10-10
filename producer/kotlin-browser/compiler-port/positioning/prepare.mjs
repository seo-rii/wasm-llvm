/** Pinned official light-tree algorithm separation; no user-source parser or KMP token mapping. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
export const defaultPositioningSourceRoot = path.join(repository, 'out/kotlin-positioning-sources');
const license = '/* Derived from the pinned JetBrains Kotlin source. Apache 2.0; see the source recipe for original paths and blobs. */\n';
const diagnostics = 'compiler/frontend.common-psi/src/org/jetbrains/kotlin/diagnostics/';
const psi = 'compiler/psi/psi-api/src/org/jetbrains/kotlin/';
const common = 'compiler/frontend.common/src/org/jetbrains/kotlin/';

function replaceOnce(source, before, after) {
    assert.equal(source.split(before).length, 2, 'Pinned transformation must match exactly once: ' + before.slice(0, 90));
    return source.replace(before, after);
}

function fields(source, types) {
    const pattern = new RegExp('^\\s*(?:@(?:[\\w.]+)(?:\\([^\\n]*\\))?\\s*)*(' + types.join('|').replaceAll('[]', '\\[\\]') + ')\\s+(\\w+)\\s*=\\s*', 'gm');
    const result = [];
    for (const match of source.matchAll(pattern)) {
        const begin = match.index + match[0].length;
        let quote = ''; let escaped = false; let blockComment = false; let lineComment = false; let depth = 0; let end = -1;
        for (let index = begin; index < source.length; index++) {
            const character = source[index]; const next = source[index + 1];
            if (lineComment) { if (character === '\n') lineComment = false; continue; }
            if (blockComment) { if (character === '*' && next === '/') { blockComment = false; index++; } continue; }
            if (quote) {
                if (escaped) escaped = false;
                else if (character === '\\') escaped = true;
                else if (character === quote) quote = '';
                continue;
            }
            if (character === '/' && next === '/') { lineComment = true; index++; continue; }
            if (character === '/' && next === '*') { blockComment = true; index++; continue; }
            if (character === '"' || character === "'") { quote = character; continue; }
            if ('([{'.includes(character)) depth++;
            else if (')]}'.includes(character)) depth--;
            else if (character === ';' && depth === 0) { end = index; break; }
            assert(depth >= 0, 'Invalid selected declaration nesting');
        }
        assert(end > begin, 'Unterminated selected declaration: ' + match[2]);
        result.push({ type: match[1], name: match[2], expression: source.slice(begin, end).trim() });
    }
    assert(result.length > 0);
    return result;
}

function packageSource(pkg, imports, body) {
    return license + 'package ' + pkg + '\n\n' + imports.map((item) => 'import ' + item + '\n').join('') + '\n' + body + '\n';
}

function explicitImports(owner, names) { return names.map((name) => 'import ' + owner + '.' + name).join('\n'); }

function carrierImports(source) {
    for (const name of ['LighterASTNode', 'Ref', 'IElementType', 'TokenSet', 'FlyweightCapableTreeStructure']) {
        source = source.replace(new RegExp('import com\\.intellij\\.[\\w.]+\\.' + name + '\\b', 'g'), 'import org.jetbrains.kotlin.portable.source.' + name);
    }
    source = source.replace('import com.intellij.psi.TokenType', 'import org.jetbrains.kotlin.portable.source.TokenType');
    return source;
}

export function transformPositioningSources(originals, recipe) {
    const text = (key) => { assert(originals.has(key), 'Missing locked source ' + key); return originals.get(key).toString('utf8'); };
    const generated = new Map();
    const add = (name, source) => { assert(!generated.has(name)); generated.set(name, Buffer.from(source)); };
    const tokenFields = fields(text(psi + 'lexer/KtTokens.java'), ['int', 'KtToken', 'KtKeywordToken', 'KtModifierKeywordToken', 'KtSingleValueToken', 'IElementType', 'TokenSet', 'KtModifierKeywordToken[]']);
    const nodeFields = fields(text(psi + 'KtNodeTypes.java'), ['IElementType', 'IFileElementType']);
    const stubFields = fields(text('compiler/psi/psi-impl/src/org/jetbrains/kotlin/psi/stubs/elements/KtStubElementTypes.java'), ['KtNodeType']);
    const kdocFields = fields(text(psi + 'kdoc/lexer/KDocTokens.java'), ['int', 'KDocToken', 'TokenSet', 'ILazyParseableElementType']);
    const tokenSets = fields(text(psi + 'psi/stubs/elements/KtTokenSets.java'), ['TokenSet']);
    for (const [key, list] of Object.entries({ tokenFields, nodeFields, stubFields, kdocFields, tokenSets })) {
        assert.deepEqual(list.map(({ name }) => name), recipe.declarations[key], 'Declaration membership changed: ' + key);
    }
    const tokenNames = tokenFields.map(({ name }) => name);
    const nodeNames = nodeFields.map(({ name }) => name);
    // Java string literals containing '$' must remain literal in Kotlin.
    const javaExpression = (value) => value.replaceAll(/\bnew\s+/g, '').replaceAll(/"(?:\\.|[^"\\])*"/g, (literal) => literal.replaceAll('$', '\\$'));
    const tokenLines = tokenFields.map(({ type, name, expression }) => {
        let converted = javaExpression(expression);
        if (type === 'KtModifierKeywordToken[]') {
            assert(/^KtModifierKeywordToken\[\]\s*\{[\s\S]*\}$/.test(converted));
            converted = converted.replace(/^KtModifierKeywordToken\[\]\s*\{/, 'arrayOf(').replace(/\}$/, ')');
        }
        if (name === 'MODIFIER_KEYWORDS') converted = replaceOnce(converted, 'TokenSet.create(MODIFIER_KEYWORDS_ARRAY)', 'TokenSet.create(*MODIFIER_KEYWORDS_ARRAY)');
        const kotlinType = type === 'int' ? 'Int' : type === 'KtModifierKeywordToken[]' ? 'Array<KtModifierKeywordToken>' : type;
        return '    ' + (type === 'int' ? 'const val ' : '@JvmField val ') + name + ': ' + kotlinType + ' = ' + converted;
    });
    add('KtTokens.kt', packageSource('org.jetbrains.kotlin.lexer', ['kotlin.jvm.JvmField', 'org.jetbrains.kotlin.portable.source.IElementType', 'org.jetbrains.kotlin.portable.source.TokenSet', 'org.jetbrains.kotlin.portable.source.TokenType', 'org.jetbrains.kotlin.kdoc.lexer.KDocTokens', ...nodeNames.map((name) => 'org.jetbrains.kotlin.KtNodeTypes.' + name)], 'object KtTokens {\n' + tokenLines.join('\n') + '\n}'));
    const stubLines = stubFields.map(({ name, expression }) => {
        const found = expression.match(/^new KtNodeType\("([^"\n]+)",\s*[\w.]+::new\)$/);
        assert(found, 'Unsupported real stub declaration: ' + name);
        return '    @JvmField val ' + name + ': KtNodeType = KtNodeType(' + JSON.stringify(found[1]) + ')';
    });
    const leaf = recipe.declarationOnlyCarriers;
    for (const item of leaf) assert(text(item.originalPath).includes(item.verifiedSourceSnippet), 'Carrier literal must remain in its real source: ' + item.name);
    stubLines.push(...leaf.filter((item) => item.owner === 'KtStubBasedElementTypes').map((item) => '    @JvmField val ' + item.name + ': IElementType = IElementType(' + JSON.stringify(item.debugName) + ')'));
    add('KtStubBasedElementTypes.kt', packageSource('org.jetbrains.kotlin', ['kotlin.jvm.JvmField', 'org.jetbrains.kotlin.portable.source.IElementType'], 'internal object KtStubBasedElementTypes {\n' + stubLines.join('\n') + '\n}'));
    const nodeLines = nodeFields.map(({ name, expression }) => {
        let converted = expression;
        if (expression.startsWith('new ')) {
            const found = expression.match(/^new (KtNodeType(?:\.KtLeftBoundNodeType)?)\("([^"\n]+)",\s*[\w.]+::new\)$/);
            assert(found, 'Unsupported real node declaration: ' + name);
            converted = found[1] + '(' + JSON.stringify(found[2]) + ')';
        } else assert(/^(?:KtStubBasedElementTypes\.)?\w+$/.test(expression));
        return '    @JvmField val ' + name + ': IElementType = ' + converted;
    });
    add('KtNodeTypes.kt', packageSource('org.jetbrains.kotlin', ['kotlin.jvm.JvmField', 'org.jetbrains.kotlin.portable.source.IElementType'], 'object KtNodeTypes {\n' + nodeLines.join('\n') + '\n}'));
    const kdocLines = kdocFields.map(({ type, name, expression }) => {
        let converted = javaExpression(expression);
        if (type === 'ILazyParseableElementType') {
            const item = leaf.find((item) => item.owner === 'KDocTokens' && item.name === name);
            assert(item, 'Unknown KDoc declaration-only carrier');
            converted = 'IElementType(' + JSON.stringify(item.debugName) + ')';
        }
        return '    ' + (type === 'int' ? 'const val ' : '@JvmField val ') + name + ': ' + (type === 'int' ? 'Int' : type === 'ILazyParseableElementType' ? 'IElementType' : type) + ' = ' + converted;
    });
    add('KDocTokens.kt', packageSource('org.jetbrains.kotlin.kdoc.lexer', ['kotlin.jvm.JvmField', 'org.jetbrains.kotlin.portable.source.IElementType', 'org.jetbrains.kotlin.portable.source.TokenSet', 'org.jetbrains.kotlin.lexer.KtToken'], 'class KDocToken(debugName: String, tokenId: Int) : KtToken(debugName, tokenId)\n\nobject KDocTokens {\n' + kdocLines.join('\n') + '\n}'));
    add('KtTokenSets.kt', packageSource('org.jetbrains.kotlin.psi.stubs.elements', ['kotlin.jvm.JvmField', 'org.jetbrains.kotlin.portable.source.TokenSet', 'org.jetbrains.kotlin.lexer.KtTokens', ...nodeNames.map((name) => 'org.jetbrains.kotlin.KtNodeTypes.' + name)], 'object KtTokenSets {\n' + tokenSets.map(({ name, expression }) => '    @JvmField val ' + name + ': TokenSet = ' + expression).join('\n') + '\n}'));

    let light = carrierImports(text(diagnostics + 'LightTreePositioningStrategies.kt'));
    light = replaceOnce(light, 'import org.jetbrains.kotlin.lexer.KtTokens.*', explicitImports('org.jetbrains.kotlin.lexer.KtTokens', tokenNames));
    light = replaceOnce(light, 'import org.jetbrains.kotlin.util.getChildren', 'import org.jetbrains.kotlin.util.getChildren\nimport org.jetbrains.kotlin.portable.source.textLength\nimport org.jetbrains.kotlin.portable.source.asChildrenRef');
    assert.equal(light.split('getChildren(node, childrenRef)').length - 1, 23);
    light = light.replaceAll('getChildren(node, childrenRef)', 'getChildren(node, childrenRef.asChildrenRef())');
    light = replaceOnce(light, 'val childrenRef = Ref<Array<LighterASTNode>>()\n    getChildren(node, childrenRef.asChildrenRef())', 'val childrenRef = Ref<Array<LighterASTNode>>()\n    getChildren(node, childrenRef)');
    light = replaceOnce(light, 'getChildren(node, ref)', 'getChildren(node, ref.asChildrenRef())');
    light = replaceOnce(light, 'ref.get().elementAtOrNull(1)', 'ref.get()!!.elementAtOrNull(1)');
    light = replaceOnce(light, 'ref.get().firstOrNull()', 'ref.get()!!.firstOrNull()');
    light = replaceOnce(light, 'childrenRef.get()) {', 'childrenRef.get()!!) {');
    light = replaceOnce(light, 'childrenRef.get().lastOrNull', 'childrenRef.get()!!.lastOrNull');
    light = replaceOnce(light, 'nodes.reversed()', 'nodes!!.reversed()');
    add('LightTreePositioningStrategies.kt', light);
    let base = carrierImports(text(diagnostics + 'LightTreePositioningStrategy.kt'));
    base = replaceOnce(base, 'import org.jetbrains.kotlin.util.getChildren', 'import org.jetbrains.kotlin.util.getChildren\nimport org.jetbrains.kotlin.portable.source.textLength');
    add('LightTreePositioningStrategy.kt', base);
    add('UnreachableCodeLightTreeHelper.kt', carrierImports(text(diagnostics + 'UnreachableCodeLightTreeHelper.kt')));

    let dispatcher = text(diagnostics + 'SourceElementPositioningStrategy.kt');
    for (const line of ['import com.intellij.psi.PsiElement\n', 'import org.jetbrains.kotlin.KtPsiSourceElement\n']) dispatcher = replaceOnce(dispatcher, line, '');
    dispatcher = replaceOnce(dispatcher, '    private val psiStrategy: PositioningStrategy<*>,\n', '');
    dispatcher = replaceOnce(dispatcher, '            is KtPsiSourceElement -> psiStrategy.markDiagnostic(diagnostic)\n', '');
    dispatcher = replaceOnce(dispatcher, '            is KtPsiSourceElement -> psiStrategy.hackyIsValid(element.psi)\n', '');
    dispatcher = replaceOnce(dispatcher, '\n    private fun PositioningStrategy<*>.hackyIsValid(psi: PsiElement): Boolean {\n        @Suppress("UNCHECKED_CAST")\n        return (this as PositioningStrategy<PsiElement>).isValid(psi)\n    }\n', '\n');
    add('SourceElementPositioningStrategy.kt', dispatcher);
    let registry = text(diagnostics + 'SourceElementPositioningStrategies.kt');
    let registryCount = 0;
    registry = registry.replace(/SourceElementPositioningStrategy\(\s*(LightTreePositioningStrategies\.\w+),\s*(?:Psi)?PositioningStrategies\.\w+,?\s*\)/g, (_, first) => { registryCount++; return 'SourceElementPositioningStrategy(' + first + ')'; });
    assert.equal(registryCount, recipe.sourceStrategyCount);
    assert(!/\b(?:Psi)?PositioningStrategies\./.test(registry));
    add('SourceElementPositioningStrategies.kt', registry);
    const marker = text(diagnostics + 'PositioningStrategy.kt');
    const declaration = '@RequiresOptIn\nannotation class DiagnosticLossRisk';
    assert.equal(marker.split(declaration).length, 2);
    add('DiagnosticLossRisk.kt', packageSource('org.jetbrains.kotlin.diagnostics', [], declaration + '\n\nfun markRange(range: com.intellij.openapi.util.TextRange): List<com.intellij.openapi.util.TextRange> = listOf(range)'));

    const elementTypeUtils = text('compiler/psi/psi-impl/src/org/jetbrains/kotlin/ElementTypeUtils.kt');
    const pureStart = elementTypeUtils.indexOf('    fun LighterASTNode.getOperationSymbol(');
    assert(pureStart >= 0 && elementTypeUtils.endsWith('}\n'));
    add('ElementTypeUtils.kt', packageSource('org.jetbrains.kotlin', ['kotlin.jvm.JvmStatic', 'org.jetbrains.kotlin.portable.source.LighterASTNode', 'org.jetbrains.kotlin.portable.source.FlyweightCapableTreeStructure', 'org.jetbrains.kotlin.lexer.KtToken', 'org.jetbrains.kotlin.util.getSingleChildOrNull', ...nodeNames.map((name) => 'org.jetbrains.kotlin.KtNodeTypes.' + name)], 'object ElementTypeUtils {\n' + elementTypeUtils.slice(pureStart)));
    let sourceUtils = carrierImports(text('compiler/psi/psi-frontend-utils/src/org/jetbrains/kotlin/resolve/source/sourceElementUtils.kt'));
    for (const line of ['import com.intellij.psi.util.elementType\n', 'import org.jetbrains.kotlin.KtPsiSourceElement\n', 'import org.jetbrains.kotlin.psi\n', 'import org.jetbrains.kotlin.psi.psiUtil.getAssignmentLhsIfUnwrappable\n', 'import org.jetbrains.kotlin.psi.psiUtil.getExplicitReceiverOfDotQualified\n']) sourceUtils = replaceOnce(sourceUtils, line, '');
    sourceUtils = replaceOnce(sourceUtils, '    val node = psi?.getAssignmentLhsIfUnwrappable()\n        ?: lighterASTNode.getAssignmentLhsIfUnwrappable(treeStructure)', '    val node = lighterASTNode.getAssignmentLhsIfUnwrappable(treeStructure)');
    sourceUtils = replaceOnce(sourceUtils, '        is KtPsiSourceElement -> psi.getExplicitReceiverOfDotQualified()?.elementType in UNWRAPPABLE_TOKEN_TYPES\n', '');
    add('sourceElementUtils.kt', sourceUtils);
    const unwrap = 'val UNWRAPPABLE_TOKEN_TYPES: Set<IElementType> = setOf(PARENTHESIZED, LABELED_EXPRESSION, ANNOTATED_EXPRESSION)';
    assert.equal(text(psi + 'psi/psiUtil/psiUtils.kt').split(unwrap).length, 2);
    add('UnwrappableTokenTypes.kt', packageSource('org.jetbrains.kotlin.psi.psiUtil', ['org.jetbrains.kotlin.portable.source.IElementType', 'org.jetbrains.kotlin.KtNodeTypes.PARENTHESIZED', 'org.jetbrains.kotlin.KtNodeTypes.LABELED_EXPRESSION', 'org.jetbrains.kotlin.KtNodeTypes.ANNOTATED_EXPRESSION'], unwrap));
    let treeUtils = carrierImports(text(common + 'util/LightTreeUtils.kt'));
    treeUtils = replaceOnce(treeUtils, 'import org.jetbrains.kotlin.portable.source.FlyweightCapableTreeStructure', 'import org.jetbrains.kotlin.portable.source.FlyweightCapableTreeStructure\nimport org.jetbrains.kotlin.portable.source.asChildrenRef');
    assert.equal(treeUtils.split('getChildren(this, children)').length - 1, 2);
    treeUtils = treeUtils.replaceAll('getChildren(this, children)', 'getChildren(this, children.asChildrenRef())');
    treeUtils = replaceOnce(treeUtils, 'children.get().take(count)', 'children.get()!!.take(count)');
    treeUtils = replaceOnce(treeUtils, 'children.get()[0]', 'children.get()!![0]');
    add('LightTreeUtils.kt', treeUtils);
    for (const name of ['AbstractSourceElementPositioningStrategy.kt', 'OffsetsOnlyPositioningStrategy.kt']) add(name, text(common + 'diagnostics/' + name));
    let model = text(common + 'diagnostics/KtDiagnostic.kt');
    for (const line of ['import com.intellij.psi.PsiElement\n', 'import org.jetbrains.kotlin.K1Deprecation\n', 'import org.jetbrains.kotlin.KtPsiSourceElement\n']) model = replaceOnce(model, line, '');
    model = replaceOnce(model, '\n    @K1Deprecation\n    final override val psiElement: PsiElement\n        get() = (element as KtPsiSourceElement).psi\n', '');
    add('KtDiagnostic.kt', model);
    let diagnosticMarker = text(common + 'diagnostics/DiagnosticMarker.kt');
    for (const line of ['import com.intellij.psi.PsiElement\n', 'import org.jetbrains.kotlin.K1Deprecation\n']) diagnosticMarker = replaceOnce(diagnosticMarker, line, '');
    diagnosticMarker = replaceOnce(diagnosticMarker, '\n    /**\n     * When working with [KtDiagnosticWithSource] consider using [KtDiagnosticWithSource.element] instead\n     */\n    @K1Deprecation\n    val psiElement: PsiElement\n        get() = error("psiElement should be called only on diagnostics with KtPsiSourceElement inside")\n', '');
    add('DiagnosticMarker.kt', diagnosticMarker);
    return { generated, membership: { tokenFields: tokenNames, nodeFields: nodeNames, stubFields: stubFields.map(({ name }) => name), kdocFields: kdocFields.map(({ name }) => name), tokenSets: tokenSets.map(({ name }) => name) }, sourceStrategyCount: registryCount };
}

export async function preparePositioningSources({ sourceRoot, outputRoot, positioningSourceRoot = defaultPositioningSourceRoot }) {
    assert(sourceRoot && outputRoot);
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); positioningSourceRoot = path.resolve(positioningSourceRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    for (const inputRoot of [sourceRoot, positioningSourceRoot]) {
        assert(inputRoot !== outputRoot && !inputRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(inputRoot + path.sep), 'Keep verified original source caches read-only');
        await assertNoSymlink(inputRoot);
    }
    await assertNoSymlink(outputRoot);
    const recipeBytes = await readRegular(path.join(here, 'positioning.recipe.json'));
    const recipe = JSON.parse(recipeBytes);
    assert.equal(recipe.schemaVersion, 1); assert.equal(recipe.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    const sourceCacheReceiptPath = path.join(positioningSourceRoot, 'positioning-cache.json');
    const sourceCacheReceiptBytes = await readRegular(sourceCacheReceiptPath);
    const sourceCacheReceipt = JSON.parse(sourceCacheReceiptBytes);
    const extraPins = recipe.originals.filter((pin) => pin.sourceRoot === 'positioning-cache');
    assert.equal(sourceCacheReceipt.kind, 'official-positioning-source-cache');
    assert.deepEqual(sourceCacheReceipt.source, recipe.source);
    assert.deepEqual(sourceCacheReceipt.files, extraPins);
    assert.equal(sourceCacheReceipt.sourceLockSha256, sha256(Buffer.from(JSON.stringify({ source: recipe.source, files: extraPins }))));
    assert.equal(sourceCacheReceipt.status, 'source-identity-verified');
    const originals = new Map();
    const originalLocations = new Map();
    for (const pin of recipe.originals) {
        const file = path.join(pin.sourceRoot === 'compiler-closure' ? sourceRoot : positioningSourceRoot, relativePath(pin.path));
        originals.set(pin.path, verifyFile(await readRegular(file, pin.bytes), pin)); originalLocations.set(pin.path, file);
    }
    const transformed = transformPositioningSources(originals, recipe);
    const portable = [];
    for (const pin of recipe.portable) {
        const bytes = await readRegular(path.join(here, relativePath(pin.path)), pin.bytes);
        assert.equal(bytes.byteLength, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
        transformed.generated.set(pin.path, bytes); portable.push(pin);
    }
    const root = path.join(outputRoot, 'compiler-port-positioning');
    await assertNoSymlink(root); await mkdir(root, { recursive: true });
    const commonSources = [];
    const outputs = [];
    for (const [name, bytes] of transformed.generated) {
        const destination = path.join(root, relativePath(name));
        await assertNoSymlink(destination); await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
        commonSources.push(destination); outputs.push({ path: name, bytes: bytes.byteLength, sha256: sha256(bytes) });
    }
    for (const pin of recipe.originals) verifyFile(await readRegular(originalLocations.get(pin.path), pin.bytes), pin);
    const replacedOriginalPaths = recipe.replacedOriginalPaths;
    const sourceSetExclusions = recipe.sourceSetExclusions;
    const receipt = { schemaVersion: 1, kind: 'official-compiler-light-tree-positioning-source-preparation', source: recipe.source,
        recipeSha256: sha256(recipeBytes), prepareScriptSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
        sourceCache: { receiptSha256: sha256(sourceCacheReceiptBytes), sourceLockSha256: sourceCacheReceipt.sourceLockSha256, files: extraPins },
        originals: recipe.originals, portable, outputs, replacedOriginalPaths, sourceSetExclusions, declarations: transformed.membership,
        sourceStrategyCount: transformed.sourceStrategyCount, originalSourcesUnmodified: true,
        placeholderBridge: 'retained-unchanged', kmpSyntaxToLegacyTokenMapping: 'absent',
        r0DiagnosticPrecision: 'unverified-upstream-placeholder-boundary', differentialStatus: 'not-run',
        browserCompiler: 'not-built', languageReadiness: false };
    const receiptPath = path.join(root, 'positioning-inputs.json');
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { commonSources, replacedOriginalPaths, sourceSetExclusions, receipt, receiptPath };
}
