/* Executes complete pinned JVM functions on genuine source/FIR objects, then checks the explicit payload boundary. */
package org.jetbrains.kotlin.portable.firnavigation.probe

import org.jetbrains.kotlin.KtLightSourceElement
import org.jetbrains.kotlin.KtSourceElement
import org.jetbrains.kotlin.KtFakeSourceElementKind
import org.jetbrains.kotlin.KtNodeTypes
import org.jetbrains.kotlin.lexer.KtTokens
import org.jetbrains.kotlin.com.intellij.psi.tree.IElementType
import org.jetbrains.kotlin.com.intellij.psi.tree.TokenSet
import org.jetbrains.kotlin.fir.analysis.getChild as originalGetChild
import org.jetbrains.kotlin.fir.analysis.forEachChildOfType as originalForEachChildOfType
import org.jetbrains.kotlin.fir.analysis.getSourceForImportSegment as originalImportSegment
import org.jetbrains.kotlin.fir.analysis.getLastImportedFqNameSegmentSource as originalLastImportSegment
import org.jetbrains.kotlin.fir.analysis.checkers.getModifierList as originalModifierList
import org.jetbrains.kotlin.fir.analysis.checkers.SourceNavigator as OriginalNavigator
import org.jetbrains.kotlin.fir.declarations.builder.buildImport

private fun originalId(source: KtSourceElement?): String = source?.let {
    "${(it.lighterASTNode as NodeFixture).id}:${it.startOffset}:${it.endOffset}"
} ?: "null"
private fun payloadId(source: SourcePayload?): String = source?.let {
    "${(it.lighterASTNode as NodeFixture).id}:${it.startOffset}:${it.endOffset}"
} ?: "null"

private inline fun result(block: () -> Any?): String = try { block().toString() } catch (failure: Throwable) {
    when (failure) {
        is NullPointerException -> "failure:NullPointerException"
        is NoSuchElementException -> "failure:NoSuchElementException"
        is IllegalArgumentException -> "failure:IllegalArgumentException"
        else -> "failure:${failure::class.simpleName}"
    }
}

