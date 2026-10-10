/* Genuine compiler metadata descriptors only; this fixture creates no replacement descriptor implementations. */
package org.jetbrains.kotlin.portable.descriptorutils.probe

import org.jetbrains.kotlin.builtins.DefaultBuiltIns
import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.incremental.components.NoLookupLocation
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.renderer.DescriptorRenderer
import org.jetbrains.kotlin.resolve.DescriptorUtils
import org.jetbrains.kotlin.resolve.scopes.MemberScope
import org.jetbrains.kotlin.types.KotlinType
import org.jetbrains.kotlin.types.TypeConstructor

private fun render(value: Any?, unordered: Boolean = false): String = when (value) {
    null -> "null"
    is ModuleDescriptor -> value.name.asString()
    is PackageViewDescriptor -> value.fqName.asString()
    is PackageFragmentDescriptor -> value.fqName.asString()
    is DeclarationDescriptor -> DescriptorRenderer.FQ_NAMES_IN_TYPES.render(value)
    is KotlinType -> value.toString()
    is TypeConstructor -> value.toString()
    is SourceFile -> value.name ?: "<no source>"
    is Collection<*> -> value.map { render(it) }.let { if (unordered) it.sorted() else it }.joinToString(prefix = "[", postfix = "]")
    else -> value.toString()
}

private fun observe(name: String, unordered: Boolean = false, action: () -> Any?) {
    val result = try { render(action(), unordered) } catch (error: Throwable) {
        val actual = if (error is java.lang.reflect.InvocationTargetException) error.targetException else error
        "throw:${actual::class.java.name}:${actual.message?.replace(Regex("@[0-9a-fA-F]+"), "@<identity>")}"
    }
    println("$name\t$result")
}

