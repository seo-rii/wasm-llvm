package org.jetbrains.kotlin.js.sourcecontentprobe
import org.jetbrains.kotlin.KtSourceFile
/** Mutable input fixture implementing the genuine common source contract. */
class MutableInput(override val name: String, override val path: String?, var text: String) : KtSourceFile {
    override val extension: String get() = ""
    var reads: Int = 0
    var failRead: Boolean = false
    override fun getContentsAsText(): String { reads++; check(!failRead) { "source read failed" }; return text }
    override fun equals(other: Any?): Boolean = this === other
    override fun hashCode(): Int = 37
}
