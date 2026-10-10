/* Copyright 2010-2015 JetBrains s.r.o. Licensed under the Apache License, Version 2.0. */
package org.jetbrains.kotlin.utils

import com.intellij.openapi.progress.ProcessCanceledException

fun rethrow(e: Throwable): RuntimeException = throw e

fun interface PortableCloseable { fun close() }

fun closeQuietly(closeable: PortableCloseable?) {
    if (closeable != null) {
        try { closeable.close() } catch (ignored: Throwable) {}
    }
}

/** Explicit typed class hierarchy, replacing JVM Class.superclass traversal. */
fun Throwable.isProcessCanceledException(): Boolean = this is ProcessCanceledException
