/* Actual complete constant classes and the genuine visitor interface; no replacement compiler receivers. */
package org.jetbrains.kotlin.portable.nullconstant.probe

import java.lang.reflect.Proxy
import org.jetbrains.kotlin.builtins.DefaultBuiltIns
import org.jetbrains.kotlin.descriptors.annotations.AnnotationArgumentVisitor
import org.jetbrains.kotlin.resolve.constants.*

fun main() = print(buildString {
    val module = DefaultBuiltIns.Instance.builtInsModule
    val expectedType = module.builtIns.nullableNothingType
    repeat(128) { index ->
        val value = NullValue()
        val widened: ConstantValue<Any?> = value
        val other = NullValue()
        val data = Any()
        var calls = 0
        @Suppress("UNCHECKED_CAST")
        val visitor = Proxy.newProxyInstance(AnnotationArgumentVisitor::class.java.classLoader,
            arrayOf(AnnotationArgumentVisitor::class.java)) { _, method, arguments ->
            check(method.name == "visitNullValue"); check(arguments!![0] === value); check(arguments[1] === data)
            calls++
            data
        } as AnnotationArgumentVisitor<Any, Any>
        fun record(name: String, result: Any?) { append(index).append('/').append(name).append('\t').append(result).append('\n') }
        record("value", value.value)
        record("widened-value", widened.value)
        record("boxed", value.boxedValue())
        record("hash", value.hashCode())
        record("string", value.toString())
        record("same-instance", value.equals(value))
        record("other-null", value.equals(other))
        record("null-argument", value.equals(null))
        record("other-object", value.equals(Any()))
        record("other-constant", value.equals(IntValue(index)))
        record("nullable-nothing-type-identity", value.getType(module) === expectedType)
        record("nullable-nothing-type", value.getType(module).toString())
        record("visitor-data-identity", value.accept(visitor, data) === data)
        record("visitor-calls", calls)
        val map = hashMapOf<ConstantValue<*>, String>(value to "null")
        record("equal-map-key", map[other])
        record("widened-map-key", map[widened])
    }
})
