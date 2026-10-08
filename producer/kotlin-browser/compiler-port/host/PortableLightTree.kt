/* Common carrier contracts for the official parser's source-element bridge. */
package org.jetbrains.kotlin.portable.source

// The selected new parser deliberately reports one shared source-element type.
// SyntaxElementType remains on the real parser nodes and drives Raw FIR conversion.
open class IElementType(private val debugName: String) {
    override fun toString(): String = debugName
}

interface LighterASTNode {
    val tokenType: IElementType
    val startOffset: Int
    val endOffset: Int

    companion object {
        val EMPTY_ARRAY: Array<LighterASTNode> = emptyArray()
    }
}

class Ref<T>(private var value: T? = null) {
    fun get(): T? = value
    fun set(value: T?) { this.value = value }

    companion object {
        fun <T> create(): Ref<T> = Ref()
        fun <T> create(value: T): Ref<T> = Ref(value)
    }
}

interface FlyweightCapableTreeStructure<T : Any> {
    fun getRoot(): T
    fun getParent(node: T): T?
    fun getChildren(parent: T, into: Ref<Array<T>>): Int
    fun disposeChildren(nodes: Array<out T>?, count: Int)
    fun toString(node: T): CharSequence
    fun getStartOffset(node: T): Int
    fun getEndOffset(node: T): Int
}

val <T : Any> FlyweightCapableTreeStructure<T>.root: T
    get() = getRoot()

// java.util.Objects.hash with the same ordered/null-aware 31-folding algorithm.
fun portableObjectsHash(first: Any?, second: Any?): Int = 31 * (31 + (first?.hashCode() ?: 0)) + (second?.hashCode() ?: 0)
