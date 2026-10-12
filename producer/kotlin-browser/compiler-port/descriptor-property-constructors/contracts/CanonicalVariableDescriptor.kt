// Generated from the selected original Java AST; do not edit.

package org.jetbrains.kotlin.descriptors



interface VariableDescriptor : org.jetbrains.kotlin.descriptors.ValueDescriptor {
    override fun substitute(substitutor: org.jetbrains.kotlin.types.TypeSubstitutor): org.jetbrains.kotlin.descriptors.VariableDescriptor
    fun isVar(): Boolean
    fun getCompileTimeInitializer(): org.jetbrains.kotlin.resolve.constants.ConstantValue<*>?
    fun cleanCompileTimeInitializerCache(): Unit
    fun isConst(): Boolean
    fun isLateInit(): Boolean
}
