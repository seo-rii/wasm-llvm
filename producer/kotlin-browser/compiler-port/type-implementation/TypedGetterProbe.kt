package org.jetbrains.kotlin.portable.typeimplementation.probe

import org.jetbrains.kotlin.portable.descriptors.substitution
import org.jetbrains.kotlin.types.TypeSubstitution
import org.jetbrains.kotlin.types.TypeSubstitutor

// Compiled against the portable Kotlin class metadata, where Java synthetic getter properties are unavailable.
fun main() {
    val original = TypeSubstitution.EMPTY
    val substitutor = TypeSubstitutor.create(original)
    check(substitutor.substitution === original && substitutor.getSubstitution() === original)
    println("typed portable substitution getter: pass")
}
