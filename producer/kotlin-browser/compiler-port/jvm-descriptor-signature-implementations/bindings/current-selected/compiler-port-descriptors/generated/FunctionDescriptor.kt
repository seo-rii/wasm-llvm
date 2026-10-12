// Generated from the selected original Java AST; do not edit.

package org.jetbrains.kotlin.descriptors



interface FunctionDescriptor : org.jetbrains.kotlin.descriptors.CallableMemberDescriptor, org.jetbrains.kotlin.mpp.FunctionSymbolMarker {
    override fun getContainingDeclaration(): org.jetbrains.kotlin.descriptors.DeclarationDescriptor
    override fun getOriginal(): org.jetbrains.kotlin.descriptors.FunctionDescriptor
    override fun substitute(substitutor: org.jetbrains.kotlin.types.TypeSubstitutor): org.jetbrains.kotlin.descriptors.FunctionDescriptor?
    override fun getOverriddenDescriptors(): Collection<out org.jetbrains.kotlin.descriptors.FunctionDescriptor>
    fun getInitialSignatureDescriptor(): org.jetbrains.kotlin.descriptors.FunctionDescriptor?
    fun isHiddenToOvercomeSignatureClash(): Boolean
    override fun copy(newOwner: org.jetbrains.kotlin.descriptors.DeclarationDescriptor?, modality: org.jetbrains.kotlin.descriptors.Modality?, visibility: org.jetbrains.kotlin.descriptors.DescriptorVisibility?, kind: org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.Kind?, copyOverrides: Boolean): org.jetbrains.kotlin.descriptors.FunctionDescriptor
    fun isOperator(): Boolean
    fun isInfix(): Boolean
    fun isInline(): Boolean
    fun isTailrec(): Boolean
    fun isHiddenForResolutionEverywhereBesideSupercalls(): Boolean
    fun isSuspend(): Boolean
    override fun newCopyBuilder(): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<out org.jetbrains.kotlin.descriptors.FunctionDescriptor?>
    interface CopyBuilder<D: org.jetbrains.kotlin.descriptors.FunctionDescriptor?> : org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.CopyBuilder<D> {
        override fun setOwner(owner: org.jetbrains.kotlin.descriptors.DeclarationDescriptor): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<D>
        override fun setModality(modality: org.jetbrains.kotlin.descriptors.Modality): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<D>
        override fun setVisibility(visibility: org.jetbrains.kotlin.descriptors.DescriptorVisibility): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<D>
        override fun setKind(kind: org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.Kind): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<D>
        override fun setCopyOverrides(copyOverrides: Boolean): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<D>
        override fun setName(name: org.jetbrains.kotlin.name.Name): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<D>
        fun setValueParameters(parameters: List<org.jetbrains.kotlin.descriptors.ValueParameterDescriptor>): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<D>
        override fun setTypeParameters(parameters: List<org.jetbrains.kotlin.descriptors.TypeParameterDescriptor>): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<D>
        override fun setReturnType(type: org.jetbrains.kotlin.types.KotlinType): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<D>
        fun setContextReceiverParameters(contextReceiverParameters: List<org.jetbrains.kotlin.descriptors.ReceiverParameterDescriptor>): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<D>
        fun setExtensionReceiverParameter(extensionReceiverParameter: org.jetbrains.kotlin.descriptors.ReceiverParameterDescriptor?): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<D>
        override fun setDispatchReceiverParameter(dispatchReceiverParameter: org.jetbrains.kotlin.descriptors.ReceiverParameterDescriptor?): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<D>
        override fun setOriginal(original: org.jetbrains.kotlin.descriptors.CallableMemberDescriptor?): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<D>
        fun setSignatureChange(): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<D>
        override fun setPreserveSourceElement(): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<D>
        fun setDropOriginalInContainingParts(): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<D>
        fun setHiddenToOvercomeSignatureClash(): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<D>
        fun setHiddenForResolutionEverywhereBesideSupercalls(): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<D>
        fun setAdditionalAnnotations(additionalAnnotations: org.jetbrains.kotlin.descriptors.annotations.Annotations): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<D>
        override fun setSubstitution(substitution: org.jetbrains.kotlin.types.TypeSubstitution): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<D>
        fun <V> putUserData(userDataKey: org.jetbrains.kotlin.descriptors.CallableDescriptor.UserDataKey<V>, value: V): org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder<D>
        override fun build(): D?
    }
}
