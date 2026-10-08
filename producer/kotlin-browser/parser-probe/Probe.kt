package org.jetbrains.kotlin.kmp.probe

import com.intellij.platform.syntax.lexer.performLexing
import com.intellij.platform.syntax.parser.SyntaxTreeBuilderFactory
import com.intellij.platform.syntax.parser.prepareProduction
import org.jetbrains.kotlin.kmp.lexer.KotlinLexer
import org.jetbrains.kotlin.kmp.parser.KotlinParser

// This observer serializes the official lexer tokens and parser productions.
// It does not parse, type-check, or emit user Kotlin itself.
private fun StringBuilder.quoted(value: String?) {
    if (value == null) {
        append("null")
        return
    }
    append('"')
    for (character in value) {
        when (character) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            else -> if (character.code < 32) {
                append("\\u")
                append(character.code.toString(16).padStart(4, '0'))
            } else append(character)
        }
    }
    append('"')
}

fun snapshot(source: String): String {
    val lexerTokens = performLexing(source, KotlinLexer(), cancellationProvider = null, logger = null)
    val result = StringBuilder()
    result.append("{\"utf16Length\":").append(source.length).append(",\"tokens\":[")
    // Observe lexer output before the parser can remap soft keyword tokens.
    for (index in 0 until lexerTokens.tokenCount) {
        if (index != 0) result.append(',')
        result.append('[')
        result.quoted(lexerTokens.getTokenType(index)?.toString())
        result.append(',').append(lexerTokens.getTokenStart(index))
        result.append(',').append(lexerTokens.getTokenEnd(index)).append(']')
    }
    result.append("],\"markers\":[")
    val parser = KotlinParser(isScript = false, isLazy = false)
    val builder = SyntaxTreeBuilderFactory.builder(
        source,
        lexerTokens,
        whitespaces = parser.whitespaces,
        comments = parser.comments,
    ).withStartOffset(0)
        .withWhitespaceOrCommentBindingPolicy(parser.whitespaceOrCommentBindingPolicy)
        .build()
    parser.parse(builder)
    val productions = prepareProduction(builder).productionMarkers
    for (index in 0 until productions.size) {
        if (index != 0) result.append(',')
        val marker = productions.getMarker(index)
        result.append('[')
        result.quoted(when {
            productions.isDoneMarker(index) -> "close"
            marker.isErrorMarker() -> "error"
            else -> "open"
        })
        result.append(',')
        result.quoted(marker.getNodeType().toString())
        result.append(',').append(marker.getStartOffset())
        result.append(',').append(marker.getEndOffset())
        result.append(',').append(marker.getStartTokenIndex())
        result.append(',').append(marker.getEndTokenIndex())
        result.append(',')
        result.quoted(marker.getErrorMessage())
        result.append(',').append(marker.isCollapsed()).append(']')
    }
    return result.append("]}").toString()
}
