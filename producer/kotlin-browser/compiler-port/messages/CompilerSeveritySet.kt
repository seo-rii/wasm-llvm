/* Apache 2.0. Browser host adapter for the pinned compiler message severity set. */
package org.jetbrains.kotlin.cli.common.messages

/** Enum declaration order and the weakly consistent iterator match EnumSet. */
internal class CompilerSeveritySet(vararg values: CompilerMessageSeverity) : AbstractMutableSet<CompilerMessageSeverity>() {
    private var elements: Int = 0

    init {
        require(CompilerMessageSeverity.entries.size < Int.SIZE_BITS)
        for (value in values) add(value)
    }

    override val size: Int get() = elements.countOneBits()
    override fun contains(element: CompilerMessageSeverity): Boolean = elements and (1 shl element.ordinal) != 0

    override fun add(element: CompilerMessageSeverity): Boolean {
        val before = elements
        elements = elements or (1 shl element.ordinal)
        return elements != before
    }

    override fun remove(element: CompilerMessageSeverity): Boolean {
        val before = elements
        elements = elements and (1 shl element.ordinal).inv()
        return elements != before
    }

    override fun clear() { elements = 0 }

    override fun iterator(): MutableIterator<CompilerMessageSeverity> = object : MutableIterator<CompilerMessageSeverity> {
        private var unseen = elements
        private var lastReturned = 0

        override fun hasNext(): Boolean = unseen != 0

        override fun next(): CompilerMessageSeverity {
            if (unseen == 0) throw NoSuchElementException()
            val ordinal = unseen.countTrailingZeroBits()
            lastReturned = 1 shl ordinal
            unseen = unseen and lastReturned.inv()
            return CompilerMessageSeverity.entries[ordinal]
        }

        override fun remove() {
            if (lastReturned == 0) throw IllegalStateException()
            elements = elements and lastReturned.inv()
            lastReturned = 0
        }
    }
}
