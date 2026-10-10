package org.jetbrains.kotlin.portable.registryprobe

import org.jetbrains.kotlin.fir.util.ConeTypeRegistry
import org.jetbrains.kotlin.util.*
import kotlin.reflect.KClass

private open class FirstKey
private class SecondKey
private interface InterfaceKey
private class 한글Key
private class PrivateContainer {
    private class HiddenKey
    companion object { fun hiddenKey(): KClass<out Any> = HiddenKey::class }
    class NestedKey
}

private class Registry : ConeTypeRegistry<Any, String>()
private val lifetimeRegistry = Registry()

private class Components(override val typeRegistry: TypeRegistry<Any, String>) : ComponentArrayOwner<Any, String>() {
    val first: String by typeRegistry.generateAccessor<String, FirstKey>(FirstKey::class)
    val nullableFirst: String? by typeRegistry.generateNullableAccessor< String, FirstKey>(FirstKey::class)
    val anyFirst: String? by typeRegistry.generateAnyNullableAccessor(FirstKey::class)
    val default: String by typeRegistry.generateAccessor("missing-default", "fallback")
    fun put(key: KClass<out Any>, value: String) = registerComponent(key, value)
    fun put(key: String, value: String) = registerComponent(key, value)
    fun read(key: KClass<out Any>): String = get(key)
    fun maybe(key: KClass<out Any>): String? = getOrNull(key)
}

private class Attributes : AttributeArrayOwner<Any, String> {
    override val typeRegistry: TypeRegistry<Any, String>
    constructor(registry: TypeRegistry<Any, String>) : super() { typeRegistry = registry }
    private constructor(registry: TypeRegistry<Any, String>, map: ArrayMap<String>) : super(map) { typeRegistry = registry }
    fun put(key: KClass<out Any>, value: String) = registerComponent(key, value)
    fun remove(key: KClass<out Any>) = removeComponent(key)
    fun snapshot(): Attributes = Attributes(typeRegistry, arrayMap.copy())
    fun shape(): String = arrayMap::class.simpleName!!
}

/** Original TypeAttributes legacy callback policy, observed with controllable side effects. */
private class LegacyRegistry : TypeRegistry<Any, String>() {
    var hook: (String) -> Unit = {}
    override fun ProbeMap<String, Int>.customComputeIfAbsent(key: String, compute: (String) -> Int): Int {
        return this[key] ?: probeLock(this) {
            this[key] ?: run { hook(key); compute(key) }.also { this.putIfAbsent(key, it) }
        }
    }
}

private class FaultRegistry : TypeRegistry<Any, String>() {
    var hook: (String) -> Unit = {}
    override fun ProbeMap<String, Int>.customComputeIfAbsent(key: String, compute: (String) -> Int): Int =
        computeIfAbsent(key) { hook(it); compute(it) }
}

private fun quoted(text: String): String = buildString {
    append('"')
    for (c in text) when (c) {
        '"' -> append("\\\"")
        '\\' -> append("\\\\")
        '\n' -> append("\\n")
        '\r' -> append("\\r")
        '\t' -> append("\\t")
        else -> if (c.code < 32) append("\\u" + c.code.toString(16).padStart(4, '0')) else append(c)
    }
    append('"')
}

