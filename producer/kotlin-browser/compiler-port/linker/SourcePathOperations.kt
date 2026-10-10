package org.jetbrains.kotlin.portable.source

/** Compiler metadata's source-path carrier, with no host-file capability. */
val LibraryPath.path: String get() = value
val LibraryPath.pathString: String get() = value
