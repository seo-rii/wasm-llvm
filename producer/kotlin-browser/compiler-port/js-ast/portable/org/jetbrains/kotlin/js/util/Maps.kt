// Copyright (c) 2011, the Dart project authors.  Please see the AUTHORS file
// for details. All rights reserved. Use of this source code is governed by a
// BSD-style license that can be found in the LICENSE file.

package org.jetbrains.kotlin.js.util

object Maps {
    fun <K, V> put(map: Map<K, V>, key: K, value: V): Map<K, V> = when (map.size) {
        0 -> mapOf(key to value)
        1 -> if (map.containsKey(key)) mapOf(key to value) else HashMap(map).apply { put(key, value) }
        else -> {
            @Suppress("UNCHECKED_CAST")
            (map as MutableMap<K, V>).apply { put(key, value) }
        }
    }
}
