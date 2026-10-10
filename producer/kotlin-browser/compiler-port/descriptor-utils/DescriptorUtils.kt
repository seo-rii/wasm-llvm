/*
 * Copyright 2010-2018 JetBrains s.r.o. and Kotlin Programming Language contributors.
 * Use of this source code is governed by the Apache 2.0 license that can be found in the license/LICENSE.txt file.
 */
package org.jetbrains.kotlin.resolve

import org.jetbrains.kotlin.builtins.KotlinBuiltIns
import org.jetbrains.kotlin.builtins.KotlinBuiltIns.isAny
import org.jetbrains.kotlin.builtins.UnsignedTypes
import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.Kind.*
import org.jetbrains.kotlin.descriptors.Modality.ABSTRACT
import org.jetbrains.kotlin.descriptors.annotations.Annotated
import org.jetbrains.kotlin.descriptors.annotations.AnnotationDescriptor
import org.jetbrains.kotlin.descriptors.impl.PackageFragmentDescriptorImpl
import org.jetbrains.kotlin.incremental.components.LookupLocation
import org.jetbrains.kotlin.incremental.components.NoLookupLocation
import org.jetbrains.kotlin.name.*
import org.jetbrains.kotlin.portable.assertions.compilerAssert as assert
import org.jetbrains.kotlin.resolve.constants.StringValue
import org.jetbrains.kotlin.resolve.descriptorUtil.builtIns
import org.jetbrains.kotlin.resolve.scopes.DescriptorKindFilter
import org.jetbrains.kotlin.resolve.scopes.MemberScope
import org.jetbrains.kotlin.types.KotlinType
import org.jetbrains.kotlin.types.TypeConstructor
import org.jetbrains.kotlin.types.TypeUtils
import org.jetbrains.kotlin.types.checker.KotlinTypeChecker
import org.jetbrains.kotlin.types.error.ErrorUtils
import org.jetbrains.kotlin.types.isError
import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic

