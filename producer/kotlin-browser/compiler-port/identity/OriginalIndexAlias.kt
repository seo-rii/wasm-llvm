package org.jetbrains.kotlin.portable.identityprobe

// JVM reference only: the actual JDK IdentityHashMap, not a stand-in.
typealias ProbeIndex<K, V> = java.util.IdentityHashMap<K, V>
