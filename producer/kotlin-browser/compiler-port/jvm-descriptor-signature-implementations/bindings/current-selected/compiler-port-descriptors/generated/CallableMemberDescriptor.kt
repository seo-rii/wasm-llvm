// Generated from the selected original Java AST; do not edit.

package org.jetbrains.kotlin.descriptors



interface CallableMemberDescriptor : org.jetbrains.kotlin.descriptors.CallableDescriptor, org.jetbrains.kotlin.descriptors.MemberDescriptor {
    override fun getOverriddenDescriptors(): Collection<out org.jetbrains.kotlin.descriptors.CallableMemberDescriptor>
    override fun getOriginal(): org.jetbrains.kotlin.descriptors.CallableMemberDescriptor
    fun setOverriddenDescriptors(overriddenDescriptors: Collection<out org.jetbrains.kotlin.descriptors.CallableMemberDescriptor>): Unit
    enum class Kind {
        DECLARATION,
        FAKE_OVERRIDE,
        DELEGATION,
        SYNTHESIZED;
        fun isReal(): Boolean = this != FAKE_OVERRIDE
    }
    fun getKind(): org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.Kind
    fun copy(newOwner: org.jetbrains.kotlin.descriptors.DeclarationDescriptor?, modality: org.jetbrains.kotlin.descriptors.Modality?, visibility: org.jetbrains.kotlin.descriptors.DescriptorVisibility?, kind: org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.Kind?, copyOverrides: Boolean): org.jetbrains.kotlin.descriptors.CallableMemberDescriptor
    fun newCopyBuilder(): org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.CopyBuilder<out org.jetbrains.kotlin.descriptors.CallableMemberDescriptor?>
    interface CopyBuilder<D: org.jetbrains.kotlin.descriptors.CallableMemberDescriptor?> {
        fun setOwner(owner: org.jetbrains.kotlin.descriptors.DeclarationDescriptor): org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.CopyBuilder<D>
        fun setModality(modality: org.jetbrains.kotlin.descriptors.Modality): org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.CopyBuilder<D>
        fun setVisibility(visibility: org.jetbrains.kotlin.descriptors.DescriptorVisibility): org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.CopyBuilder<D>
        fun setKind(kind: org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.Kind): org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.CopyBuilder<D>
        fun setTypeParameters(parameters: List<org.jetbrains.kotlin.descriptors.TypeParameterDescriptor>): org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.CopyBuilder<D>
        fun setDispatchReceiverParameter(dispatchReceiverParameter: org.jetbrains.kotlin.descriptors.ReceiverParameterDescriptor?): org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.CopyBuilder<D>
        fun setSubstitution(substitution: org.jetbrains.kotlin.types.TypeSubstitution): org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.CopyBuilder<D>
        fun setCopyOverrides(copyOverrides: Boolean): org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.CopyBuilder<D>
        fun setName(name: org.jetbrains.kotlin.name.Name): org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.CopyBuilder<D>
        fun setOriginal(original: org.jetbrains.kotlin.descriptors.CallableMemberDescriptor?): org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.CopyBuilder<D>
        fun setPreserveSourceElement(): org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.CopyBuilder<D>
        fun setReturnType(type: org.jetbrains.kotlin.types.KotlinType): org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.CopyBuilder<D>
        fun build(): D?
    }
}
