/* Copyright 2010-2021 JetBrains s.r.o. Apache-2.0; source bodies bound in recipe. */
package org.jetbrains.kotlin.portable.assertions

/** The compiler host profile keeps internal invariant checks enabled. */
inline fun compilerAssert(value: Boolean) {
    compilerAssert(value) { "Assertion failed" }
}

inline fun compilerAssert(value: Boolean, lazyMessage: () -> Any) {
    if (!value) {
        val message = lazyMessage()
        throw AssertionError(message)
    }
}