/** Shared observer compiled against the exact original and the prepared common source bodies. */
fun registryProbe(): String {
    val cases = mutableListOf<String>()
    val keys = listOf(FirstKey::class, SecondKey::class, InterfaceKey::class, PrivateContainer.hiddenKey(), PrivateContainer.NestedKey::class, 한글Key::class)
    val registry = Registry()
    for (key in keys) cases += "key:${key.qualifiedName}:${registry.getId(key)}:${registry.getId(key.qualifiedName!!)}:${registry.getId(key)}"
    cases += "builtin:${String::class.qualifiedName}:${Any::class.qualifiedName}:${registry.getId(String::class)}:${registry.getId(Any::class)}"
    cases += "independent:${Registry().getId(FirstKey::class)}:${Registry().getId(SecondKey::class)}"
    val live = registry.allValuesThreadUnsafeForRendering()
    val before = live.size
    registry.getId("new-live-key")
    cases += "live:${live.size - before}:${live["new-live-key"] == registry.getId("new-live-key")}"
    val collisionRegistry = Registry()
    cases += "collision:${"Aa".hashCode() == "BB".hashCode()}:${collisionRegistry.getId("Aa")}:${collisionRegistry.getId("BB")}:${collisionRegistry.getId("Aa")}"
    val component = Components(registry)
    cases += "accessor-empty:${component.nullableFirst}:${component.anyFirst}:${component.default}:${component.isEmpty()}"
    try { component.first; error("Must fail on absent service") } catch (e: IllegalStateException) { cases += "accessor-missing:${e.message.orEmpty().startsWith("No '")}" }
    component.put(FirstKey::class, "first")
    cases += "accessor-present:${component.first}:${component.nullableFirst}:${component.anyFirst}:${component.read(FirstKey::class)}:${component.isNotEmpty()}"
    component.put(FirstKey::class.qualifiedName!!, "replaced")
    cases += "component-overwrite:${component.first}:${component.toList().joinToString(",")}:${component.maybe(SecondKey::class)}"
    val freshComponent = Components(registry)
    cases += "owner-isolation:${freshComponent.nullableFirst}:${component.first}:${registry.getId(FirstKey::class)}"
    val lifetimeA = Components(lifetimeRegistry)
    lifetimeA.put(FirstKey::class, "request-a")
    val id = lifetimeRegistry.getId(FirstKey::class)
    val lifetimeB = Components(lifetimeRegistry)
    lifetimeB.put(FirstKey::class, "request-b")
    cases += "lifetime:${lifetimeRegistry.getId(FirstKey::class) == id}:${lifetimeA.first}:${lifetimeB.first}"
    val attributes = Attributes(registry)
    cases += "attribute-empty:${attributes.shape()}:${attributes.isEmpty()}"
    attributes.put(SecondKey::class, "second")
    attributes.put(SecondKey::class, "second-overwrite")
    cases += "attribute-one:${attributes.shape()}:${attributes.toList().joinToString(",")}"
    attributes.put(FirstKey::class, "first")
    val saved = attributes.snapshot()
    cases += "attribute-many:${attributes.shape()}:${attributes.toList().joinToString(",")}"
    attributes.remove(PrivateContainer.NestedKey::class)
    attributes.remove(FirstKey::class)
    cases += "attribute-reduce:${attributes.shape()}:${attributes.toList().joinToString(",")}:${saved.toList().joinToString(",")}"
    attributes.remove(SecondKey::class)
    attributes.remove(SecondKey::class)
    cases += "attribute-clear:${attributes.shape()}:${attributes.isEmpty()}:${saved.toList().joinToString(",")}"
    val array = ArrayMapImpl<String>()
    for (index in listOf(80, 0, 20, 19)) array[index] = "v$index"
    array[20] = "overwrite"
    val copied = array.copy()
    array.remove(19)
    cases += "array-growth:${array.size}:${array.toList().joinToString(",")}:${array[-1]}:${array[1000]}:${copied[19]}:${copied.size}"
    val one = OneElementArrayMap("value", 4)
    val iterator = one.iterator()
    var exhausted = false
    iterator.next()
    try { iterator.next() } catch (e: NoSuchElementException) { exhausted = true }
    cases += "one-map:${one[0]}:${one[4]}:${one.copy()[4]}:${iterator.hasNext()}:$exhausted"
    val map = ProbeMap<String, Int>()
    var calls = 0
    cases += "map-compute:${map.computeIfAbsent("a") { calls++; 10 }}:${map.computeIfAbsent("a") { calls++; 99 }}:$calls:${map.putIfAbsent("a", 22)}"
    val failure = IllegalArgumentException("callback failure")
    try { map.computeIfAbsent("failed") { throw failure } } catch (e: Throwable) { cases += "map-failure:${e === failure}:${map.containsKey("failed")}:${map.computeIfAbsent("failed") { 23 }}" }
    try { map.computeIfAbsent("recursive") { map.computeIfAbsent("recursive") { 9 } } } catch (e: IllegalStateException) { cases += "map-recursive:${e.message == "Recursive update"}:${map.containsKey("recursive")}:${map.computeIfAbsent("recursive") { 24 }}" }
    cases += "map-existing-reentry:${map.computeIfAbsent("other") { map.computeIfAbsent("a") { error("Existing key must not recompute") } + 1 }}"
    val counter = ProbeCounter(Int.MAX_VALUE)
    cases += "counter-overflow:${counter.getAndIncrement()}:${counter.getAndIncrement()}:${counter.getAndIncrement()}"
    val faulty = FaultRegistry()
    faulty.hook = { throw failure }
    try { faulty.getId("failed") } catch (e: Throwable) { cases += "registry-failure:${e === failure}:${faulty.allValuesThreadUnsafeForRendering().isEmpty()}" }
    faulty.hook = {}
    cases += "registry-retry:${faulty.getId("failed")}:${faulty.getId("failed")}:${faulty.getId("next")}"
    val legacy = LegacyRegistry()
    var nestedId = -1
    legacy.hook = { key -> legacy.hook = {}; nestedId = legacy.getId(key) }
    cases += "legacy-reentry:${legacy.getId("same")}:$nestedId:${legacy.getId("same")}:${legacy.getId("next")}"
    val legacyFailed = LegacyRegistry()
    legacyFailed.hook = { throw failure }
    try { legacyFailed.getId("failed") } catch (e: Throwable) { cases += "legacy-failure:${e === failure}:${legacyFailed.allValuesThreadUnsafeForRendering().isEmpty()}" }
    legacyFailed.hook = {}
    cases += "legacy-retry:${legacyFailed.getId("failed")}:${legacyFailed.getId("next")}"
    val anonymous = object {}
    class LocalKey
    var anonymousRejected = false
    var localRejected = false
    try { registry.getId(anonymous::class) } catch (e: NullPointerException) { anonymousRejected = true }
    try { registry.getId(LocalKey::class) } catch (e: NullPointerException) { localRejected = true }
    cases += "unsupported:${anonymous::class.qualifiedName}:${LocalKey::class.qualifiedName}:$anonymousRejected:$localRejected"
    check(cases.size == 34) { "Unexpected observation count: ${cases.size}" }
    return "{\"cases\":[" + cases.joinToString(",", transform = ::quoted) + "]}"
}
