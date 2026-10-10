package org.jetbrains.kotlin.portable.source

/** Resolve a validated POSIX child in the explicit virtual library mount. */
fun LibraryPath.resolve(child: String): LibraryPath {
    val path = LibraryPath(child)
    return if (path.isAbsolute) path else LibraryPath(if (value == "/") "/$child" else "$value/$child")
}
