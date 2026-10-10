package org.jetbrains.kotlin.portable.k1profile.probe

import org.jetbrains.kotlin.container.DefaultImplementation
import org.jetbrains.kotlin.container.PlatformSpecificExtension

@DefaultImplementation(DefaultService::class)
private interface Service : PlatformSpecificExtension<Service>
private class DefaultService : Service
private object OtherService : Service

fun observeRetainedK1Contracts(): String = buildString {
    val first: Service = DefaultService()
    val second: Service = OtherService
    for (index in 0 until 256) {
        val selected: PlatformSpecificExtension<Service> = if (index % 3 == 0) second else first
        append("marker:").append(index).append(':').append(selected === first).append(':').append(selected === second).append('\n')
    }
    val actual = DefaultImplementation(DefaultService::class)
    val equal = DefaultImplementation(DefaultService::class)
    val other = DefaultImplementation(OtherService::class)
    append("annotation-value:").append(actual.impl == DefaultService::class).append('\n')
    append("annotation-equal:").append(actual == equal).append('\n')
    append("annotation-other:").append(actual == other).append('\n')
    append("annotation-fresh:").append(actual === equal).append('\n')
    append("annotation-class:").append(actual.impl.simpleName).append('\n')
    append("annotation-string:").append(DefaultImplementation(String::class).impl == String::class).append('\n')
    append("annotation-int:").append(DefaultImplementation(Int::class).impl == Int::class).append('\n')
}