fun main() {
    val raw = StringBuilder()
    fun same(id: String, original: Any?, projected: Any?) {
        check(original == projected) { "$id: original=$original projected=$projected" }
        raw.append(id).append('\t').append(original).append('\n')
    }
    val root = NodeFixture("root", KtNodeTypes.TYPE_REFERENCE, 0, 100,
        NodeFixture("a", KtTokens.IDENTIFIER, 10, 20,
            NodeFixture("aa", KtTokens.IDENTIFIER, 11, 12),
            NodeFixture("ab", KtNodeTypes.TYPE_REFERENCE, 13, 19,
                NodeFixture("aba", KtTokens.IDENTIFIER, 14, 15))),
        NodeFixture("b", KtNodeTypes.TYPE_REFERENCE, 30, 40,
            NodeFixture("ba", KtTokens.IDENTIFIER, 31, 32)),
        NodeFixture("c", KtTokens.IDENTIFIER, 50, 60))
    val tree = TreeFixture(root)
    val genuine = KtLightSourceElement(root, 500, 600, tree)
    val payload = SourcePayload(root, tree, 500, 600)
    val typesList: List<Set<IElementType>> = listOf(emptySet(), setOf(KtTokens.IDENTIFIER), setOf(KtNodeTypes.TYPE_REFERENCE), setOf(KtTokens.IDENTIFIER, KtNodeTypes.TYPE_REFERENCE))
    for ([typeIndex, types] in typesList.withIndex()) for (depth in listOf(-2, -1, 0, 1, 2, 3, 99)) for (reverse in listOf(false, true)) {
        val id = "$typeIndex/$depth/$reverse"
        val actual = mutableListOf<String>()
        val projected = mutableListOf<String>()
        genuine.originalForEachChildOfType(types, depth, reverse) { actual += originalId(it) }
        payload.forEachChildOfType(types, depth, reverse) { projected += payloadId(it) }
        same("walk/$id", actual.joinToString(","), projected.joinToString(","))
        for (index in listOf(-1, 0, 1, 2, 3, 4, 9)) same("child/$id/$index",
            originalId(genuine.originalGetChild(types, index, depth, reverse)), payloadId(payload.getChild(types, index, depth, reverse)))
        val tokens = TokenSet.create(*types.toTypedArray())
        for (index in listOf(-1, 0, 1, 4)) same("token/$id/$index",
            originalId(genuine.originalGetChild(tokens, index, depth, reverse)), payloadId(payload.getChild(tokens, index, depth, reverse)))
    }
    val importRoot = NodeFixture("import", KtNodeTypes.IMPORT_DIRECTIVE, 0, 30,
        NodeFixture("a.b.c", KtNodeTypes.DOT_QUALIFIED_EXPRESSION, 7, 12,
            NodeFixture("a.b", KtNodeTypes.DOT_QUALIFIED_EXPRESSION, 7, 10,
                NodeFixture("a-ref", KtNodeTypes.REFERENCE_EXPRESSION, 7, 8), NodeFixture("b-ref", KtNodeTypes.REFERENCE_EXPRESSION, 9, 10)),
            NodeFixture("c-ref", KtNodeTypes.REFERENCE_EXPRESSION, 11, 12)))
    val importTree = TreeFixture(importRoot)
    val realImport = buildImport { source = KtLightSourceElement(importRoot, 0, 30, importTree); isAllUnder = false }
    val importPayload = ImportPayload(SourcePayload(importRoot, importTree))
    for (index in listOf(-2, -1, 0, 1, 2, 3, 9, Int.MAX_VALUE)) same("import/$index",
        result { originalId(realImport.originalImportSegment(index)) }, result { payloadId(importPayload.getSourceForImportSegment(index)) })
    same("import/last", originalId(realImport.originalLastImportSegment()), payloadId(importPayload.getLastImportedFqNameSegmentSource()))
    val modifierRoot = NodeFixture("function", KtNodeTypes.FUN, 100, 180,
        NodeFixture("modifiers", KtNodeTypes.MODIFIER_LIST, 102, 125,
            NodeFixture("private", KtTokens.PRIVATE_KEYWORD, 102, 109), NodeFixture("annotation", KtNodeTypes.ANNOTATION_ENTRY, 110, 115),
            NodeFixture("suspend", KtTokens.SUSPEND_KEYWORD, 116, 123), NodeFixture("private-again", KtTokens.PRIVATE_KEYWORD, 123, 125)),
        NodeFixture("name", KtTokens.IDENTIFIER, 130, 135))
    val modifierTree = TreeFixture(modifierRoot)
    val realModifierSource = KtLightSourceElement(modifierRoot, 500, 580, modifierTree)
    val modifierPayload = SourcePayload(modifierRoot, modifierTree, 500, 580)
    same("modifiers/all", realModifierSource.originalModifierList()!!.modifiers.joinToString(",") { originalId(it.source) },
        modifierPayload.getModifierList()!!.modifiers.joinToString(",") { payloadId(it.source) })
    same("modifiers/first", originalId(realModifierSource.originalModifierList()!![KtTokens.PRIVATE_KEYWORD]?.source),
        payloadId(modifierPayload.getModifierList()!![KtTokens.PRIVATE_KEYWORD]?.source))
    val realFake = KtLightSourceElement(modifierRoot, 100, 180, modifierTree, KtFakeSourceElementKind.DelegatedPropertyAccessor.Getter)
    val fakeElement = buildImport { source = realFake; isAllUnder = false }
    same("modifiers/fake-element", fakeElement.originalModifierList() == null,
        ElementPayload(SourcePayload(modifierRoot, modifierTree, kind = SourceKindPayload.DelegatedPropertyAccessor)).getModifierList() == null)
    for ([id, type] in listOf("identifier" to KtTokens.IDENTIFIER, "reference" to KtNodeTypes.REFERENCE_EXPRESSION, "other" to KtNodeTypes.BLOCK)) {
        val node = NodeFixture(id, type, 0, 1); val fixture = TreeFixture(node)
        val actualSource = KtLightSourceElement(node, 0, 1, fixture)
        val projected = SourcePayload(node, fixture)
        val actual = with(OriginalNavigator.forSource(actualSource)) { actualSource.getRawIdentifier()?.toString() }
        val expected = with(SourceNavigator.forSource(projected)) { projected.getRawIdentifier()?.toString() }
        same("navigator/raw/$id", actual, expected)
    }
    print(raw)
}
