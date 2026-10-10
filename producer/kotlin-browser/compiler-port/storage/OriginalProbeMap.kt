package org.jetbrains.kotlin.portable.storageprobe

class ProbeMap<K> : java.util.concurrent.ConcurrentHashMap<K, Any>() {
    var clobberSecondPut = false
    private var puts = 0
    override fun put(key: K, value: Any): Any? {
        puts++
        if (clobberSecondPut && puts == 2) super.remove(key)
        return super.put(key, value)
    }
}