/** All algorithms from the pinned DescriptorUtils.java, with an explicit common parent type boundary. */
class DescriptorUtils private constructor() {
    companion object {
        @JvmField
        val JVM_NAME: FqName = FqName("kotlin.jvm.JvmName")

        @JvmStatic
        fun getDispatchReceiverParameterIfNeeded(containingDeclaration: DeclarationDescriptor): ReceiverParameterDescriptor? =
            if (containingDeclaration is ClassDescriptor) containingDeclaration.thisAsReceiverParameter else null

        @JvmStatic
        fun isLocal(descriptor: DeclarationDescriptor): Boolean {
            var current: DeclarationDescriptor? = descriptor
            while (current != null) {
                if (isAnonymousObject(current) || isDescriptorWithLocalVisibility(current)) return true
                current = current.containingDeclaration
            }
            return false
        }

        @JvmStatic
        fun isDescriptorWithLocalVisibility(current: DeclarationDescriptor?): Boolean =
            current is DeclarationDescriptorWithVisibility && current.visibility === DescriptorVisibilities.LOCAL

        @JvmStatic
        fun getFqName(descriptor: DeclarationDescriptor): FqNameUnsafe =
            getFqNameSafeIfPossible(descriptor)?.toUnsafe() ?: getFqNameUnsafe(descriptor)

        @JvmStatic
        fun getFqNameSafe(descriptor: DeclarationDescriptor): FqName =
            getFqNameSafeIfPossible(descriptor) ?: getFqNameUnsafe(descriptor).toSafe()

        private fun getFqNameSafeIfPossible(descriptor: DeclarationDescriptor): FqName? {
            if (descriptor is ModuleDescriptor || ErrorUtils.isError(descriptor)) return FqName.ROOT
            if (descriptor is PackageViewDescriptor) return descriptor.fqName
            if (descriptor is PackageFragmentDescriptor) return descriptor.fqName
            return null
        }

        private fun getFqNameUnsafe(descriptor: DeclarationDescriptor): FqNameUnsafe {
            val containingDeclaration = descriptor.containingDeclaration
            assert(containingDeclaration != null) { "Not package/module descriptor doesn't have containing declaration: " + descriptor }
            return getFqName(containingDeclaration!!).child(descriptor.name)
        }

        @JvmStatic
        fun getFqNameFromTopLevelClass(descriptor: DeclarationDescriptor): FqName {
            val containingDeclaration = descriptor.containingDeclaration
            val name = descriptor.name
            if (containingDeclaration !is ClassDescriptor) return FqName.topLevel(name)
            return getFqNameFromTopLevelClass(containingDeclaration).child(name)
        }

        @JvmStatic
        fun getClassIdForNonLocalClass(descriptor: DeclarationDescriptor): ClassId {
            val containingDeclaration = descriptor.containingDeclaration
            val name = descriptor.name
            if (containingDeclaration is PackageFragmentDescriptorImpl) return ClassId(containingDeclaration.fqName, name)
            if (containingDeclaration !is ClassDescriptor) return ClassId(FqName.ROOT, name)
            return getClassIdForNonLocalClass(containingDeclaration).createNestedClassId(name)
        }

        @JvmStatic
        fun isTopLevelDeclaration(descriptor: DeclarationDescriptor?): Boolean =
            descriptor != null && descriptor.containingDeclaration is PackageFragmentDescriptor
        @JvmStatic
        fun isExtension(descriptor: CallableDescriptor): Boolean = descriptor.extensionReceiverParameter != null
        @JvmStatic
        fun isOverride(descriptor: CallableMemberDescriptor): Boolean = descriptor.overriddenDescriptors.isNotEmpty()
        @JvmStatic
        fun isStaticDeclaration(descriptor: CallableDescriptor): Boolean {
            if (descriptor is ConstructorDescriptor) return false
            val container = descriptor.containingDeclaration
            return container is PackageFragmentDescriptor || container is ClassDescriptor && descriptor.dispatchReceiverParameter == null
        }
        @JvmStatic
        fun areInSameModule(first: DeclarationDescriptor, second: DeclarationDescriptor): Boolean =
            getContainingModule(first) == getContainingModule(second)

        @JvmStatic
        fun <D : DeclarationDescriptor> getParentOfType(descriptor: DeclarationDescriptor?, type: DescriptorType<D>): D? =
            getParentOfType(descriptor, type, true)

        @JvmStatic
        fun <D : DeclarationDescriptor> getParentOfType(descriptor: DeclarationDescriptor?, type: DescriptorType<D>, strict: Boolean): D? {
            if (descriptor == null) return null
            var current = if (strict) descriptor.containingDeclaration else descriptor
            while (current != null) {
                val matched = type.castOrNull(current)
                if (matched != null) return matched
                current = current.containingDeclaration
            }
            return null
        }

        // JVM_CLASS_PARENT_ADAPTER

        @JvmStatic
        fun getContainingModuleOrNull(kotlinType: KotlinType): ModuleDescriptor? {
            val descriptor = kotlinType.constructor.declarationDescriptor ?: return null
            return getContainingModuleOrNull(descriptor)
        }
        @JvmStatic
        fun getContainingModule(descriptor: DeclarationDescriptor): ModuleDescriptor {
            val module = getContainingModuleOrNull(descriptor)
            assert(module != null) { "Descriptor without a containing module: " + descriptor }
            return module!!
        }
        @JvmStatic
        fun getContainingModuleOrNull(descriptor: DeclarationDescriptor): ModuleDescriptor? {
            var current: DeclarationDescriptor? = descriptor
            while (current != null) {
                if (current is ModuleDescriptor) return current
                if (current is PackageViewDescriptor) return current.module
                current = current.containingDeclaration
            }
            return null
        }
        @JvmStatic
        fun getContainingClass(descriptor: DeclarationDescriptor): ClassDescriptor? {
            var containing = descriptor.containingDeclaration
            while (containing != null) {
                if (containing is ClassDescriptor && !isCompanionObject(containing)) return containing
                containing = containing.containingDeclaration
            }
            return null
        }
        @JvmStatic
        fun isAncestor(ancestor: DeclarationDescriptor?, declarationDescriptor: DeclarationDescriptor, strict: Boolean): Boolean {
            if (ancestor == null) return false
            var descriptor = if (strict) declarationDescriptor.containingDeclaration else declarationDescriptor
            while (descriptor != null) {
                if (ancestor === descriptor) return true
                descriptor = descriptor.containingDeclaration
            }
            return false
        }

        @JvmStatic
        fun isDirectSubclass(subClass: ClassDescriptor, superClass: ClassDescriptor): Boolean {
            for (superType in subClass.typeConstructor.supertypes) {
                if (isSameClass(superType, superClass.original)) return true
            }
            return false
        }
        @JvmStatic
        fun isSubclass(subClass: ClassDescriptor, superClass: ClassDescriptor): Boolean =
            isSubtypeOfClass(subClass.defaultType, superClass.original)
        private fun isSameClass(type: KotlinType, other: DeclarationDescriptor): Boolean {
            val descriptor = type.constructor.declarationDescriptor
            if (descriptor != null) {
                val originalDescriptor = descriptor.original
                if (originalDescriptor is ClassifierDescriptor && other is ClassifierDescriptor &&
                    other.typeConstructor == originalDescriptor.typeConstructor) return true
            }
            return false
        }
        @JvmStatic
        fun isSubtypeOfClass(type: KotlinType, superClass: DeclarationDescriptor): Boolean {
            if (isSameClass(type, superClass)) return true
            for (superType in type.constructor.supertypes) {
                if (isSubtypeOfClass(superType, superClass)) return true
            }
            return false
        }

        @JvmStatic
        fun isCompanionObject(descriptor: DeclarationDescriptor?): Boolean =
            isKindOf(descriptor, ClassKind.OBJECT) && (descriptor as ClassDescriptor).isCompanionObject
        @JvmStatic
        fun isSealedClass(descriptor: DeclarationDescriptor?): Boolean =
            (isKindOf(descriptor, ClassKind.CLASS) || isKindOf(descriptor, ClassKind.INTERFACE)) && (descriptor as ClassDescriptor).modality == Modality.SEALED
        @JvmStatic
        fun isAnonymousObject(descriptor: DeclarationDescriptor): Boolean = isClass(descriptor) && descriptor.name == SpecialNames.NO_NAME_PROVIDED
        @JvmStatic
        fun isAnonymousFunction(descriptor: DeclarationDescriptor): Boolean = descriptor is SimpleFunctionDescriptor && descriptor.name == SpecialNames.ANONYMOUS
        @JvmStatic
        fun isNonCompanionObject(descriptor: DeclarationDescriptor?): Boolean =
            isKindOf(descriptor, ClassKind.OBJECT) && !(descriptor as ClassDescriptor).isCompanionObject
        @JvmStatic
        fun isObject(descriptor: DeclarationDescriptor?): Boolean = isKindOf(descriptor, ClassKind.OBJECT)
        @JvmStatic
        fun isEnumEntry(descriptor: DeclarationDescriptor): Boolean = isKindOf(descriptor, ClassKind.ENUM_ENTRY)
        @JvmStatic
        fun isEnumClass(descriptor: DeclarationDescriptor?): Boolean = isKindOf(descriptor, ClassKind.ENUM_CLASS)
        @JvmStatic
        fun isAnnotationClass(descriptor: DeclarationDescriptor?): Boolean = isKindOf(descriptor, ClassKind.ANNOTATION_CLASS)
        @JvmStatic
        fun isInterface(descriptor: DeclarationDescriptor?): Boolean = isKindOf(descriptor, ClassKind.INTERFACE)
        @JvmStatic
        fun isClass(descriptor: DeclarationDescriptor?): Boolean = isKindOf(descriptor, ClassKind.CLASS)
        @JvmStatic
        fun isClassOrEnumClass(descriptor: DeclarationDescriptor?): Boolean = isClass(descriptor) || isEnumClass(descriptor)
        private fun isKindOf(descriptor: DeclarationDescriptor?, classKind: ClassKind): Boolean = descriptor is ClassDescriptor && descriptor.kind == classKind

        @JvmStatic
        fun hasAbstractMembers(classDescriptor: ClassDescriptor): Boolean {
            for (member in getAllDescriptors(classDescriptor.defaultType.memberScope)) {
                if (member is CallableMemberDescriptor && member.modality == ABSTRACT) return true
            }
            return false
        }
        @JvmStatic
        fun getSuperclassDescriptors(classDescriptor: ClassDescriptor): List<ClassDescriptor> {
            val result = mutableListOf<ClassDescriptor>()
            for (type in classDescriptor.typeConstructor.supertypes) {
                val descriptor = getClassDescriptorForType(type)
                if (!isAny(descriptor)) result.add(descriptor)
            }
            return result
        }
        @JvmStatic
        fun getSuperClassType(classDescriptor: ClassDescriptor): KotlinType {
            for (type in classDescriptor.typeConstructor.supertypes) {
                val descriptor = getClassDescriptorForType(type)
                if (descriptor.kind != ClassKind.INTERFACE) return type
            }
            return classDescriptor.builtIns.anyType
        }
        @JvmStatic
        fun getSuperClassDescriptor(classDescriptor: ClassDescriptor): ClassDescriptor? {
            for (type in classDescriptor.typeConstructor.supertypes) {
                val descriptor = getClassDescriptorForType(type)
                if (descriptor.kind != ClassKind.INTERFACE) return descriptor
            }
            return null
        }
        @JvmStatic
        fun getClassDescriptorForType(type: KotlinType): ClassDescriptor = getClassDescriptorForTypeConstructor(type.constructor)
        @JvmStatic
        fun getClassDescriptorForTypeConstructor(typeConstructor: TypeConstructor): ClassDescriptor {
            val descriptor = typeConstructor.declarationDescriptor
            assert(descriptor is ClassDescriptor) { "Classifier descriptor of a type should be of type ClassDescriptor: " + typeConstructor }
            return descriptor as ClassDescriptor
        }
        @JvmStatic
        fun getDefaultConstructorVisibility(classDescriptor: ClassDescriptor, freedomForSealedInterfacesSupported: Boolean): DescriptorVisibility {
            val classKind = classDescriptor.kind
            if (classKind == ClassKind.ENUM_CLASS || classKind.isSingleton) return DescriptorVisibilities.PRIVATE
            if (isSealedClass(classDescriptor)) {
                return if (freedomForSealedInterfacesSupported) DescriptorVisibilities.PROTECTED else DescriptorVisibilities.PRIVATE
            }
            if (isAnonymousObject(classDescriptor)) return DescriptorVisibilities.DEFAULT_VISIBILITY
            assert(classKind == ClassKind.CLASS || classKind == ClassKind.INTERFACE || classKind == ClassKind.ANNOTATION_CLASS)
            return DescriptorVisibilities.PUBLIC
        }
        @JvmStatic
        fun getInnerClassByName(classDescriptor: ClassDescriptor, innerClassName: String, location: LookupLocation): ClassDescriptor? {
            val classifier = classDescriptor.defaultType.memberScope.getContributedClassifier(Name.identifier(innerClassName), location)
            assert(classifier is ClassDescriptor) {
                "Inner class " + innerClassName + " in " + classDescriptor + " should be instance of ClassDescriptor, but was: " +
                    (classifier?.let { it::class } ?: "null")
            }
            return classifier as ClassDescriptor?
        }
        @JvmStatic
        fun getReceiverParameterType(receiverParameterDescriptor: ReceiverParameterDescriptor?): KotlinType? = receiverParameterDescriptor?.type
        @JvmStatic
        fun isStaticNestedClass(descriptor: DeclarationDescriptor): Boolean =
            descriptor is ClassDescriptor && descriptor.containingDeclaration is ClassDescriptor && !descriptor.isInner

        @JvmStatic
        @Suppress("UNCHECKED_CAST")
        fun <D : CallableMemberDescriptor> unwrapFakeOverride(descriptor: D): D {
            var current = descriptor
            while (current.kind == CallableMemberDescriptor.Kind.FAKE_OVERRIDE) {
                val overridden = current.overriddenDescriptors
                if (overridden.isEmpty()) throw IllegalStateException("Fake override should have at least one overridden descriptor: " + current)
                current = overridden.iterator().next() as D
            }
            return current
        }
        @JvmStatic
        @Suppress("UNCHECKED_CAST")
        fun <D : CallableMemberDescriptor> unwrapSubstitutionOverride(descriptor: D): D {
            var current = descriptor
            while (current.kind == CallableMemberDescriptor.Kind.FAKE_OVERRIDE) {
                val overridden = current.overriddenDescriptors
                if (overridden.isEmpty()) throw IllegalStateException("Fake override should have at least one overridden descriptor: " + current)
                if (overridden.size > 1) return current
                current = overridden.iterator().next() as D
            }
            return current
        }
        @JvmStatic
        @Suppress("UNCHECKED_CAST")
        fun <D : DeclarationDescriptorWithVisibility> unwrapFakeOverrideToAnyDeclaration(descriptor: D): D =
            if (descriptor is CallableMemberDescriptor) unwrapFakeOverride(descriptor) as D else descriptor

        @JvmStatic
        fun shouldRecordInitializerForProperty(variable: VariableDescriptor, type: KotlinType): Boolean {
            if (variable.isVar || type.isError) return false
            if (TypeUtils.acceptsNullable(type)) return true
            val builtIns = variable.builtIns
            return KotlinBuiltIns.isPrimitiveType(type) || KotlinTypeChecker.DEFAULT.equalTypes(builtIns.stringType, type) ||
                KotlinTypeChecker.DEFAULT.equalTypes(builtIns.number.defaultType, type) ||
                KotlinTypeChecker.DEFAULT.equalTypes(builtIns.anyType, type) || UnsignedTypes.isUnsignedType(type)
        }
        @JvmStatic
        fun classCanHaveAbstractFakeOverride(classDescriptor: ClassDescriptor): Boolean = classCanHaveAbstractDeclaration(classDescriptor) || classDescriptor.isExpect
        @JvmStatic
        fun classCanHaveAbstractDeclaration(classDescriptor: ClassDescriptor): Boolean =
            classDescriptor.modality == Modality.ABSTRACT || isSealedClass(classDescriptor) || classDescriptor.kind == ClassKind.ENUM_CLASS
        @JvmStatic
        fun classCanHaveOpenMembers(classDescriptor: ClassDescriptor): Boolean = classDescriptor.modality != Modality.FINAL || classDescriptor.kind == ClassKind.ENUM_CLASS

        @JvmStatic
        @Suppress("UNCHECKED_CAST")
        fun <D : CallableDescriptor> getAllOverriddenDescriptors(f: D): Set<D> {
            val result = linkedSetOf<D>()
            collectAllOverriddenDescriptors(f.original as D, result)
            return result
        }
        @Suppress("UNCHECKED_CAST")
        private fun <D : CallableDescriptor> collectAllOverriddenDescriptors(current: D, result: MutableSet<D>) {
            if (result.contains(current)) return
            for (callableDescriptor in current.original.overriddenDescriptors) {
                val descriptor = callableDescriptor.original as D
                collectAllOverriddenDescriptors(descriptor, result)
                result.add(descriptor)
            }
        }
        @JvmStatic
        @Suppress("UNCHECKED_CAST")
        fun <D : CallableMemberDescriptor> getAllOverriddenDeclarations(memberDescriptor: D): Set<D> {
            val result = hashSetOf<D>()
            for (overriddenDeclaration in memberDescriptor.overriddenDescriptors) {
                when (val kind = overriddenDeclaration.kind) {
                    DECLARATION -> result.add(overriddenDeclaration as D)
                    DELEGATION, FAKE_OVERRIDE, SYNTHESIZED -> Unit
                    else -> throw AssertionError("Unexpected callable kind " + kind)
                }
                result.addAll(getAllOverriddenDeclarations(overriddenDeclaration as D))
            }
            return result
        }
        @JvmStatic
        fun isSingletonOrAnonymousObject(classDescriptor: ClassDescriptor): Boolean = classDescriptor.kind.isSingleton || isAnonymousObject(classDescriptor)
        @JvmStatic
        fun canHaveDeclaredConstructors(classDescriptor: ClassDescriptor): Boolean = !isSingletonOrAnonymousObject(classDescriptor) && !isInterface(classDescriptor)
        @JvmStatic
        fun getJvmName(annotated: Annotated): String? = getJvmName(findJvmNameAnnotation(annotated))
        private fun getJvmName(jvmNameAnnotation: AnnotationDescriptor?): String? {
            if (jvmNameAnnotation == null) return null
            val arguments = jvmNameAnnotation.allValueArguments
            if (arguments.isEmpty()) return null
            val name = arguments.values.iterator().next()
            if (name !is StringValue) return null
            return name.value
        }
        @JvmStatic
        fun findJvmNameAnnotation(annotated: Annotated): AnnotationDescriptor? = annotated.annotations.findAnnotation(JVM_NAME)
        @JvmStatic
        fun hasJvmNameAnnotation(annotated: Annotated): Boolean = findJvmNameAnnotation(annotated) != null
        @JvmStatic
        fun getContainingSourceFile(descriptor: DeclarationDescriptor): SourceFile {
            val actual = if (descriptor is PropertySetterDescriptor) descriptor.correspondingProperty else descriptor
            if (actual is DeclarationDescriptorWithSource) return actual.source.containingFile
            return SourceFile.NO_SOURCE_FILE
        }
        @JvmStatic
        fun getAllDescriptors(scope: MemberScope): Collection<DeclarationDescriptor> = scope.getContributedDescriptors(DescriptorKindFilter.ALL, MemberScope.ALL_NAME_FILTER)
        @JvmStatic
        fun getFunctionByName(scope: MemberScope, name: Name): FunctionDescriptor =
            getFunctionByNameOrNull(scope, name) ?: throw IllegalStateException("Function not found")
        @JvmStatic
        fun getFunctionByNameOrNull(scope: MemberScope, name: Name): FunctionDescriptor? {
            for (descriptor in scope.getContributedFunctions(name, NoLookupLocation.FROM_BACKEND)) {
                if (name == descriptor.original.name) return descriptor
            }
            return null
        }
        @JvmStatic
        fun getPropertyByName(scope: MemberScope, name: Name): PropertyDescriptor {
            for (descriptor in scope.getContributedVariables(name, NoLookupLocation.FROM_BACKEND)) {
                if (name == descriptor.original.name) return descriptor
            }
            throw IllegalStateException("Property not found")
        }
        @JvmStatic
        fun getDirectMember(descriptor: CallableMemberDescriptor): CallableMemberDescriptor =
            if (descriptor is PropertyAccessorDescriptor) descriptor.correspondingProperty else descriptor
    }
}
