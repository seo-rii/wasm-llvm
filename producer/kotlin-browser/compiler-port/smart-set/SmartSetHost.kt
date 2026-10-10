/* JVM empty-iterator boundary used by the selected official SmartSet.kt.
 * Non-empty SmartSet bodies and the actual backing set iterator remain unchanged. */
package org.jetbrains.kotlin.utils

internal fun <T> emptySmartSetIterator(): MutableIterator<T> = EmptySmartSetIterator

private object EmptySmartSetIterator : MutableIterator<Nothing> {
    override fun hasNext(): Boolean = false
    override fun next(): Nothing = throw NoSuchElementException()
    override fun remove(): Unit = throw IllegalStateException()
}
