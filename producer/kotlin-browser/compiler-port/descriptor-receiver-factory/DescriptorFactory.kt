/*
 * Copyright 2010-2015 JetBrains s.r.o.
 * Licensed under the Apache License, Version 2.0.
 */
package org.jetbrains.kotlin.resolve

import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.descriptors.impl.*
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.name.NameUtils
import org.jetbrains.kotlin.resolve.scopes.receivers.ContextClassReceiver
import org.jetbrains.kotlin.resolve.scopes.receivers.ContextReceiver
import org.jetbrains.kotlin.resolve.scopes.receivers.ExtensionReceiver
import org.jetbrains.kotlin.types.*
import org.jetbrains.kotlin.builtins.StandardNames.ENUM_VALUES
import org.jetbrains.kotlin.builtins.StandardNames.ENUM_VALUE_OF
import org.jetbrains.kotlin.builtins.StandardNames.ENUM_ENTRIES
import org.jetbrains.kotlin.resolve.descriptorUtil.builtIns

/** The complete factory; its property and constructor dependencies remain genuine compiler implementations. */
object DescriptorFactory {
    private class DefaultClassConstructorDescriptor(containingClass: ClassDescriptor, source: SourceElement,
        freedomForSealedInterfacesSupported: Boolean) :
        ClassConstructorDescriptorImpl(containingClass, null, Annotations.EMPTY, true, CallableMemberDescriptor.Kind.DECLARATION, source) {
        init { initialize(emptyList(), DescriptorUtils.getDefaultConstructorVisibility(containingClass, freedomForSealedInterfacesSupported)) }
    }

    @kotlin.jvm.JvmStatic
    fun createDefaultSetter(propertyDescriptor: PropertyDescriptor, annotations: Annotations, parameterAnnotations: Annotations): PropertySetterDescriptorImpl =
        createSetter(propertyDescriptor, annotations, parameterAnnotations, true, false, false, propertyDescriptor.getSource())
    @kotlin.jvm.JvmStatic
    fun createSetter(propertyDescriptor: PropertyDescriptor, annotations: Annotations, parameterAnnotations: Annotations,
        isDefault: Boolean, isExternal: Boolean, isInline: Boolean, sourceElement: SourceElement): PropertySetterDescriptorImpl =
        createSetter(propertyDescriptor, annotations, parameterAnnotations, isDefault, isExternal, isInline, propertyDescriptor.getVisibility(), sourceElement)
    @kotlin.jvm.JvmStatic
    fun createSetter(propertyDescriptor: PropertyDescriptor, annotations: Annotations, parameterAnnotations: Annotations,
        isDefault: Boolean, isExternal: Boolean, isInline: Boolean, visibility: DescriptorVisibility, sourceElement: SourceElement): PropertySetterDescriptorImpl {
        val setterDescriptor = PropertySetterDescriptorImpl(propertyDescriptor, annotations, propertyDescriptor.getModality(), visibility,
            isDefault, isExternal, isInline, CallableMemberDescriptor.Kind.DECLARATION, null, sourceElement)
        val parameter = PropertySetterDescriptorImpl.createSetterParameter(setterDescriptor, propertyDescriptor.getType(), parameterAnnotations)
        setterDescriptor.initialize(parameter)
        return setterDescriptor
    }

    @kotlin.jvm.JvmStatic
    fun createDefaultGetter(propertyDescriptor: PropertyDescriptor, annotations: Annotations): PropertyGetterDescriptorImpl =
        createGetter(propertyDescriptor, annotations, true, false, false)
    @kotlin.jvm.JvmStatic
    fun createGetter(propertyDescriptor: PropertyDescriptor, annotations: Annotations, isDefault: Boolean,
        isExternal: Boolean, isInline: Boolean): PropertyGetterDescriptorImpl =
        createGetter(propertyDescriptor, annotations, isDefault, isExternal, isInline, propertyDescriptor.getSource())
    @kotlin.jvm.JvmStatic
    fun createGetter(propertyDescriptor: PropertyDescriptor, annotations: Annotations, isDefault: Boolean,
        isExternal: Boolean, isInline: Boolean, sourceElement: SourceElement): PropertyGetterDescriptorImpl =
        PropertyGetterDescriptorImpl(propertyDescriptor, annotations, propertyDescriptor.getModality(), propertyDescriptor.getVisibility(),
            isDefault, isExternal, isInline, CallableMemberDescriptor.Kind.DECLARATION, null, sourceElement)

    @kotlin.jvm.JvmStatic
    fun createPrimaryConstructorForObject(containingClass: ClassDescriptor, source: SourceElement): ClassConstructorDescriptorImpl =
        // Objects cannot be sealed classes; the original deliberately passes false here.
        DefaultClassConstructorDescriptor(containingClass, source, false)

