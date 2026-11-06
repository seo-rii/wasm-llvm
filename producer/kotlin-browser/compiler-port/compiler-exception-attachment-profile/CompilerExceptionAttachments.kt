package org.jetbrains.kotlin.portable.exceptions

/** The selected compiler attachment contract; external implementations retain an explicit host boundary. */
interface CompilerExceptionAttachment {
    val path: String
    val displayText: String
    val bytes: ByteArray
}

interface CompilerExceptionWithAttachments {
    fun getAttachments(): Array<CompilerExceptionAttachment>
}

// Only this final implementation establishes String-owned, valid UTF8 byte provenance.
internal class CompilerStringExceptionAttachment(
    override val path: String,
    override val displayText: String,
) : CompilerExceptionAttachment {
    override val bytes: ByteArray get() = javaStringAttachmentUtf8(displayText)
    override fun toString(): String = "Attachment[$path][${bytes.size} bytes]"
}

fun newCompilerStringAttachment(path: String, displayText: String): CompilerExceptionAttachment =
    CompilerStringExceptionAttachment(path, displayText)

// Java's observed UTF8 String encoder replaces each unpaired UTF16 surrogate with '?'.
// Paired surrogates and all other original code units remain unchanged.
internal fun javaStringAttachmentUtf8(text: String): ByteArray {
    val normalized = StringBuilder(text.length)
    var index = 0
    while (index < text.length) {
        val char = text[index]
        when {
            char.code in 0xD800..0xDBFF -> {
                val next = text.getOrNull(index + 1)
                if (next != null && next.code in 0xDC00..0xDFFF) {
                    normalized.append(char).append(next)
                    index++
                } else {
                    normalized.append('?')
                }
            }
            char.code in 0xDC00..0xDFFF -> normalized.append('?')
            else -> normalized.append(char)
        }
        index++
    }
    return normalized.toString().encodeToByteArray()
}

fun decodeCompilerAttachmentUtf8(attachment: CompilerExceptionAttachment): String =
    if (attachment is CompilerStringExceptionAttachment) attachment.bytes.decodeToString()
    else requiredCompilerExceptionHost().decodeExternalAttachmentUtf8(attachment.bytes)
