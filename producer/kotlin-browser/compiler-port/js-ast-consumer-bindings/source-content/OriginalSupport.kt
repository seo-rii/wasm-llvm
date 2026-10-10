package org.jetbrains.kotlin.js.sourcecontentprobe
import org.jetbrains.kotlin.KtSourceFile
import java.io.InputStream
import java.io.ByteArrayInputStream
/** Mutable input fixture implementing the genuine original stream contract. */
class MutableInput(override val name: String, override val path: String?, var text: String) : KtSourceFile {
    override val extension: String get() = ""
    var reads: Int = 0
    var failRead: Boolean = false
    override fun getContentsAsStream(): InputStream { reads++; check(!failRead) { "source read failed" }; return ByteArrayInputStream(text.toByteArray()) }
    override fun equals(other: Any?): Boolean = this === other
    override fun hashCode(): Int = 37
}
