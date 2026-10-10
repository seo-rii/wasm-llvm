/*
 * Copyright 2010-2015 JetBrains s.r.o.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package org.jetbrains.kotlin.name

import kotlin.jvm.JvmName
import kotlin.jvm.JvmStatic

/** Common port of the pinned core/names Name.java; see name.recipe.json. */
class Name private constructor(private val name: String, private val special: Boolean) : Comparable<Name> {
    fun asString(): String = name

    fun getIdentifier(): String {
        if (special) throw IllegalStateException("not identifier: " + this)
        return asString()
    }

    // Kotlin callers of the Java source use synthetic properties. Keep those
    // source spellings and the original Java methods when building this on JVM.
    @get:JvmName("identifierProperty")
    val identifier: String get() = getIdentifier()

    fun isSpecial(): Boolean = special

    @get:JvmName("isSpecialProperty")
    val isSpecial: Boolean get() = isSpecial()

    fun asStringStripSpecialMarkers(): String {
        if (isSpecial()) return asString().substring(1, asString().length - 1)
        return asString()
    }

    override fun compareTo(other: Name): Int {
        // java.lang.String.compareTo returns the UTF-16 code-unit difference,
        // or the length difference. Preserve the actual integer on every host.
        val limit = minOf(name.length, other.name.length)
        for (index in 0 until limit) {
            val difference = name[index].code - other.name[index].code
            if (difference != 0) return difference
        }
        return name.length - other.name.length
    }

    fun getIdentifierOrNullIfSpecial(): String? {
        if (special) return null
        return asString()
    }

    @get:JvmName("identifierOrNullIfSpecialProperty")
    val identifierOrNullIfSpecial: String? get() = getIdentifierOrNullIfSpecial()

    override fun toString(): String = name

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Name) return false
        if (special != other.special) return false
        if (name != other.name) return false
        return true
    }

    override fun hashCode(): Int {
        var result = name.hashCode()
        result = 31 * result + if (special) 1 else 0
        return result
    }

    companion object {
        @JvmStatic
        fun identifier(name: String): Name = Name(name, false)

        @JvmStatic
        fun isValidIdentifier(name: String): Boolean {
            if (name.isEmpty() || name.startsWith("<")) return false
            for (index in name.indices) {
                val character = name[index]
                if (character == '.' || character == ';' || character == '[' || character == '/') return false
            }
            return true
        }

        @JvmStatic
        fun identifierIfValid(name: String): Name? {
            if (!isValidIdentifier(name)) return null
            return identifier(name)
        }

        @JvmStatic
        fun special(name: String): Name {
            if (!name.startsWith("<")) throw IllegalArgumentException("special name must start with '<': " + name)
            return Name(name, true)
        }

        @JvmStatic
        fun guessByFirstCharacter(name: String): Name {
            if (name.startsWith("<")) return special(name)
            return identifier(name)
        }
    }
}
