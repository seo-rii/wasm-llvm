package org.jetbrains.kotlin.portable.firstorageprobe

import org.jetbrains.kotlin.ir.IrLock
import org.jetbrains.kotlin.ir.withLock

typealias Cache<K, V> = org.jetbrains.kotlin.utils.SerialFirCacheMap<K, V>

inline fun <T> IrLock.withObservedLock(block: () -> T): T = withLock(block)
fun lockHeld(lock: IrLock): Boolean = lock.serialDepth > 0
