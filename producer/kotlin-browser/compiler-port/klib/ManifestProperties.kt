package org.jetbrains.kotlin.portable.klib

/** String-only Properties contract used by selected KLIB manifest APIs; not a replacement for arbitrary Java object properties. */
class ManifestProperties {
    private val values = linkedMapOf<String, String>()
    private var frozen = false

    val size: Int get() = values.size
    val keys: Set<String> get() = values.keys.toSet()
    fun getProperty(key: String): String? = values[key]
    fun getProperty(key: String, defaultValue: String): String = values[key] ?: defaultValue
    operator fun get(key: String): String? = values[key]
    fun containsKey(key: String): Boolean = values.containsKey(key)
    fun propertyNames(): List<String> = values.keys.toList()
    fun stringPropertyNames(): Set<String> = values.keys.toSet()
    fun asMap(): Map<String, String> = values.toMap()

    fun setProperty(key: String, value: String): String? {
        check(!frozen) { "Verified library manifest is read-only" }
        require(values.size < MAX_PROPERTIES || key in values) { "Too many manifest properties" }
        return values.put(key, value)
    }

    operator fun set(key: String, value: String) { setProperty(key, value) }
    fun putAll(other: ManifestProperties) { other.asMap().forEach { (key, value) -> setProperty(key, value) } }
    operator fun plusAssign(other: ManifestProperties) { putAll(other) }
    fun freeze(): ManifestProperties { frozen = true; return this }

    companion object {
        const val MAX_MANIFEST_BYTES: Int = 1024 * 1024
        const val MAX_PROPERTIES: Int = 16384

        /** Upstream Path.bufferedReader()+Properties.load(Reader) semantics: UTF-8, Java escapes, continuation and last duplicate wins. */
        fun fromUtf8(bytes: ByteArray): ManifestProperties {
            require(bytes.size <= MAX_MANIFEST_BYTES) { "Manifest exceeds the byte limit" }
            return fromText(bytes.decodeToString())
        }

        fun fromText(text: String): ManifestProperties {
            require(text.length <= MAX_MANIFEST_BYTES) { "Manifest exceeds the character limit" }
            val result = ManifestProperties()
            var position = 0
            val logical = StringBuilder()
            var continuation = false
            while (position < text.length) {
                val start = position
                while (position < text.length && text[position] != '\n' && text[position] != '\r') position++
                val end = position
                if (position < text.length) {
                    val separator = text[position++]
                    if (separator == '\r' && position < text.length && text[position] == '\n') position++
                }
                var content = start
                while (content < end && isPropertySpace(text[content])) content++
                if (!continuation && (content == end || text[content] == '#' || text[content] == '!')) continue
                logical.append(text, content, end)
                var backslashes = 0
                var last = end - 1
                while (last >= content && text[last--] == '\\') backslashes++
                continuation = backslashes % 2 != 0
                if (continuation) {
                    logical.setLength(logical.length - 1)
                } else {
                    readLogicalLine(logical.toString(), result)
                    logical.setLength(0)
                }
            }
            if (logical.isNotEmpty() || continuation) readLogicalLine(logical.toString(), result)
            return result
        }

        private fun isPropertySpace(value: Char): Boolean = value == ' ' || value == '\t' || value == '\u000C'

        private fun readLogicalLine(line: String, result: ManifestProperties) {
            var keyEnd = 0
            var escaped = false
            while (keyEnd < line.length) {
                val value = line[keyEnd]
                if (!escaped && (value == '=' || value == ':' || isPropertySpace(value))) break
                escaped = if (value == '\\') !escaped else false
                keyEnd++
            }
            var valueStart = keyEnd
            while (valueStart < line.length && isPropertySpace(line[valueStart])) valueStart++
            if (valueStart < line.length && (line[valueStart] == '=' || line[valueStart] == ':')) valueStart++
            while (valueStart < line.length && isPropertySpace(line[valueStart])) valueStart++
            result.setProperty(unescape(line.substring(0, keyEnd)), unescape(line.substring(valueStart)))
        }

        private fun unescape(value: String): String {
            val decoded = StringBuilder()
            var index = 0
            while (index < value.length) {
                var character = value[index++]
                if (character == '\\') {
                    if (index == value.length) break
                    character = value[index++]
                    when (character) {
                        'u' -> {
                            require(index <= value.length - 4) { "Malformed Unicode escape in manifest" }
                            var codePoint = 0
                            repeat(4) {
                                val digit = value[index++].digitToIntOrNull(16)
                                    ?: throw IllegalArgumentException("Malformed Unicode escape in manifest")
                                codePoint = (codePoint shl 4) or digit
                            }
                            character = codePoint.toChar()
                        }
                        't' -> character = '\t'
                        'r' -> character = '\r'
                        'n' -> character = '\n'
                        'f' -> character = '\u000C'
                    }
                }
                decoded.append(character)
            }
            return decoded.toString()
        }
    }
}
