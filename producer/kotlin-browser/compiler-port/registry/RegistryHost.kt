/*
 * Copyright 2010-2021 JetBrains s.r.o. and Kotlin Programming Language contributors.
 * Use of this source code is governed by the Apache 2.0 license that can be found in the license/LICENSE.txt file.
 */
package org.jetbrains.kotlin.portable.registry

/** Host storage for the compiler's string-keyed, single-Worker TypeRegistry. */
class RegistryMap<K : Any, V : Any> private constructor(
    private val delegate: MutableMap<K, V>
) : MutableMap<K, V> by delegate {
    constructor() : this(HashMap())

    private val computing = HashSet<K>()
    private var lockDepth = 0

    fun computeIfAbsent(key: K, compute: (K) -> V): V {
        delegate[key]?.let { return it }
        if (!computing.add(key)) throw IllegalStateException("Recursive update")
        try {
            val value = compute(key)
            if (delegate.containsKey(key)) throw IllegalStateException("Recursive update")
            delegate[key] = value
            return value
        } finally {
            check(computing.remove(key))
        }
    }

    fun putIfAbsent(key: K, value: V): V? {
        delegate[key]?.let { return it }
        if (key in computing) throw IllegalStateException("Recursive update")
        delegate[key] = value
        return null
    }

    override fun put(key: K, value: V): V? {
        if (key in computing) throw IllegalStateException("Recursive update")
        return delegate.put(key, value)
    }

    /** Balanced reentrant ownership; this host supplies no cross-thread scheduling. */
    fun <T> withLock(block: () -> T): T {
        check(lockDepth < Int.MAX_VALUE) { "Registry lock depth overflow" }
        lockDepth++
        try {
            return block()
        } finally {
            check(lockDepth > 0)
            lockDepth--
        }
    }
}

class RegistryCounter(initial: Int = 0) {
    private var next = initial

    fun getAndIncrement(): Int {
        val result = next
        next++
        return result
    }
}

fun <K : Any, V : Any, T> withRegistryLock(owner: RegistryMap<K, V>, block: () -> T): T = owner.withLock(block)
