/* Test fixture: genuine compiler descriptors and real .kotlin_builtins deserialization only. */
package org.jetbrains.kotlin.portable.builtins.probe

import org.jetbrains.kotlin.builtins.*
import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.descriptors.impl.ModuleDescriptorImpl
import org.jetbrains.kotlin.name.FqName
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.resolve.DescriptorUtils
import org.jetbrains.kotlin.resolve.descriptorUtil.classId
import org.jetbrains.kotlin.resolve.scopes.MemberScope
import org.jetbrains.kotlin.serialization.deserialization.builtins.BuiltInsLoaderImpl
import org.jetbrains.kotlin.storage.LockBasedStorageManager
import org.jetbrains.kotlin.types.*

private class InspectableBuiltIns : KotlinBuiltIns(LockBasedStorageManager("builtins-source-probe")) {
    fun initialize(fallback: Boolean) = createBuiltInsModule(fallback)
    fun inspectHooks(): String =
        "${getAdditionalClassPartsProvider()::class.java.name}|${getPlatformDependentDeclarationFilter()::class.java.name}|" +
            "${getClassDescriptorFactories().map { it::class.java.name }}|${getStorageManager()::class.java.name}"
}

private fun observation(name: String, action: () -> Any?) {
    val value = try { render(action()) } catch (error: Throwable) {
        val actual = if (error is java.lang.reflect.InvocationTargetException) error.targetException else error
        "throw:${actual::class.java.name}:${actual.message?.replace(Regex("@[0-9a-fA-F]+"), "@<identity>")}"
    }
    println("$name\t$value")
}

private fun render(value: Any?): String = when (value) {
    null -> "null"
    is ClassDescriptor -> DescriptorUtils.getFqName(value).asString()
    is KotlinType -> value.toString()
    is ModuleDescriptor -> value.name.asString()
    is PackageViewDescriptor -> value.fqName.asString()
    is Collection<*> -> value.map { render(it) }.joinToString(prefix = "[", postfix = "]")
    is MemberScope -> value::class.java.name
    else -> value.toString()
}

