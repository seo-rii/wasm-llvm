/* Typed compatibility for the selected original Java getter. */
package org.jetbrains.kotlin.portable.descriptors

val org.jetbrains.kotlin.types.TypeSubstitutor.substitution: org.jetbrains.kotlin.types.TypeSubstitution
    get() = getSubstitution()
