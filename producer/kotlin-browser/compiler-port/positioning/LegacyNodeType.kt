/* Keeps the pinned KtNodeType identity/class category; PSI factories belong to the excluded JVM source set. */
package org.jetbrains.kotlin

import org.jetbrains.kotlin.portable.source.IElementType

open class KtNodeType(debugName: String) : IElementType(debugName) {
    open fun isLeftBound(): Boolean = false
    class KtLeftBoundNodeType(debugName: String) : KtNodeType(debugName) {
        override fun isLeftBound(): Boolean = true
    }
}
