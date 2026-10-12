// Generated from the selected original Java AST; do not edit.

package org.jetbrains.kotlin.descriptors



interface CallableDescriptor : org.jetbrains.kotlin.descriptors.DeclarationDescriptorWithVisibility, org.jetbrains.kotlin.descriptors.DeclarationDescriptorNonRoot, org.jetbrains.kotlin.descriptors.Substitutable<org.jetbrains.kotlin.descriptors.CallableDescriptor>, org.jetbrains.kotlin.mpp.CallableSymbolMarker {
    fun getContextReceiverParameters(): List<org.jetbrains.kotlin.descriptors.ReceiverParameterDescriptor>
    fun getExtensionReceiverParameter(): org.jetbrains.kotlin.descriptors.ReceiverParameterDescriptor?
    fun getDispatchReceiverParameter(): org.jetbrains.kotlin.descriptors.ReceiverParameterDescriptor?
    fun getTypeParameters(): List<org.jetbrains.kotlin.descriptors.TypeParameterDescriptor>
    fun getReturnType(): org.jetbrains.kotlin.types.KotlinType?
    override fun getOriginal(): org.jetbrains.kotlin.descriptors.CallableDescriptor
    fun getValueParameters(): List<org.jetbrains.kotlin.descriptors.ValueParameterDescriptor>
    fun hasStableParameterNames(): Boolean
    fun hasSynthesizedParameterNames(): Boolean
    fun getOverriddenDescriptors(): Collection<out org.jetbrains.kotlin.descriptors.CallableDescriptor>
    interface UserDataKey<V> {
    }
    fun <V> getUserData(key: org.jetbrains.kotlin.descriptors.CallableDescriptor.UserDataKey<V>?): V?
}
