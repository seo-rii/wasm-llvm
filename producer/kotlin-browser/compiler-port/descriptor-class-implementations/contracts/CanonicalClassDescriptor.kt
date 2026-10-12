// Generated from the selected original Java AST; do not edit.

package org.jetbrains.kotlin.descriptors



interface ClassDescriptor : org.jetbrains.kotlin.descriptors.ClassifierDescriptorWithTypeParameters, org.jetbrains.kotlin.descriptors.ClassOrPackageFragmentDescriptor, org.jetbrains.kotlin.mpp.RegularClassSymbolMarker {
    fun getMemberScope(typeArguments: List<out org.jetbrains.kotlin.types.TypeProjection>): org.jetbrains.kotlin.resolve.scopes.MemberScope
    fun getMemberScope(typeSubstitution: org.jetbrains.kotlin.types.TypeSubstitution): org.jetbrains.kotlin.resolve.scopes.MemberScope
    fun getUnsubstitutedMemberScope(): org.jetbrains.kotlin.resolve.scopes.MemberScope
    fun getUnsubstitutedInnerClassesScope(): org.jetbrains.kotlin.resolve.scopes.MemberScope
    fun getStaticScope(): org.jetbrains.kotlin.resolve.scopes.MemberScope
    fun getConstructors(): Collection<org.jetbrains.kotlin.descriptors.ClassConstructorDescriptor>
    override fun getContainingDeclaration(): org.jetbrains.kotlin.descriptors.DeclarationDescriptor
    override fun getDefaultType(): org.jetbrains.kotlin.types.SimpleType
    fun getCompanionObjectDescriptor(): org.jetbrains.kotlin.descriptors.ClassDescriptor?
    fun getKind(): org.jetbrains.kotlin.descriptors.ClassKind
    override fun getModality(): org.jetbrains.kotlin.descriptors.Modality
    override fun getVisibility(): org.jetbrains.kotlin.descriptors.DescriptorVisibility
    fun isCompanionObject(): Boolean
    fun isData(): Boolean
    fun isInline(): Boolean
    fun isFun(): Boolean
    fun isValue(): Boolean
    fun getThisAsReceiverParameter(): org.jetbrains.kotlin.descriptors.ReceiverParameterDescriptor
    fun getContextReceivers(): List<org.jetbrains.kotlin.descriptors.ReceiverParameterDescriptor>
    fun getUnsubstitutedPrimaryConstructor(): org.jetbrains.kotlin.descriptors.ClassConstructorDescriptor?
    override fun getDeclaredTypeParameters(): List<org.jetbrains.kotlin.descriptors.TypeParameterDescriptor>
    fun getSealedSubclasses(): Collection<org.jetbrains.kotlin.descriptors.ClassDescriptor>
    fun getValueClassRepresentation(): org.jetbrains.kotlin.descriptors.ValueClassRepresentation<org.jetbrains.kotlin.types.SimpleType>?
    override fun getOriginal(): org.jetbrains.kotlin.descriptors.ClassDescriptor
    fun getDefaultFunctionTypeForSamInterface(): org.jetbrains.kotlin.types.SimpleType?
    fun isDefinitelyNotSamInterface(): Boolean
}
