package org.jetbrains.kotlin.portable.source

/** A canonical POSIX location in the browser's read-only library mount, not a host filesystem path. */
class LibraryPath(val value: String) {
    init {
        require(value.isNotEmpty() && '\u0000' !in value && '\\' !in value) { "Invalid library path" }
        require(value == "/" || (!value.endsWith('/') && !value.contains("//"))) { "Library path must be canonical" }
        val body = if (value.startsWith('/')) value.substring(1) else value
        require(body.isEmpty() || body.split('/').all { it.isNotEmpty() && it != "." && it != ".." }) {
            "Library path contains traversal or a noncanonical segment"
        }
    }

    val isAbsolute: Boolean get() = value.startsWith('/')

    // Construction already requires the canonical form; no source text or path is silently rewritten.
    fun normalize(): LibraryPath = this

    // Relative library locations are relative to the explicit virtual mount root '/'.
    fun toAbsolutePath(): LibraryPath = if (isAbsolute) this else LibraryPath("/$value")

    fun startsWith(other: LibraryPath): Boolean {
        if (isAbsolute != other.isAbsolute) return false
        return value == other.value || (other.value == "/" && isAbsolute) || value.startsWith(other.value + "/")
    }

    override fun equals(other: Any?): Boolean = other is LibraryPath && value == other.value
    override fun hashCode(): Int = value.hashCode()
    override fun toString(): String = value
}
