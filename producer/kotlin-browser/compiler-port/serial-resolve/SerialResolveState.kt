/* The serialized compiler Worker supplies one thread-local state per resolver object. */
package org.jetbrains.kotlin.portable.resolve

class SerialResolveState<T> private constructor(private val initialValue: () -> T) {
    private var initialized = false
    private var value: T? = null

    @Suppress("UNCHECKED_CAST")
    fun get(): T {
        if (!initialized) {
            val initial = initialValue()
            value = initial
            initialized = true
        }
        return value as T
    }

    fun set(value: T) {
        this.value = value
        initialized = true
    }

    fun remove() {
        initialized = false
        value = null
    }

    companion object {
        fun <T> withInitial(initialValue: () -> T): SerialResolveState<T> = SerialResolveState(initialValue)
    }
}
