@file:OptIn(org.jetbrains.kotlin.fir.PrivateSessionConstructor::class, org.jetbrains.kotlin.fir.SessionConfiguration::class)
package org.jetbrains.kotlin.portable.rawfir.probe

import java.lang.reflect.Proxy
import org.jetbrains.kotlin.*
import org.jetbrains.kotlin.config.LanguageVersionSettingsImpl
import org.jetbrains.kotlin.fir.*
import org.jetbrains.kotlin.fir.builder.AbstractRawFirBuilder
import org.jetbrains.kotlin.fir.declarations.*
import org.jetbrains.kotlin.fir.declarations.builder.*
import org.jetbrains.kotlin.fir.expressions.*
import org.jetbrains.kotlin.fir.expressions.builder.FirBlockBuilder
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.platform.CommonPlatforms
import org.jetbrains.kotlin.types.ConstantValueKind
import org.jetbrains.kotlin.utils.exceptions.ExceptionAttachmentBuilder
import org.jetbrains.kotlin.com.intellij.lang.LighterASTNode
import org.jetbrains.kotlin.com.intellij.util.diff.FlyweightCapableTreeStructure
import org.jetbrains.kotlin.lexer.KtTokens

private enum class Kind { INT, FLOAT, BOOLEAN, CHAR, NULL }
private data class LiteralNode(val text: String, val kind: Kind)

private fun source(node: LiteralNode, fake: KtFakeSourceElementKind?): KtSourceElement {
    val ast = Proxy.newProxyInstance(LighterASTNode::class.java.classLoader, arrayOf(LighterASTNode::class.java)) { proxy, method, args ->
        when (method.name) {
            "getTokenType" -> KtTokens.INTEGER_LITERAL
            "getStartOffset" -> 0
            "getEndOffset" -> node.text.length
            "toString" -> "literal-node"
            "hashCode" -> System.identityHashCode(proxy)
            "equals" -> proxy === args?.get(0)
            else -> error("unused source AST callback: " + method.name)
        }
    } as LighterASTNode
    @Suppress("UNCHECKED_CAST")
    val tree = Proxy.newProxyInstance(FlyweightCapableTreeStructure::class.java.classLoader, arrayOf(FlyweightCapableTreeStructure::class.java)) { _, method, _ ->
        when (method.name) {
            "getRoot" -> ast
            "getParent" -> null
            "getStartOffset" -> 0
            "getEndOffset" -> node.text.length
            "toString" -> "literal-tree"
            else -> error("unused source tree callback: " + method.name)
        }
    } as FlyweightCapableTreeStructure<LighterASTNode>
    return KtLightSourceElement(ast, 0, node.text.length, tree, fake ?: KtRealSourceElementKind)
}

private class Builder(session: FirSession) : AbstractRawFirBuilder<LiteralNode, Kind>(session) {
    override fun LiteralNode.toFirSourceElement(kind: KtFakeSourceElementKind?): KtSourceElement = source(this, kind)
    override val LiteralNode.elementType: Kind get() = kind
    override val LiteralNode.asText: String get() = text
    override fun Kind.toConstantValueKind(): ConstantValueKind = when (this) {
        Kind.INT -> ConstantValueKind.Int
        Kind.FLOAT -> ConstantValueKind.Float
        Kind.BOOLEAN -> ConstantValueKind.Boolean
        Kind.CHAR -> ConstantValueKind.Char
        Kind.NULL -> ConstantValueKind.Null
    }
    fun literal(node: LiteralNode): FirExpression = generateConstantExpressionByLiteral(node)
    fun label(text: String): String = buildLabel(text, source(LiteralNode(text, Kind.INT), null)).name
    fun attachment(node: LiteralNode?): String = ExceptionAttachmentBuilder().apply { withSourceElementEntry("node", node) }.buildString()
    override fun LiteralNode.isStringInterpolationPrefixOrQuote(): Boolean = error("unused")
    override fun LiteralNode.isLiteralStringTemplateEntry(): Boolean = error("unused")
    override fun LiteralNode.isEscapeStringTemplateEntry(): Boolean = error("unused")
    override fun LiteralNode.isShortOrLongStringTemplateEntry(): Boolean = error("unused")
    override fun LiteralNode.getLabelName(): String? = error("unused")
    override val LiteralNode.receiverExpression: LiteralNode? get() = error("unused")
    override val LiteralNode.selectorExpression: LiteralNode? get() = error("unused")
    override val LiteralNode.indexExpressions: List<LiteralNode>? get() = error("unused")
    override val LiteralNode.arrayExpression: LiteralNode? get() = error("unused")
    override val LiteralNode.isVararg: Boolean get() = error("unused")
    override fun LiteralNode.getExpressionInParentheses(): LiteralNode? = error("unused")
    override fun LiteralNode.getAnnotatedExpression(): LiteralNode? = error("unused")
    override fun LiteralNode.getLabeledExpression(): LiteralNode? = error("unused")
    override fun LiteralNode.unwrap(): LiteralNode? = error("unused")
    override fun LiteralNode.isArrayAccessExpression(): Boolean = error("unused")
    override fun LiteralNode.isSafeAccessExpression(): Boolean = error("unused")
    override fun convertScript(script: LiteralNode, scriptSource: KtSourceElement, fileName: String, setup: FirScriptBuilder.() -> Unit): FirScript = error("unused")
    override fun convertReplSnippet(script: LiteralNode, scriptSource: KtSourceElement, fileName: String, snippetSetup: FirReplSnippetBuilder.() -> Unit,
        functionBodySetup: FirBlockBuilder.() -> Unit, statementsSetup: MutableList<FirElement>.() -> Unit): FirReplSnippet = error("unused")
}

