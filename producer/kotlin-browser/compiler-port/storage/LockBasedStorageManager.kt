/*
 * Copyright 2010-2015 JetBrains s.r.o.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 */
package org.jetbrains.kotlin.storage

import org.jetbrains.kotlin.utils.WrappedValues
import org.jetbrains.kotlin.utils.isProcessCanceledException
import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic

/** Single-Worker host port of the pinned Java storage state machines. */
open class LockBasedStorageManager private constructor(
    private val debugText: String,
    private val exceptionHandlingStrategy: ExceptionHandlingStrategy,
    protected val lock: SimpleLock
) : StorageManager {
    fun interface ExceptionHandlingStrategy {
        fun handleException(throwable: Throwable): RuntimeException
        companion object {
            @JvmField val THROW = ExceptionHandlingStrategy { throw it }
        }
    }

    constructor(debugText: String) : this(debugText, ExceptionHandlingStrategy.THROW, SimpleLock.simpleLock())
    constructor(debugText: String, checkCancelled: (() -> Unit)?, interruptedExceptionHandler: ((Throwable) -> Unit)?) :
        this(debugText, ExceptionHandlingStrategy.THROW, SimpleLock.simpleLock(checkCancelled, interruptedExceptionHandler))

    override fun toString(): String = "LockBasedStorageManager@" + hashCode().toUInt().toString(16) + " (" + debugText + ")"

    fun replaceExceptionHandling(debugText: String, exceptionHandlingStrategy: ExceptionHandlingStrategy): LockBasedStorageManager =
        LockBasedStorageManager(debugText, exceptionHandlingStrategy, lock)

    override fun <K, V : Any> createMemoizedFunction(compute: (K) -> V): MemoizedFunctionToNotNull<K, V> =
        createMemoizedFunction(compute, createMap())

    override fun <K, V : Any> createMemoizedFunction(compute: (K) -> V, onRecursiveCall: (K, Boolean) -> V): MemoizedFunctionToNotNull<K, V> =
        createMemoizedFunction(compute, onRecursiveCall, createMap())

    override fun <K, V : Any> createMemoizedFunction(compute: (K) -> V, map: MutableMap<K, Any>): MemoizedFunctionToNotNull<K, V> =
        MapBasedMemoizedFunctionToNotNull(this, map, compute)

    override fun <K, V : Any> createMemoizedFunction(compute: (K) -> V, onRecursiveCall: (K, Boolean) -> V, map: MutableMap<K, Any>): MemoizedFunctionToNotNull<K, V> =
        object : MapBasedMemoizedFunctionToNotNull<K, V>(this, map, compute) {
            override fun recursionDetected(input: K, firstTime: Boolean): RecursionDetectedResult<V> =
                RecursionDetectedResult.value(onRecursiveCall(input, firstTime))
        }

    override fun <K, V : Any> createMemoizedFunctionWithNullableValues(compute: (K) -> V?): MemoizedFunctionToNullable<K, V> =
        MapBasedMemoizedFunctionToNullable(this, createMap(), compute)

    override fun <K, V : Any> createMemoizedFunctionWithNullableValues(compute: (K) -> V, map: MutableMap<K, Any>): MemoizedFunctionToNullable<K, V> =
        MapBasedMemoizedFunctionToNullable(this, map, compute)

    override fun <T : Any> createLazyValue(computable: () -> T): NotNullLazyValue<T> = LockBasedNotNullLazyValue(this, computable)

    override fun <T : Any> createLazyValue(computable: () -> T, onRecursiveCall: (Boolean) -> T): NotNullLazyValue<T> =
        object : LockBasedNotNullLazyValue<T>(this, computable) {
            override fun recursionDetected(firstTime: Boolean): RecursionDetectedResult<T> = RecursionDetectedResult.value(onRecursiveCall(firstTime))
        }

    override fun <T : Any> createRecursionTolerantLazyValue(computable: () -> T, onRecursiveCall: T): NotNullLazyValue<T> =
        object : LockBasedNotNullLazyValue<T>(this, computable) {
            override fun recursionDetected(firstTime: Boolean): RecursionDetectedResult<T> = RecursionDetectedResult.value(onRecursiveCall)
            override fun presentableName(): String = "RecursionTolerantLazyValue"
        }

    override fun <T : Any> createLazyValueWithPostCompute(computable: () -> T, onRecursiveCall: ((Boolean) -> T)?, postCompute: (T) -> Unit): NotNullLazyValue<T> =
        object : LockBasedNotNullLazyValueWithPostCompute<T>(this, computable) {
            override fun recursionDetected(firstTime: Boolean): RecursionDetectedResult<T> =
                if (onRecursiveCall == null) super.recursionDetected(firstTime) else RecursionDetectedResult.value(onRecursiveCall(firstTime))
            override fun doPostCompute(value: T?) = postCompute(nonNull(value, "compute() returned null"))
            override fun presentableName(): String = "LockBasedNotNullLazyValueWithPostCompute"
        }

    override fun <T : Any> createNullableLazyValue(computable: () -> T?): NullableLazyValue<T> = LockBasedNullableLazyValue(this, computable)

    override fun <T : Any> createRecursionTolerantNullableLazyValue(computable: () -> T?, onRecursiveCall: T?): NullableLazyValue<T> =
        object : LockBasedNullableLazyValue<T>(this, computable) {
            override fun recursionDetected(firstTime: Boolean): RecursionDetectedResult<T> = RecursionDetectedResult.value(onRecursiveCall)
            override fun presentableName(): String = "RecursionTolerantNullableLazyValue"
        }

    override fun <T : Any> createNullableLazyValueWithPostCompute(computable: () -> T?, postCompute: (T?) -> Unit): NullableLazyValue<T> =
        object : LockBasedNullableLazyValueWithPostCompute<T>(this, computable) {
            override fun doPostCompute(value: T?) = postCompute(value)
            override fun presentableName(): String = "NullableLazyValueWithPostCompute"
        }

    override fun <T> compute(computable: () -> T): T {
        lock.lock()
        try { return computable() }
        catch (throwable: Throwable) { throw exceptionHandlingStrategy.handleException(throwable) }
        finally { lock.unlock() }
    }

    protected open fun <K, V> recursionDetectedDefault(source: String, input: K): RecursionDetectedResult<V> {
        throw AssertionError("Recursion detected " + source + (if (input == null) "" else "on input: " + input) + " under " + this)
    }

    class RecursionDetectedResult<T> private constructor(val value: T?, val isFallThrough: Boolean) {
        override fun toString(): String = if (isFallThrough) "FALL_THROUGH" else value.toString()
        companion object {
            fun <T> value(value: T?): RecursionDetectedResult<T> = RecursionDetectedResult(value, false)
            fun <T> fallThrough(): RecursionDetectedResult<T> = RecursionDetectedResult(null, true)
        }
    }

    private enum class NotValue { NOT_COMPUTED, COMPUTING, RECURSION_WAS_DETECTED }

    private open class LockBasedLazyValue<T : Any>(
        protected val storageManager: LockBasedStorageManager,
        private val computable: () -> T?
    ) {
        private var value: Any? = NotValue.NOT_COMPUTED
        open fun isComputed(): Boolean = value != NotValue.NOT_COMPUTED && value != NotValue.COMPUTING
        open fun isComputing(): Boolean = value == NotValue.COMPUTING
        open fun invoke(): T? {
            var observed = value
            if (observed !is NotValue) return WrappedValues.unescapeThrowable(observed)
            storageManager.lock.lock()
            try {
                observed = value
                if (observed !is NotValue) return WrappedValues.unescapeThrowable(observed)
                if (observed == NotValue.COMPUTING) {
                    value = NotValue.RECURSION_WAS_DETECTED
                    val result = recursionDetected(true)
                    if (!result.isFallThrough) return result.value
                }
                if (observed == NotValue.RECURSION_WAS_DETECTED) {
                    val result = recursionDetected(false)
                    if (!result.isFallThrough) return result.value
                }
                value = NotValue.COMPUTING
                try {
                    val typedValue = computable()
                    postCompute(typedValue)
                    value = typedValue
                    return typedValue
                } catch (throwable: Throwable) {
                    if (throwable.isProcessCanceledException()) {
                        value = NotValue.NOT_COMPUTED
                        throw throwable
                    }
                    if (value == NotValue.COMPUTING) value = WrappedValues.escapeThrowable(throwable)
                    throw storageManager.exceptionHandlingStrategy.handleException(throwable)
                }
            } finally { storageManager.lock.unlock() }
        }
        protected open fun recursionDetected(firstTime: Boolean): RecursionDetectedResult<T> = storageManager.recursionDetectedDefault("in a lazy value", null)
        protected open fun postCompute(value: T?) {}
        open fun renderDebugInformation(): String = presentableName() + ", storageManager=" + storageManager
        protected open fun presentableName(): String = "org.jetbrains.kotlin.storage.LockBasedStorageManager\$LockBasedLazyValue"
    }

    private open class LockBasedNullableLazyValue<T : Any>(storageManager: LockBasedStorageManager, computable: () -> T?) :
        LockBasedLazyValue<T>(storageManager, computable), NullableLazyValue<T>

    private abstract class LockBasedLazyValueWithPostCompute<T : Any>(storageManager: LockBasedStorageManager, computable: () -> T?) :
        LockBasedLazyValue<T>(storageManager, computable) {
        private var valuePostCompute: SingleThreadValue<T?>? = null
        override fun invoke(): T? {
            val postComputeCache = valuePostCompute
            if (postComputeCache != null && postComputeCache.hasValue()) return postComputeCache.getValue()
            return super.invoke()
        }
        final override fun postCompute(value: T?) {
            valuePostCompute = SingleThreadValue(value)
            try { doPostCompute(value) } finally { valuePostCompute = null }
        }
        protected abstract fun doPostCompute(value: T?)
    }

    private abstract class LockBasedNotNullLazyValueWithPostCompute<T : Any>(storageManager: LockBasedStorageManager, computable: () -> T) :
        LockBasedLazyValueWithPostCompute<T>(storageManager, computable), NotNullLazyValue<T> {
        override fun invoke(): T = nonNull(super.invoke(), "compute() returned null")
        override fun renderDebugInformation(): String = super<LockBasedLazyValueWithPostCompute>.renderDebugInformation()
    }

    private abstract class LockBasedNullableLazyValueWithPostCompute<T : Any>(storageManager: LockBasedStorageManager, computable: () -> T?) :
        LockBasedLazyValueWithPostCompute<T>(storageManager, computable), NullableLazyValue<T>

    private open class LockBasedNotNullLazyValue<T : Any>(storageManager: LockBasedStorageManager, computable: () -> T) :
        LockBasedLazyValue<T>(storageManager, computable), NotNullLazyValue<T> {
        override fun invoke(): T = nonNull(super.invoke(), "compute() returned null")
        override fun renderDebugInformation(): String = super<LockBasedLazyValue>.renderDebugInformation()
        override fun presentableName(): String = "org.jetbrains.kotlin.storage.LockBasedStorageManager\$LockBasedNotNullLazyValue"
    }

    private open class MapBasedMemoizedFunction<K, V : Any>(
        protected val storageManager: LockBasedStorageManager,
        private val cache: MutableMap<K, Any>,
        private val compute: (K) -> V?
    ) {
        open fun invoke(input: K): V? {
            var value = cache[input]
            if (value != null && value != NotValue.COMPUTING) return WrappedValues.unescapeExceptionOrNull(value)
            storageManager.lock.lock()
            try {
                value = cache[input]
                if (value == NotValue.COMPUTING) {
                    value = NotValue.RECURSION_WAS_DETECTED
                    val result = recursionDetected(input, true)
                    if (!result.isFallThrough) return result.value
                }
                if (value == NotValue.RECURSION_WAS_DETECTED) {
                    val result = recursionDetected(input, false)
                    if (!result.isFallThrough) return result.value
                }
                if (value != null) return WrappedValues.unescapeExceptionOrNull(value)
                var error: AssertionError? = null
                try {
                    cache.put(input, NotValue.COMPUTING)
                    val typedValue = compute(input)
                    val oldValue = cache.put(input, WrappedValues.escapeNull(typedValue))
                    if (oldValue != NotValue.COMPUTING) {
                        error = raceCondition(input, oldValue)
                        throw error
                    }
                    return typedValue
                } catch (throwable: Throwable) {
                    if (throwable.isProcessCanceledException()) {
                        val removed = try { cache.remove(input) } catch (failure: Throwable) { throw unableToRemoveKey(input, failure) }
                        if (removed != NotValue.COMPUTING) throw inconsistentComputingKey(input, removed)
                        throw throwable
                    }
                    if (throwable === error) {
                        try { cache.remove(input) } catch (failure: Throwable) { throw unableToRemoveKey(input, failure) }
                        throw storageManager.exceptionHandlingStrategy.handleException(throwable)
                    }
                    val oldValue = cache.put(input, WrappedValues.escapeThrowable(throwable))
                    if (oldValue != NotValue.COMPUTING) throw raceCondition(input, oldValue)
                    throw storageManager.exceptionHandlingStrategy.handleException(throwable)
                }
            } finally { storageManager.lock.unlock() }
        }
        protected open fun recursionDetected(input: K, firstTime: Boolean): RecursionDetectedResult<V> = storageManager.recursionDetectedDefault("", input)
        private fun raceCondition(input: K, oldValue: Any?): AssertionError =
            AssertionError("Race condition detected on input " + input + ". Old value is " + oldValue + " under " + storageManager)
        private fun inconsistentComputingKey(input: K, oldValue: Any?): AssertionError =
            AssertionError("Inconsistent key detected. COMPUTING is expected, was: " + oldValue + ", most probably race condition detected on input " + input + " under " + storageManager)
        private fun unableToRemoveKey(input: K, throwable: Throwable): AssertionError =
            AssertionError("Unable to remove " + input + " under " + storageManager, throwable)
        open fun isComputed(key: K): Boolean {
            val value = cache[key]
            return value != null && value != NotValue.COMPUTING
        }
    }

    private class MapBasedMemoizedFunctionToNullable<K, V : Any>(storageManager: LockBasedStorageManager, map: MutableMap<K, Any>, compute: (K) -> V?) :
        MapBasedMemoizedFunction<K, V>(storageManager, map, compute), MemoizedFunctionToNullable<K, V>

    private open class MapBasedMemoizedFunctionToNotNull<K, V : Any>(storageManager: LockBasedStorageManager, map: MutableMap<K, Any>, compute: (K) -> V) :
        MapBasedMemoizedFunction<K, V>(storageManager, map, compute), MemoizedFunctionToNotNull<K, V> {
        override fun invoke(input: K): V = nonNull(super.invoke(input), "compute() returned null under " + storageManager)
    }

    override fun <K, V : Any> createCacheWithNullableValues(): CacheWithNullableValues<K, V> = CacheWithNullableValuesAdapter(this)
    override fun <K, V : Any> createCacheWithNotNullValues(): CacheWithNotNullValues<K, V> = CacheWithNotNullValuesBasedOnMemoizedFunction(this)

    private open class CacheWithNullableValuesBasedOnMemoizedFunction<K, V : Any>(storageManager: LockBasedStorageManager) :
        MapBasedMemoizedFunction<KeyWithComputation<K, V>, V>(storageManager, createMap(), { it.computation() }) {
        protected fun computeNullableIfAbsent(key: K, computation: () -> V?): V? = invoke(KeyWithComputation(key, computation))
    }

    private class CacheWithNullableValuesAdapter<K, V : Any>(storageManager: LockBasedStorageManager) :
        CacheWithNullableValuesBasedOnMemoizedFunction<K, V>(storageManager), CacheWithNullableValues<K, V> {
        override fun computeIfAbsent(key: K, computation: () -> V?): V? = computeNullableIfAbsent(key, computation)
    }

    private class CacheWithNotNullValuesBasedOnMemoizedFunction<K, V : Any>(storageManager: LockBasedStorageManager) :
        CacheWithNullableValuesBasedOnMemoizedFunction<K, V>(storageManager), CacheWithNotNullValues<K, V> {
        override fun computeIfAbsent(key: K, computation: () -> V): V = nonNull(computeNullableIfAbsent(key, computation), "computeIfAbsent() returned null under " + storageManager)
    }

    private class KeyWithComputation<K, V>(val key: K, val computation: () -> V?) {
        override fun equals(other: Any?): Boolean = this === other || other is KeyWithComputation<*, *> && key == other.key
        override fun hashCode(): Int = (key ?: throw NullPointerException()).hashCode()
    }

    companion object {
        @JvmField val NO_LOCKS: StorageManager = object : LockBasedStorageManager("NO_LOCKS", ExceptionHandlingStrategy.THROW, EmptySimpleLock) {
            override fun <K, V> recursionDetectedDefault(source: String, input: K): RecursionDetectedResult<V> = RecursionDetectedResult.fallThrough()
        }
        @JvmStatic fun createWithExceptionHandling(debugText: String, strategy: ExceptionHandlingStrategy): LockBasedStorageManager =
            LockBasedStorageManager(debugText, strategy, SimpleLock.simpleLock())
        @JvmStatic fun createWithExceptionHandling(debugText: String, strategy: ExceptionHandlingStrategy, checkCancelled: (() -> Unit)?, interruptedExceptionHandler: ((Throwable) -> Unit)?): LockBasedStorageManager =
            LockBasedStorageManager(debugText, strategy, SimpleLock.simpleLock(checkCancelled, interruptedExceptionHandler))
        private fun <T : Any> nonNull(value: T?, message: String): T = value ?: throw AssertionError(message)
        private fun <K> createMap(): MutableMap<K, Any> = NonNullStorageMap()
    }
}

/** ConcurrentHashMap's null-key rejection and get/put/remove semantics for a serial Worker. */
private class NonNullStorageMap<K>(private val backing: MutableMap<K, Any> = HashMap()) : MutableMap<K, Any> by backing {
    private fun valid(key: K) { if (key == null) throw NullPointerException() }
    override fun get(key: K): Any? { valid(key); return backing[key] }
    override fun put(key: K, value: Any): Any? { valid(key); return backing.put(key, value) }
    override fun remove(key: K): Any? { valid(key); return backing.remove(key) }
}
