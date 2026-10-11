/* Preserve Java synthetic-property spelling for the actual common virtual getter. */
package org.jetbrains.kotlin.portable.descriptors

val org.jetbrains.kotlin.types.TypeSubstitutor.isEmpty: Boolean
    get() = isEmpty()
