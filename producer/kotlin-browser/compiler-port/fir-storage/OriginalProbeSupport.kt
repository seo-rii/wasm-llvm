package org.jetbrains.kotlin.portable.firstorageprobe

import org.jetbrains.kotlin.ir.IrLock

typealias Cache<K, V> = java.util.concurrent.ConcurrentHashMap<K, V>

inline fun <T> IrLock.withObservedLock(block: () -> T): T = synchronized(this, block)
fun lockHeld(lock: IrLock): Boolean = Thread.holdsLock(lock)
