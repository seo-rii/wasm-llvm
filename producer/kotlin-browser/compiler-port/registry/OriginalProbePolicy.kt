package org.jetbrains.kotlin.portable.registryprobe

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

typealias ProbeMap<K, V> = ConcurrentHashMap<K, V>
typealias ProbeCounter = AtomicInteger
fun <T> probeLock(owner: ProbeMap<String, Int>, block: () -> T): T = synchronized(owner, block)
