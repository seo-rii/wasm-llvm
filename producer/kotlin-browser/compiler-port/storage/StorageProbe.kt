package org.jetbrains.kotlin.portable.storageprobe

import com.intellij.openapi.progress.ProcessCanceledException
import org.jetbrains.kotlin.storage.*
import org.jetbrains.kotlin.utils.WrappedValues

private class CollisionKey(val id: Int) {
    override fun hashCode(): Int = 7
    override fun equals(other: Any?): Boolean = other is CollisionKey && other.id == id
}

private class CancellationChild : ProcessCanceledException()

/** Exercises observable compiler storage behavior against original and portable sources. */
fun storageProbe(): String {
    val cases = mutableListOf<String>()
    val manager = LockBasedStorageManager("probe")
    var calls = 0
    val memo = manager.createMemoizedFunction<CollisionKey, Int> { calls++; it.id * 2 }
    cases += "memo:${memo.isComputed(CollisionKey(1))}:${memo(CollisionKey(1))}:${memo(CollisionKey(1))}:${memo(CollisionKey(2))}:$calls:${memo.isComputed(CollisionKey(1))}"
    calls = 0
    val nullableMemo = manager.createMemoizedFunctionWithNullableValues<String, String> { calls++; null }
    cases += "memo-null:${nullableMemo("a")}:${nullableMemo("a")}:$calls:${nullableMemo.isComputed("a")}"
    val fault = IllegalStateException("original-fault")
    calls = 0
    val failedMemo = manager.createMemoizedFunction<String, Int> { calls++; throw fault }
    repeat(2) { try { failedMemo("x"); error("unreachable") } catch (e: Throwable) { cases += "memo-failure:${e === fault}:$calls:${failedMemo.isComputed("x")}" } }
    calls = 0
    val nullLazy = manager.createNullableLazyValue<String> { calls++; null }
    cases += "lazy-null:${nullLazy.isComputed()}:${nullLazy()}:${nullLazy()}:$calls:${nullLazy.isComputed()}:${nullLazy.isComputing()}"
    calls = 0
    val failedLazy = manager.createLazyValue<Int> { calls++; throw fault }
    repeat(2) { try { failedLazy(); error("unreachable") } catch (e: Throwable) { cases += "lazy-failure:${e === fault}:$calls:${failedLazy.isComputed()}:${failedLazy.isComputing()}" } }
    lateinit var recursive: NotNullLazyValue<Int>
    val recursionFlags = mutableListOf<Boolean>()
    calls = 0
    recursive = manager.createLazyValue({ calls++; recursive() }, { first -> recursionFlags += first; if (first) recursive() else 42 })
    cases += "lazy-recursion:${recursive()}:${recursive()}:$calls:${recursionFlags.joinToString(",")}"
    lateinit var defaultRecursive: NotNullLazyValue<Int>
    defaultRecursive = manager.createLazyValue { defaultRecursive() }
    repeat(2) { try { defaultRecursive(); error("unreachable") } catch (e: AssertionError) { cases += "lazy-recursion-error:${e.message.orEmpty().startsWith("Recursion detected in a lazy value")}:${defaultRecursive.isComputed()}:${defaultRecursive.isComputing()}" } }
    lateinit var tolerant: NotNullLazyValue<String>
    calls = 0
    tolerant = manager.createRecursionTolerantLazyValue({ calls++; tolerant() + "done" }, "fallback")
    cases += "lazy-tolerant:${tolerant()}:${tolerant()}:$calls"
    lateinit var nullableRecursive: NullableLazyValue<String>
    nullableRecursive = manager.createRecursionTolerantNullableLazyValue({ nullableRecursive() }, null)
    cases += "lazy-null-tolerant:${nullableRecursive()}:${nullableRecursive.isComputed()}"
    lateinit var post: NotNullLazyValue<String>
    val postEvents = mutableListOf<String>()
    post = manager.createLazyValueWithPostCompute({ "published" }, null) { value -> postEvents += "$value:${post()}:${post.isComputed()}:${post.isComputing()}" }
    cases += "post:${post()}:${post()}:${postEvents.joinToString(",")}"
    lateinit var nullablePost: NullableLazyValue<String>
    nullablePost = manager.createNullableLazyValueWithPostCompute({ null }) { value -> postEvents += "nullable:$value:${nullablePost()}:${nullablePost.isComputing()}" }
    cases += "post-null:${nullablePost()}:${nullablePost.isComputed()}:${postEvents.last()}"
    calls = 0
    val postFailure = manager.createLazyValueWithPostCompute({ 9 }, null) { calls++; throw fault }
    repeat(2) { try { postFailure(); error("unreachable") } catch (e: Throwable) { cases += "post-failure:${e === fault}:$calls:${postFailure.isComputed()}" } }
    calls = 0
    val cancelled = ProcessCanceledException()
    val cancelledLazy = manager.createLazyValue { calls++; if (calls == 1) throw cancelled; 12 }
    try { cancelledLazy(); error("unreachable") } catch (e: Throwable) { cases += "lazy-cancel:${e === cancelled}:${cancelledLazy.isComputed()}:${cancelledLazy.isComputing()}" }
    cases += "lazy-cancel-retry:${cancelledLazy()}:${cancelledLazy()}:$calls"
    calls = 0
    val cancelledMemo = manager.createMemoizedFunction<String, Int> { calls++; if (calls == 1) throw cancelled; 15 }
    try { cancelledMemo("x"); error("unreachable") } catch (e: Throwable) { cases += "memo-cancel:${e === cancelled}:${cancelledMemo.isComputed("x")}" }
    cases += "memo-cancel-retry:${cancelledMemo("x")}:${cancelledMemo("x")}:$calls"
    val cache = manager.createCacheWithNullableValues<CollisionKey, String>()
    calls = 0
    cases += "cache-null:${cache.computeIfAbsent(CollisionKey(1)) { calls++; null }}:${cache.computeIfAbsent(CollisionKey(1)) { error("must-cache-null") }}:$calls"
    val notNullCache = manager.createCacheWithNotNullValues<CollisionKey, String>()
    cases += "cache-key:${notNullCache.computeIfAbsent(CollisionKey(1)) { "first" }}:${notNullCache.computeIfAbsent(CollisionKey(1)) { "second" }}:${notNullCache.computeIfAbsent(CollisionKey(2)) { "third" }}"
    lateinit var recursiveMemo: MemoizedFunctionToNotNull<String, Int>
    val memoFlags = mutableListOf<Boolean>()
    recursiveMemo = manager.createMemoizedFunction({ key -> recursiveMemo(key) + 1 }, { _, first -> memoFlags += first; 4 })
    cases += "memo-recursion:${recursiveMemo("x")}:${recursiveMemo("x")}:${memoFlags.joinToString(",")}"
    var strategyCalls = 0
    val replacement = IllegalArgumentException("replacement")
    val strategyManager = LockBasedStorageManager.createWithExceptionHandling("strategy", LockBasedStorageManager.ExceptionHandlingStrategy { strategyCalls++; replacement })
    val strategyMemo = strategyManager.createMemoizedFunction<String, Int> { throw fault }
    repeat(2) { try { strategyMemo("x"); error("unreachable") } catch (e: Throwable) { cases += "strategy:${e === fault}:${e === replacement}:$strategyCalls" } }
    val sentinel = WrappedValues.escapeNull<String>(null)
    cases += "null-sentinel:${sentinel === WrappedValues.escapeNull<String>(null)}:${WrappedValues.unescapeNull<String>(sentinel)}"
    val escaped = WrappedValues.escapeThrowable(cancelled)
    WrappedValues.throwWrappedProcessCanceledException = true
    try { WrappedValues.unescapeThrowable<Any>(escaped); error("unreachable") } catch (e: WrappedValues.WrappedProcessCanceledException) { cases += "cancel-wrapper:${e.cause === cancelled}:${e.message}" }
    WrappedValues.throwWrappedProcessCanceledException = false
    try { WrappedValues.unescapeThrowable<Any>(escaped); error("unreachable") } catch (e: Throwable) { cases += "cancel-unwrapped:${e === cancelled}" }
    val map = ProbeMap<String>()
    val racing = manager.createMemoizedFunction({ _: String -> 19 }, map)
    map.clobberSecondPut = true
    try { racing("x"); error("unreachable") } catch (e: AssertionError) { cases += "map-race:${e.message.orEmpty().startsWith("Race condition detected")}:${racing.isComputed("x")}" }
    map.clobberSecondPut = false
    cases += "map-race-retry:${racing("x")}:${racing.isComputed("x")}"
    cases += "compute-reentrant:${manager.compute { manager.compute { 18 } }}"
    try { manager.compute { throw fault } } catch (e: Throwable) { cases += "compute-failure:${e === fault}:${manager.compute { 21 }}" }
    val nullKeyMemo = manager.createMemoizedFunction<String?, Int> { 24 }
    try { nullKeyMemo(null); error("unreachable") } catch (e: NullPointerException) { cases += "null-key:${nullKeyMemo("ok")}:${nullKeyMemo.isComputed("ok")}" }
    val cancellationChild = CancellationChild()
    calls = 0
    val childMemo = manager.createMemoizedFunction<String, Int> { calls++; if (calls == 1) throw cancellationChild; 27 }
    try { childMemo("x"); error("unreachable") } catch (e: Throwable) {
        val wasComputed = childMemo.isComputed("x")
        cases += "cancel-subclass:${e === cancellationChild}:$wasComputed:${childMemo("x")}:$calls"
    }
    lateinit var noLocksLazy: NotNullLazyValue<Int>
    calls = 0
    noLocksLazy = LockBasedStorageManager.NO_LOCKS.createLazyValue { calls++; if (calls == 1) noLocksLazy() + 10 else 2 }
    cases += "no-locks-lazy:${noLocksLazy()}:${noLocksLazy()}:$calls:${noLocksLazy.isComputed()}"
    calls = 0
    val noLocksMemo = LockBasedStorageManager.NO_LOCKS.createMemoizedFunction<String, Int> { calls++; 30 }
    cases += "no-locks-memo:${noLocksMemo("x")}:${noLocksMemo("x")}:$calls:${noLocksMemo.isComputed("x")}"
    check(cases.size == 36)
    return "{\"cases\":[" + cases.joinToString(",") { "\"" + it + "\"" } + "]}"
}
