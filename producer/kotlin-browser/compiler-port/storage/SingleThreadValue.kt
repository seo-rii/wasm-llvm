/* Copyright 2010-2019 JetBrains s.r.o. and Kotlin Programming Language contributors.
 * Licensed under the Apache License, Version 2.0. */
package org.jetbrains.kotlin.storage

/** One module instance belongs to one Worker; references are never transferred. */
private object StorageWorkerOwner

internal class SingleThreadValue<T>(private val value: T) {
    private val owner = StorageWorkerOwner
    fun hasValue(): Boolean = owner === StorageWorkerOwner
    fun getValue(): T {
        if (!hasValue()) throw IllegalStateException("No value in this thread (hasValue should be checked before)")
        return value
    }
}
