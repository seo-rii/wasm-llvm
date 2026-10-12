// Generated from the selected original Java AST; do not edit.

package org.jetbrains.kotlin.types.checker



interface KotlinTypeChecker {
    interface TypeConstructorEquality {
        fun equals(a: org.jetbrains.kotlin.types.TypeConstructor, b: org.jetbrains.kotlin.types.TypeConstructor): Boolean
    }
    fun isSubtypeOf(subtype: org.jetbrains.kotlin.types.KotlinType, supertype: org.jetbrains.kotlin.types.KotlinType): Boolean
    fun equalTypes(a: org.jetbrains.kotlin.types.KotlinType, b: org.jetbrains.kotlin.types.KotlinType): Boolean
    companion object {
        @kotlin.jvm.JvmField
        val DEFAULT: org.jetbrains.kotlin.types.checker.KotlinTypeChecker = org.jetbrains.kotlin.types.checker.NewKotlinTypeChecker.Default
    }
}
