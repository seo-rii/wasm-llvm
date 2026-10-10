/* The light-tree algorithms require identity membership, creation and union of actual declaration objects. */
package org.jetbrains.kotlin.portable.source

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic

class TokenSet private constructor(private val elements: Set<IElementType>) {
    operator fun contains(element: IElementType?): Boolean = element != null && element in elements

    companion object {
        @JvmField val EMPTY = TokenSet(emptySet())
        @JvmStatic fun create(vararg elements: IElementType): TokenSet = TokenSet(elements.toSet())
        @JvmStatic fun orSet(vararg sets: TokenSet): TokenSet = TokenSet(sets.flatMap { it.elements }.toSet())
    }
}

object TokenType {
    val WHITE_SPACE = IElementType("WHITE_SPACE")
    val ERROR_ELEMENT = IElementType("ERROR_ELEMENT")
}

val LighterASTNode.textLength: Int get() = endOffset - startOffset

// IntelliJ's Java contract accepts nullable slots in a caller-owned child array.
// Preserve the Ref and its original sentinel buffer; the official host writes a
// fresh non-null node array before returning populated children.
@Suppress("UNCHECKED_CAST")
fun Ref<Array<LighterASTNode?>>.asChildrenRef(): Ref<Array<LighterASTNode>> = this as Ref<Array<LighterASTNode>>
