package org.jetbrains.kotlin.portable.storageprobe

class ProbeMap<K>(private val backing: MutableMap<K, Any> = HashMap()) : MutableMap<K, Any> by backing {
    var clobberSecondPut = false
    private var puts = 0
    override fun put(key: K, value: Any): Any? {
        puts++
        if (clobberSecondPut && puts == 2) backing.remove(key)
        return backing.put(key, value)
    }
}