    @kotlin.jvm.JvmStatic
    fun createEnumValuesMethod(enumClass: ClassDescriptor): SimpleFunctionDescriptor {
        val values = SimpleFunctionDescriptorImpl.create(enumClass, Annotations.EMPTY, ENUM_VALUES,
            CallableMemberDescriptor.Kind.SYNTHESIZED, enumClass.getSource())
        return values.initialize(null, null, emptyList(), emptyList(), emptyList(),
            enumClass.builtIns.getArrayType(Variance.INVARIANT, enumClass.getDefaultType()), Modality.FINAL, DescriptorVisibilities.PUBLIC)
    }
    @kotlin.jvm.JvmStatic
    fun createEnumValueOfMethod(enumClass: ClassDescriptor): SimpleFunctionDescriptor {
        val valueOf = SimpleFunctionDescriptorImpl.create(enumClass, Annotations.EMPTY, ENUM_VALUE_OF,
            CallableMemberDescriptor.Kind.SYNTHESIZED, enumClass.getSource())
        val parameterDescriptor = ValueParameterDescriptorImpl(valueOf, null, 0, Annotations.EMPTY, Name.identifier("value"),
            enumClass.builtIns.getStringType(), false, false, false, null, enumClass.getSource())
        return valueOf.initialize(null, null, emptyList(), emptyList(), listOf(parameterDescriptor),
            enumClass.getDefaultType(), Modality.FINAL, DescriptorVisibilities.PUBLIC)
    }
    @kotlin.jvm.JvmStatic
    fun createEnumEntriesProperty(enumClass: ClassDescriptor): PropertyDescriptor? {
        val module = DescriptorUtils.getContainingModule(enumClass)
        val enumEntriesClass = module.getStdlibClassFinder().findEnumEntriesClass(module) ?: return null
        val entries = PropertyDescriptorImpl.create(enumClass, Annotations.EMPTY, Modality.FINAL, DescriptorVisibilities.PUBLIC,
            false, ENUM_ENTRIES, CallableMemberDescriptor.Kind.SYNTHESIZED, enumClass.getSource(), false, false, false, false, false, false)
        val getter = PropertyGetterDescriptorImpl(entries, Annotations.EMPTY, Modality.FINAL, DescriptorVisibilities.PUBLIC,
            false, false, false, CallableMemberDescriptor.Kind.SYNTHESIZED, null, enumClass.getSource())
        entries.initialize(getter, null)
        entries.setType(KotlinTypeFactory.simpleType(TypeAttributes.Empty, enumEntriesClass.getTypeConstructor(),
            listOf(TypeProjectionImpl(enumClass.getDefaultType())), false), emptyList(), null, null, emptyList())
        getter.initialize(entries.getReturnType())
        return entries
    }

    @kotlin.jvm.JvmStatic
    fun isEnumValuesMethod(descriptor: FunctionDescriptor): Boolean = descriptor.getName() == ENUM_VALUES && isEnumSpecialMethod(descriptor)
    @kotlin.jvm.JvmStatic
    fun isEnumValueOfMethod(descriptor: FunctionDescriptor): Boolean = descriptor.getName() == ENUM_VALUE_OF && isEnumSpecialMethod(descriptor)
    private fun isEnumSpecialMethod(descriptor: FunctionDescriptor): Boolean =
        descriptor.getKind() == CallableMemberDescriptor.Kind.SYNTHESIZED && DescriptorUtils.isEnumClass(descriptor.getContainingDeclaration())

    @kotlin.jvm.JvmStatic
    fun createExtensionReceiverParameterForCallable(owner: CallableDescriptor, receiverParameterType: KotlinType?, annotations: Annotations): ReceiverParameterDescriptor? =
        receiverParameterType?.let { ReceiverParameterDescriptorImpl(owner, ExtensionReceiver(owner, it, null), annotations) }
    @kotlin.jvm.JvmStatic
    fun createContextReceiverParameterForCallable(owner: CallableDescriptor, receiverParameterType: KotlinType?, customLabelName: Name?,
        annotations: Annotations, index: Int): ReceiverParameterDescriptor? =
        receiverParameterType?.let { ReceiverParameterDescriptorImpl(owner, ContextReceiver(owner, it, customLabelName, null), annotations, NameUtils.contextReceiverName(index)) }
    @kotlin.jvm.JvmStatic
    fun createContextReceiverParameterForClass(owner: ClassDescriptor, receiverParameterType: KotlinType?, customLabelName: Name?,
        annotations: Annotations, index: Int): ReceiverParameterDescriptor? =
        receiverParameterType?.let { ReceiverParameterDescriptorImpl(owner, ContextClassReceiver(owner, it, customLabelName, null), annotations, NameUtils.contextReceiverName(index)) }
}
