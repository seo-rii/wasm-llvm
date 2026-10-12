// Generated from the selected original Java AST; do not edit.

package org.jetbrains.kotlin.descriptors



interface PropertyDescriptor : org.jetbrains.kotlin.descriptors.VariableDescriptorWithAccessors, org.jetbrains.kotlin.descriptors.CallableMemberDescriptor, org.jetbrains.kotlin.mpp.PropertySymbolMarker {
    override val getter: org.jetbrains.kotlin.descriptors.PropertyGetterDescriptor?
    override val setter: org.jetbrains.kotlin.descriptors.PropertySetterDescriptor?
    fun isSetterProjectedOut(): Boolean
    fun getAccessors(): List<org.jetbrains.kotlin.descriptors.PropertyAccessorDescriptor>
    override fun getOriginal(): org.jetbrains.kotlin.descriptors.PropertyDescriptor
    override fun getOverriddenDescriptors(): Collection<out org.jetbrains.kotlin.descriptors.PropertyDescriptor>
    fun getBackingField(): org.jetbrains.kotlin.descriptors.FieldDescriptor?
    fun getDelegateField(): org.jetbrains.kotlin.descriptors.FieldDescriptor?
    override fun substitute(substitutor: org.jetbrains.kotlin.types.TypeSubstitutor): org.jetbrains.kotlin.descriptors.PropertyDescriptor?
    override fun newCopyBuilder(): org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.CopyBuilder<out org.jetbrains.kotlin.descriptors.PropertyDescriptor?>
    fun getInType(): org.jetbrains.kotlin.types.KotlinType?
}