fun main() {
    val builtIns = DefaultBuiltIns()
    val classes = listOf(builtIns.any, builtIns.nothing, builtIns.byte, builtIns.short, builtIns.int, builtIns.long,
        builtIns.float, builtIns.double, builtIns.char, builtIns.boolean, builtIns.array, builtIns.number, builtIns.unit,
        builtIns.throwable, builtIns.string, builtIns.charSequence, builtIns.comparable, builtIns.enum, builtIns.annotation,
        builtIns.kClass, builtIns.kType, builtIns.kCallable, builtIns.kProperty, builtIns.kProperty0, builtIns.kProperty1,
        builtIns.kProperty2, builtIns.kMutableProperty0, builtIns.kMutableProperty1, builtIns.kMutableProperty2,
        builtIns.iterator, builtIns.iterable, builtIns.mutableIterable, builtIns.collection, builtIns.mutableCollection,
        builtIns.list, builtIns.mutableList, builtIns.set, builtIns.mutableSet, builtIns.map, builtIns.mutableMap,
        builtIns.mapEntry, builtIns.mutableMapEntry, builtIns.listIterator, builtIns.mutableListIterator,
        builtIns.getFunction(2), builtIns.getSuspendFunction(2), builtIns.getKFunction(2))
    val descriptors = mutableListOf<DeclarationDescriptor>()
    descriptors += builtIns.builtInsModule
    val packages = builtIns.builtInPackagesImportedByDefault
    descriptors += packages
    descriptors += packages.flatMap { it.fragments }
    for (descriptor in classes) {
        descriptors += descriptor
        descriptors += descriptor.declaredTypeParameters
        descriptors += descriptor.constructors
        val members = DescriptorUtils.getAllDescriptors(descriptor.defaultType.memberScope)
            .sortedBy { DescriptorRenderer.FQ_NAMES_IN_TYPES.render(it) }
        descriptors += members
        descriptors += members.filterIsInstance<PropertyDescriptor>().flatMap { listOfNotNull(it.getter, it.setter) }
    }
    val methods = DescriptorUtils::class.java.declaredMethods.filter {
        java.lang.reflect.Modifier.isPublic(it.modifiers) && java.lang.reflect.Modifier.isStatic(it.modifiers) && it.parameterCount == 1 &&
            DeclarationDescriptor::class.java.isAssignableFrom(it.parameterTypes[0])
    }.sortedBy { it.name + it.parameterTypes[0].name }
    for ([index, descriptor] in descriptors.withIndex()) {
        for (method in methods) if (method.parameterTypes[0].isInstance(descriptor)) {
            observe("descriptor-$index-${method.name}", unordered = method.name == "getAllOverriddenDeclarations") { method.invoke(null, descriptor) }
        }
        for (strict in listOf(false, true)) {
            observe("parent-class-$index-$strict") { DescriptorUtils.getParentOfType(descriptor, ClassDescriptor::class.java, strict) }
            observe("parent-visible-$index-$strict") { DescriptorUtils.getParentOfType(descriptor, DeclarationDescriptorWithVisibility::class.java, strict) }
            observe("parent-package-$index-$strict") { DescriptorUtils.getParentOfType(descriptor, PackageFragmentDescriptor::class.java, strict) }
        }
        observe("parent-default-$index") { DescriptorUtils.getParentOfType(descriptor, ClassDescriptor::class.java) }
        observe("same-module-$index") { DescriptorUtils.areInSameModule(descriptor, builtIns.builtInsModule) }
        observe("ancestor-module-$index") { DescriptorUtils.isAncestor(builtIns.builtInsModule, descriptor, false) }
        observe("ancestor-self-$index") { DescriptorUtils.isAncestor(descriptor, descriptor, false) }
        observe("ancestor-self-strict-$index") { DescriptorUtils.isAncestor(descriptor, descriptor, true) }
        observe("ancestor-null-$index") { DescriptorUtils.isAncestor(null, descriptor, false) }
        observe("jvm-name-$index") { DescriptorUtils.getJvmName(descriptor) }
        observe("has-jvm-name-$index") { DescriptorUtils.hasJvmNameAnnotation(descriptor) }
        observe("jvm-name-annotation-$index") { DescriptorUtils.findJvmNameAnnotation(descriptor) }
        if (descriptor is VariableDescriptor) {
            for (type in listOf(builtIns.intType, builtIns.stringType, builtIns.numberType, builtIns.anyType, builtIns.nullableAnyType,
                builtIns.getArrayType(org.jetbrains.kotlin.types.Variance.INVARIANT, builtIns.intType))) {
                observe("initializer-$index-$type") { DescriptorUtils.shouldRecordInitializerForProperty(descriptor, type) }
            }
        }
    }
    for ([index, descriptor] in classes.withIndex()) {
        for ([otherIndex, other] in classes.withIndex()) {
            observe("direct-subclass-$index-$otherIndex") { DescriptorUtils.isDirectSubclass(descriptor, other) }
            observe("subclass-$index-$otherIndex") { DescriptorUtils.isSubclass(descriptor, other) }
            observe("subtype-$index-$otherIndex") { DescriptorUtils.isSubtypeOfClass(descriptor.defaultType, other) }
        }
        for (supported in listOf(false, true)) observe("constructor-visibility-$index-$supported") {
            DescriptorUtils.getDefaultConstructorVisibility(descriptor, supported)
        }
        observe("type-class-$index") { DescriptorUtils.getClassDescriptorForType(descriptor.defaultType) }
        observe("type-constructor-class-$index") { DescriptorUtils.getClassDescriptorForTypeConstructor(descriptor.typeConstructor) }
        observe("type-module-$index") { DescriptorUtils.getContainingModuleOrNull(descriptor.defaultType) }
        observe("receiver-type-$index") { DescriptorUtils.getReceiverParameterType(descriptor.thisAsReceiverParameter) }
        observe("scope-missing-function-$index") { DescriptorUtils.getFunctionByNameOrNull(descriptor.defaultType.memberScope, Name.identifier("notACompilerMember")) }
        observe("scope-required-missing-function-$index") { DescriptorUtils.getFunctionByName(descriptor.defaultType.memberScope, Name.identifier("notACompilerMember")) }
        observe("scope-required-missing-property-$index") { DescriptorUtils.getPropertyByName(descriptor.defaultType.memberScope, Name.identifier("notACompilerMember")) }
    }
    observe("inner-map-entry") { DescriptorUtils.getInnerClassByName(builtIns.map, "Entry", NoLookupLocation.FROM_BUILTINS) }
    observe("inner-missing-class") { DescriptorUtils.getInnerClassByName(builtIns.map, "MissingEntry", NoLookupLocation.FROM_BUILTINS) }
    observe("scope-real-function") { DescriptorUtils.getFunctionByName(builtIns.any.defaultType.memberScope, Name.identifier("equals")) }
    observe("scope-real-property") { DescriptorUtils.getPropertyByName(builtIns.string.defaultType.memberScope, Name.identifier("length")) }
    observe("parent-null") { DescriptorUtils.getParentOfType(null, ClassDescriptor::class.java, false) }
    observe("receiver-null") { DescriptorUtils.getReceiverParameterType(null) }
    observe("local-null") { DescriptorUtils.isDescriptorWithLocalVisibility(null) }
    for (name in listOf("isTopLevelDeclaration", "isCompanionObject", "isSealedClass", "isNonCompanionObject", "isObject", "isEnumClass", "isAnnotationClass", "isInterface", "isClass", "isClassOrEnumClass")) {
        observe("nullable-$name") { DescriptorUtils::class.java.getMethod(name, DeclarationDescriptor::class.java).invoke(null, null) }
    }
    val members = descriptors.filterIsInstance<CallableMemberDescriptor>()
    observe("real-fake-override-count") { members.count { it.kind == CallableMemberDescriptor.Kind.FAKE_OVERRIDE } }
    observe("real-source-file-count") { descriptors.map { DescriptorUtils.getContainingSourceFile(it) }.count { it !== SourceFile.NO_SOURCE_FILE } }
}