fun main() {
    val session = object : FirSession(FirSession.Kind.Source) {}
    val module = FirSourceModuleData(Name.special("<literal-probe>"), emptyList(), emptyList(), emptyList(), CommonPlatforms.defaultCommonPlatform)
    module.bindSession(session)
    session.register(FirModuleData::class, module)
    session.register(FirLanguageSettingsComponent::class, FirLanguageSettingsComponent(LanguageVersionSettingsImpl.DEFAULT, false))
    val builder = Builder(session)
    val result = StringBuilder(); var index = 0
    fun record(name: String, value: Any?) { result.append(index++).append('|').append(name).append('|').append(value).append('\n') }
    fun number(value: Any?): String = when (value) {
        is Float -> "F:" + value.toRawBits()
        is Double -> "D:" + value.toRawBits()
        is Long -> "L:" + value
        is Char -> "C:" + value.code
        else -> value.toString()
    }
    val cases = mutableListOf<LiteralNode>()
    for (text in listOf("0", "1", "01", "00", "0_1", "9223372036854775807", "9223372036854775808", "18446744073709551615", "18446744073709551616",
        "0x7fffffffffffffff", "0xffffffffffffffff", "0b1111", "0x", "0b", "1_", "_1", "0x_1", "1__2")) {
        for (suffix in listOf("", "L", "l", "u", "U", "ul", "uL", "Ul", "UL")) cases.add(LiteralNode(text + suffix, Kind.INT))
    }
    for (text in listOf("0.0", "-0.0", "1e309", "1e-4000", "1_0.5", "1._0", "1e_2", "1E2", "1e+", "1.0_", "1.1754943508222875e-38", "1.000000059604644775390626")) {
        for (suffix in listOf("", "f", "F")) cases.add(LiteralNode(text + suffix, Kind.FLOAT))
    }
    for (text in listOf("true", "false", "True", "")) cases.add(LiteralNode(text, Kind.BOOLEAN))
    for (text in listOf("'a'", "'\\n'", "'\\u0041'", "''", "'ab'", "'\\q'", "'")) cases.add(LiteralNode(text, Kind.CHAR))
    cases.add(LiteralNode("null", Kind.NULL))
    for (node in cases) {
        record("input", node.kind.toString() + ":" + node.text)
        try {
            when (val expression = builder.literal(node)) {
                is FirLiteralExpression -> { record("literal-kind", expression.kind); record("literal-value", number(expression.value)); record("source-offsets", "${expression.source?.startOffset}:${expression.source?.endOffset}") }
                is FirErrorExpression -> { record("diagnostic-kind", (expression.diagnostic as? org.jetbrains.kotlin.fir.diagnostics.ConeSimpleDiagnostic)?.kind); record("diagnostic-reason", expression.diagnostic.reason) }
                else -> error("unexpected genuine FIR expression class")
            }
        } catch (error: IllegalStateException) { record("exception", error.message) }
    }
    for (text in listOf("plain", "", "`label`", "``,", "`", "`한글`")) record("label", builder.label(text))
    record("attachment-text", builder.attachment(LiteralNode("hello", Kind.INT)).replace('\n', '~'))
    record("attachment-null", builder.attachment(null).replace('\n', '~'))
    record("script-name", AbstractRawFirBuilder.firScriptName("x.kts"))
    record("snippet-name", AbstractRawFirBuilder.firSnippetName("x.kts"))
    print(result)
}