fun main() {
    // Only the explicit portable host registration differs. The factory returns
    // the genuine compiler BuiltInsLoaderImpl, retaining actual resource decoding.
    val register = BuiltInsLoader.Companion::class.java.methods.singleOrNull { it.name == "registerFactory" }
    if (register != null) register.invoke(BuiltInsLoader.Companion, { BuiltInsLoaderImpl() })

    val builtIns = DefaultBuiltIns()
    observation("module-name") { builtIns.builtInsModule.name.asString() }
    observation("default-packages") { builtIns.builtInPackagesImportedByDefault }
    observation("own-module-dependency") { builtIns.builtInsModule.allDependencyModules.any { it === builtIns.builtInsModule } }
    observation("actual-metadata-fallback") {
        builtIns.builtInsModule.getPackage(FqName("kotlin")).fragments.filterIsInstance<BuiltInsPackageFragment>().map { it.isFallback }
    }

    val getters = KotlinBuiltIns::class.java.declaredMethods.filter {
        java.lang.reflect.Modifier.isPublic(it.modifiers) && !java.lang.reflect.Modifier.isStatic(it.modifiers) &&
            it.name.startsWith("get") && !it.name.endsWith("Property") && it.parameterCount == 0
    }.sortedBy { it.name }
    for (getter in getters) observation("getter-${getter.name}") { getter.invoke(builtIns) }
    observation("class-memo-identity") { builtIns.getAny() === builtIns.getAny() && builtIns.getInt() === builtIns.getInt() }
    observation("primitive-map-identity") {
        PrimitiveType.values().all { builtIns.getPrimitiveArrayKotlinType(it) === builtIns.getPrimitiveArrayKotlinType(it) }
    }

    val types = mutableListOf<Pair<String, KotlinType>>()
    for (primitive in PrimitiveType.values()) {
        val type = builtIns.getPrimitiveKotlinType(primitive)
        val array = builtIns.getPrimitiveArrayKotlinType(primitive)
        types += primitive.name to type
        types += "${primitive.name}?" to type.makeNullableAsSpecified(true)
        types += "${primitive.name}-array" to array
        types += "${primitive.name}-array?" to array.makeNullableAsSpecified(true)
        observation("primitive-class-${primitive.name}") { builtIns.getPrimitiveArrayClassDescriptor(primitive) }
        observation("primitive-reverse-${primitive.name}") { builtIns.getPrimitiveArrayKotlinTypeByPrimitiveKotlinType(type) }
    }
    for (getter in getters) {
        val value = getter.invoke(builtIns)
        if (value is KotlinType) types += getter.name to value
        if (value is ClassDescriptor) {
            types += "${getter.name}-default" to value.defaultType
            types += "${getter.name}-nullable" to value.defaultType.makeNullableAsSpecified(true)
        }
    }
    for (name in listOf("UByte", "UShort", "UInt", "ULong", "UByteArray", "UShortArray", "UIntArray", "ULongArray")) {
        var descriptor: ClassDescriptor? = null
        observation("unsigned-resource-$name") {
            builtIns.getBuiltInClassByFqName(FqName("kotlin.$name")).also { descriptor = it }
        }
        descriptor?.let {
            types += name to it.defaultType
            types += "$name?" to it.defaultType.makeNullableAsSpecified(true)
        }
    }
    for (unsigned in UnsignedType.values()) {
        observation("unsigned-name-${unsigned.name}") { UnsignedTypes.isShortNameOfUnsignedType(unsigned.typeName) }
        observation("unsigned-array-name-${unsigned.name}") { UnsignedTypes.isShortNameOfUnsignedArray(unsigned.arrayClassId.shortClassName) }
        observation("unsigned-array-map-${unsigned.name}") { UnsignedTypes.getUnsignedArrayClassIdByUnsignedClassId(unsigned.classId) }
        observation("unsigned-element-map-${unsigned.name}") { UnsignedTypes.getUnsignedClassIdByArrayClassId(unsigned.arrayClassId) }
    }
    for (variance in Variance.values()) {
        val array = builtIns.getArrayType(variance, builtIns.intType)
        types += "array-$variance" to array
        observation("array-annotations-$variance") { builtIns.getArrayType(variance, builtIns.stringType, Annotations.EMPTY) }
    }
    types += "array-nullable-element" to builtIns.getArrayType(Variance.INVARIANT, builtIns.nullableAnyType)
    observation("enum-generic") { builtIns.getEnumType(builtIns.stringType) }

    val predicates = KotlinBuiltIns::class.java.declaredMethods.filter {
        java.lang.reflect.Modifier.isPublic(it.modifiers) && java.lang.reflect.Modifier.isStatic(it.modifiers) &&
            it.parameterCount == 1 && it.parameterTypes[0] == KotlinType::class.java
    }.sortedBy { it.name }
    val descriptorPredicates = KotlinBuiltIns::class.java.declaredMethods.filter {
        java.lang.reflect.Modifier.isPublic(it.modifiers) && java.lang.reflect.Modifier.isStatic(it.modifiers) &&
            it.parameterCount == 1 && it.parameterTypes[0] in listOf(ClassDescriptor::class.java, DeclarationDescriptor::class.java)
    }.sortedBy { it.name }
    for ([name, type] in types) {
        for (predicate in predicates) observation("predicate-$name-${predicate.name}") { predicate.invoke(null, type) }
        for (predicate in descriptorPredicates) observation("descriptor-$name-${predicate.name}") {
            predicate.invoke(null, type.constructor.declarationDescriptor)
        }
        observation("element-$name") { builtIns.getArrayElementTypeOrNull(type) }
        observation("element-required-$name") { builtIns.getArrayElementType(type) }
        observation("array-from-element-$name") { builtIns.getPrimitiveArrayKotlinTypeByPrimitiveKotlinType(type) }
        observation("subtype-boolean-$name") { builtIns.isBooleanOrSubtype(type) }
        observation("constructor-int-$name") { KotlinBuiltIns.isTypeConstructorForGivenClass(type.constructor, FqName("kotlin.Int").toUnsafe()) }
        observation("constructed-int-$name") { KotlinBuiltIns.isConstructedFromGivenClass(type, FqName("kotlin.Int")) }
    }
    for (arity in listOf(0, 1, 2, 22, 23, 64, 128)) {
        observation("function-$arity") { builtIns.getFunction(arity) }
        observation("suspend-function-$arity") { builtIns.getSuspendFunction(arity) }
        observation("k-function-$arity") { builtIns.getKFunction(arity) }
        observation("k-suspend-function-$arity") { builtIns.getKSuspendFunction(arity) }
    }
    observation("missing-fq-class") { builtIns.getBuiltInClassByFqName(FqName("kotlin.NotACompilerBuiltin")) }
    for (name in listOf("Any", "Nothing", "Int", "kotlin.Any")) observation("package-predicate-$name") {
        KotlinBuiltIns.isUnderKotlinPackage(builtIns.getBuiltInClassByFqName(FqName(if ('.' in name) name else "kotlin.$name")))
    }
    val anyFunctions = builtIns.any.unsubstitutedMemberScope.getContributedDescriptors().filterIsInstance<FunctionDescriptor>()
    for (function in anyFunctions.sortedBy { it.name.asString() }) {
        observation("member-of-any-${function.name}") { builtIns.isMemberOfAny(function) }
        observation("return-unit-${function.name}") { KotlinBuiltIns.mayReturnNonUnitValue(function) }
    }
    for (predicate in listOf("isCharSequence", "isString", "isUnsignedNumber", "isCharSequenceOrNullableCharSequence", "isStringOrNullableString")) {
        observation("nullable-argument-$predicate") { KotlinBuiltIns::class.java.getMethod(predicate, KotlinType::class.java).invoke(null, null) }
    }

    val inspectable = InspectableBuiltIns()
    observation("uninitialized-module") { inspectable.getBuiltInsModule() }
    observation("initialize-real-provider") { inspectable.initialize(false); inspectable.getBuiltInsModule() }
    observation("real-hooks") { inspectable.inspectHooks() }
    observation("real-loaded-class") { inspectable.getInt().classId?.asSingleFqName()?.asString() }
    observation("second-module-set") { inspectable.setBuiltInsModule(builtIns.builtInsModule) }
    val fallback = InspectableBuiltIns()
    observation("real-fallback-provider") {
        fallback.initialize(true)
        fallback.builtInsModule.getPackage(FqName("kotlin")).fragments.filterIsInstance<BuiltInsPackageFragment>().map { it.isFallback }
    }
    val external = InspectableBuiltIns()
    observation("external-real-module") { external.setBuiltInsModule(builtIns.builtInsModule); external.getString() }
    val postponed = InspectableBuiltIns()
    var evaluated = 0
    postponed.setPostponedBuiltinsModuleComputation { evaluated++; builtIns.builtInsModule }
    observation("postponed-before-read") { evaluated }
    observation("postponed-real-module") { postponed.getBuiltInsModule() === builtIns.builtInsModule }
    observation("postponed-evaluated-once") { postponed.getBuiltInsModule(); evaluated }
    val replaced = InspectableBuiltIns()
    replaced.setPostponedBuiltinsModuleComputation { error("replaced deferred computation should not run") }
    replaced.setPostponedBuiltinsModuleComputation { builtIns.builtInsModule }
    observation("postponed-replacement") { replaced.getInt() }
    val assigned = InspectableBuiltIns()
    assigned.setPostponedBuiltinsModuleComputation { error("external module must take precedence") }
    assigned.setBuiltInsModule(builtIns.builtInsModule)
    observation("external-takes-precedence") { assigned.getBoolean() }
}
