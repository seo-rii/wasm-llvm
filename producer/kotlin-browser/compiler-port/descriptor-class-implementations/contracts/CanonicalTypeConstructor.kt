// Generated from the selected original Java AST; do not edit.

package org.jetbrains.kotlin.types



interface TypeConstructor : org.jetbrains.kotlin.types.model.TypeConstructorMarker {
    fun getParameters(): List<org.jetbrains.kotlin.descriptors.TypeParameterDescriptor>
    fun getSupertypes(): Collection<org.jetbrains.kotlin.types.KotlinType>
    fun isFinal(): Boolean
    fun isDenotable(): Boolean
    fun getDeclarationDescriptor(): org.jetbrains.kotlin.descriptors.ClassifierDescriptor?
    fun getBuiltIns(): org.jetbrains.kotlin.builtins.KotlinBuiltIns
    @org.jetbrains.kotlin.types.TypeRefinement
    fun refine(kotlinTypeRefiner: org.jetbrains.kotlin.types.checker.KotlinTypeRefiner): org.jetbrains.kotlin.types.TypeConstructor
}
