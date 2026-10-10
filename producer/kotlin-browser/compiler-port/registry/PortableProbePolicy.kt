package org.jetbrains.kotlin.portable.registryprobe

import org.jetbrains.kotlin.portable.registry.RegistryMap
import org.jetbrains.kotlin.portable.registry.RegistryCounter
import org.jetbrains.kotlin.portable.registry.withRegistryLock

typealias ProbeMap<K, V> = RegistryMap<K, V>
typealias ProbeCounter = RegistryCounter
fun <T> probeLock(owner: ProbeMap<String, Int>, block: () -> T): T = withRegistryLock(owner, block)
