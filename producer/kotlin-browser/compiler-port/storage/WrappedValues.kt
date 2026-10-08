/* Copyright 2010-2015 JetBrains s.r.o. Licensed under the Apache License, Version 2.0. */
package org.jetbrains.kotlin.utils

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic

object WrappedValues {
    private object NullValue { override fun toString(): String = "NULL_VALUE" }
    @JvmField var throwWrappedProcessCanceledException: Boolean = false
    private class ThrowableWrapper(val throwable: Throwable) { override fun toString(): String = throwable.toString() }
    @JvmStatic @Suppress("UNCHECKED_CAST") fun <V> unescapeNull(value: Any): V? = if (value === NullValue) null else value as V?
    @JvmStatic fun <V> escapeNull(value: V?): Any = value ?: NullValue
    @JvmStatic fun escapeThrowable(throwable: Throwable): Any = ThrowableWrapper(throwable)
    @JvmStatic fun <V> unescapeExceptionOrNull(value: Any): V? = unescapeNull<V>(unescapeThrowable<Any>(value)!!)
    @JvmStatic @Suppress("UNCHECKED_CAST") fun <V> unescapeThrowable(value: Any?): V? {
        if (value is ThrowableWrapper) {
            val throwable = value.throwable
            if (throwWrappedProcessCanceledException && throwable.isProcessCanceledException()) throw WrappedProcessCanceledException(throwable)
            throw rethrow(throwable)
        }
        return value as V?
    }
    class WrappedProcessCanceledException(cause: Throwable) : RuntimeException("Rethrow stored exception", cause)
}
