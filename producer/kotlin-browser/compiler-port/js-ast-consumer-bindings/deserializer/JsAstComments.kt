/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.portable

import org.jetbrains.kotlin.js.backend.ast.JsComment

/** The selected JVM Array<JsComment>.toList factory contract, not a mutable copy. */
fun jsAstCommentList(comments: Array<JsComment>): MutableList<JsComment> = when (comments.size) {
    0 -> EmptyComments
    1 -> FixedComments(comments.copyOf(), false)
    else -> FixedComments(comments.copyOf(), true)
}

private object EmptyComments : AbstractMutableList<JsComment>() {
    override val size: Int get() = 0
    override fun get(index: Int): JsComment = throw IndexOutOfBoundsException()
    override fun set(index: Int, element: JsComment): JsComment = throw UnsupportedOperationException()
    override fun add(index: Int, element: JsComment): Unit = throw UnsupportedOperationException()
    override fun removeAt(index: Int): JsComment = throw UnsupportedOperationException()
    override fun addAll(elements: Collection<JsComment>): Boolean = throw UnsupportedOperationException()
    override fun addAll(index: Int, elements: Collection<JsComment>): Boolean = throw UnsupportedOperationException()
    override fun clear(): Unit = throw UnsupportedOperationException()
    override fun remove(element: JsComment): Boolean = throw UnsupportedOperationException()
    override fun removeAll(elements: Collection<JsComment>): Boolean = throw UnsupportedOperationException()
    override fun retainAll(elements: Collection<JsComment>): Boolean = throw UnsupportedOperationException()
}

private class FixedComments(private val comments: Array<JsComment>, private val replaceAllowed: Boolean) : AbstractMutableList<JsComment>() {
    override val size: Int get() = comments.size
    override fun get(index: Int): JsComment = comments[index]
    override fun set(index: Int, element: JsComment): JsComment {
        if (!replaceAllowed) throw UnsupportedOperationException()
        val previous = comments[index]
        comments[index] = element
        return previous
    }
    override fun add(index: Int, element: JsComment): Unit = throw UnsupportedOperationException()
    override fun removeAt(index: Int): JsComment = throw UnsupportedOperationException()
}
