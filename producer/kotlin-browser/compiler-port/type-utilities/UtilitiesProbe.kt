package org.jetbrains.kotlin.portable.typeutilities.probe

import org.jetbrains.kotlin.builtins.DefaultBuiltIns
import org.jetbrains.kotlin.builtins.StandardNames
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.descriptors.impl.TypeParameterDescriptorImpl
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.renderer.DescriptorRenderer
import org.jetbrains.kotlin.resolve.constants.CompileTimeConstant
import org.jetbrains.kotlin.resolve.constants.IntegerLiteralTypeConstructor
import org.jetbrains.kotlin.resolve.constants.IntegerValueTypeConstructor
import org.jetbrains.kotlin.storage.LockBasedStorageManager
import org.jetbrains.kotlin.types.*
import org.jetbrains.kotlin.types.checker.KotlinTypeChecker
import org.jetbrains.kotlin.types.checker.KotlinTypeRefiner
import org.jetbrains.kotlin.types.checker.TypeCheckingProcedure
import org.jetbrains.kotlin.types.checker.TypeCheckingProcedureCallbacks
import org.jetbrains.kotlin.types.error.ErrorTypeKind
import org.jetbrains.kotlin.types.error.ErrorUtils

private val builtIns = DefaultBuiltIns.Instance
private val intType = builtIns.intType
private val longType = builtIns.longType
private val stringType = builtIns.stringType
private val tParameter = TypeParameterDescriptorImpl.createWithDefaultBound(builtIns.list, Annotations.EMPTY, false, Variance.INVARIANT, Name.identifier("T"), 0, LockBasedStorageManager("utilities-T"))
private val rParameter = TypeParameterDescriptorImpl.createWithDefaultBound(builtIns.list, Annotations.EMPTY, true, Variance.INVARIANT, Name.identifier("R"), 0, LockBasedStorageManager("utilities-R"))
private val t = tParameter.defaultType
private val renderer = DescriptorRenderer.FQ_NAMES_IN_TYPES
private fun text(type: KotlinType?): String = type?.let(renderer::renderType) ?: "null"
private fun generic(array: Boolean, projection: TypeProjection): SimpleType {
    val descriptor = if (array) builtIns.array else builtIns.list
    return KotlinTypeFactory.simpleType(TypeAttributes.Empty, descriptor.typeConstructor, listOf(projection), false)
}
private fun observation(id: String, body: () -> String) = println(id + "\t" + body())
private fun expectFailure(id: String, body: () -> Any?) {
    val failure = try { body(); null } catch (e: Throwable) { e }
    check(failure is IllegalStateException || failure is IllegalArgumentException)
    println(id + "\t" + failure.javaClass.name + ":" + failure.message)
}
// Real default callback object; reflection only crosses the original package-private Java visibility for observation.
private fun originalCallbacks(): TypeCheckingProcedureCallbacks {
    val constructor = Class.forName("org.jetbrains.kotlin.types.checker.TypeCheckerProcedureCallbacksImpl").getDeclaredConstructor()
    constructor.isAccessible = true
    return constructor.newInstance() as TypeCheckingProcedureCallbacks
}
// An actual documented callback contract client. These injected decisions are confined to the observer, never supplied to compiler C.
private class CallbackClient(private val allowCapture: Boolean, private val allowMissing: Boolean) : TypeCheckingProcedureCallbacks {
    var captures = 0
    var missing = 0
    override fun assertEqualTypes(a: KotlinType, b: KotlinType, typeCheckingProcedure: TypeCheckingProcedure): Boolean = typeCheckingProcedure.equalTypes(a, b)
    override fun assertEqualTypeConstructors(a: TypeConstructor, b: TypeConstructor): Boolean = a == b
    override fun assertSubtype(subtype: KotlinType, supertype: KotlinType, typeCheckingProcedure: TypeCheckingProcedure): Boolean = typeCheckingProcedure.isSubtypeOf(subtype, supertype)
    override fun capture(type: KotlinType, typeProjection: TypeProjection): Boolean { ++captures; return allowCapture }
    override fun noCorrespondingSupertype(subtype: KotlinType, supertype: KotlinType): Boolean { ++missing; return allowMissing }
}

@OptIn(TypeRefinement::class)
fun main() {
    observation("sentinel-identities") {
        check(TypeUtils.noExpectedType(TypeUtils.NO_EXPECTED_TYPE) && TypeUtils.noExpectedType(TypeUtils.UNIT_EXPECTED_TYPE))
        check(!TypeUtils.noExpectedType(TypeUtils.SpecialType("NO_EXPECTED_TYPE")))
        check(TypeUtils.isDontCarePlaceholder(TypeUtils.DONT_CARE) && !TypeUtils.isDontCarePlaceholder(null) && !TypeUtils.isDontCarePlaceholder(intType))
        TypeUtils.NO_EXPECTED_TYPE.toString() + ";" + TypeUtils.UNIT_EXPECTED_TYPE + ";" + text(TypeUtils.CANNOT_INFER_FUNCTION_PARAM_TYPE)
    }
    val special = TypeUtils.SpecialType("real-special-marker")
    observation("special-refine-identity") { check(special.refine(KotlinTypeRefiner.Default) === special); special.toString() }
    expectFailure("special-delegate") { special.constructor }
    expectFailure("special-replace-attributes") { special.replaceAttributes(TypeAttributes.Empty) }
    expectFailure("special-nullability") { special.makeNullableAsSpecified(true) }
    expectFailure("special-replace-delegate") { special.replaceDelegate(intType) }
    observation("nullability-helpers") {
        check(TypeUtils.makeNullableIfNeeded(intType, false) === intType)
        val general: KotlinType = intType
        check(TypeUtils.makeNullableIfNeeded(general, false) === general)
        val nullable = TypeUtils.makeNullable(intType)
        check(nullable.isMarkedNullable && !TypeUtils.makeNotNullable(nullable).isMarkedNullable)
        check(TypeUtils.makeNullableAsSpecified(intType, true).isMarkedNullable)
        text(nullable)
    }
    val nullableT = t.makeNullableAsSpecified(true)
    val flexible = KotlinTypeFactory.flexibleType(intType, intType.makeNullableAsSpecified(true))
    val definitely = DefinitelyNotNullType.makeDefinitelyNotNull(nullableT, avoidCheckingActualTypeNullability = true)!!
    for ([id, type] in listOf("int" to intType, "nullable-int" to intType.makeNullableAsSpecified(true), "parameter" to t, "nullable-parameter" to nullableT,
      "flexible" to flexible, "definitely" to definitely, "any" to builtIns.anyType, "nullable-any" to builtIns.nullableAnyType,
      "list" to generic(false, TypeProjectionImpl(intType)), "star-list" to generic(false, StarProjectionImpl(builtIns.list.typeConstructor.parameters.single())))) {
        observation("type-flags-$id") { "nullable=${TypeUtils.isNullableType(type)};accepts=${TypeUtils.acceptsNullable(type)};super=${TypeUtils.hasNullableSuperType(type)};subtypes=${TypeUtils.canHaveSubtypes(KotlinTypeChecker.DEFAULT, type)};parameter=${TypeUtils.isTypeParameter(type)};class=${TypeUtils.getClassDescriptor(type)?.name}" }
    }
    observation("reified-classification") {
        check(TypeUtils.isNonReifiedTypeParameter(t) && !TypeUtils.isReifiedTypeParameter(t))
        check(TypeUtils.isReifiedTypeParameter(rParameter.defaultType) && !TypeUtils.isNonReifiedTypeParameter(rParameter.defaultType))
        check(TypeUtils.getTypeParameterDescriptorOrNull(t) === tParameter && TypeUtils.getTypeParameterDescriptorOrNull(intType) == null)
        "T=non-reified;R=reified;Int=none"
    }
    observation("default-projections") { TypeUtils.getDefaultTypeProjections(builtIns.map.typeConstructor.parameters).joinToString(",") { text(it.type) } }
    for (descriptor in listOf(builtIns.list, builtIns.array)) observation("default-factory-" + descriptor.name) {
        val byDescriptor = TypeUtils.makeUnsubstitutedType(descriptor, descriptor.unsubstitutedMemberScope) { null }
        val byConstructor = TypeUtils.makeUnsubstitutedType(descriptor.typeConstructor, descriptor.unsubstitutedMemberScope) { null }
        check(byDescriptor.constructor === descriptor.typeConstructor && byConstructor.constructor === descriptor.typeConstructor)
        check(byDescriptor.refine(KotlinTypeRefiner.Default).constructor === descriptor.typeConstructor)
        text(byDescriptor) + ";" + text(byConstructor)
    }
    observation("substitute-parameters") { text(TypeUtils.substituteParameters(builtIns.list, listOf(intType))) }
    observation("substitute-projections") { text(TypeUtils.substituteProjectionsForParameters(builtIns.list, listOf(TypeProjectionImpl(Variance.IN_VARIANCE, intType)))) }
    expectFailure("substitute-parameter-count") { TypeUtils.substituteParameters(builtIns.list, emptyList()) }
    val listT = generic(false, TypeProjectionImpl(t))
    observation("dependence") {
        check(TypeUtils.dependsOnTypeParameters(listT, listOf(tParameter)) && TypeUtils.dependsOnTypeConstructors(listT, listOf(t.constructor)))
        check(!TypeUtils.dependsOnTypeConstructors(listT, listOf(intType.constructor)))
        val star = generic(false, StarProjectionImpl(tParameter))
        check(!TypeUtils.dependsOnTypeParameters(star, listOf(tParameter)))
        "recursive-parameter;unrelated-and-star-excluded"
    }
    observation("contains-overloads") {
        check(TypeUtils.contains(listT, t) && TypeUtils.contains(listT) { it.constructor == t.constructor })
        check(!TypeUtils.contains(null as KotlinType?, intType) && !TypeUtils.contains(listT, intType))
        check(TypeUtils.contains(TypeUtils.NO_EXPECTED_TYPE) { it === TypeUtils.NO_EXPECTED_TYPE })
        check(TypeUtils.contains(flexible, intType) && TypeUtils.contains(definitely, definitely.original))
        "null;sentinel;generic;flexible;definitely"
    }
    val intersection = IntersectionTypeConstructor(listOf(intType, stringType)).createType()
    observation("intersection-traversal") {
        check(TypeUtils.contains(intersection, intType) && TypeUtils.contains(intersection, stringType) && !TypeUtils.contains(intersection, longType))
        "both-real-components;nullable=" + TypeUtils.isNullableType(intersection)
    }
    observation("supertypes-int") { TypeUtils.getImmediateSupertypes(intType).joinToString(";") { text(it) } }
    observation("supertypes-list") { TypeUtils.getAllSupertypes(generic(false, TypeProjectionImpl(intType))).joinToString(";") { text(it) } }
    observation("substituted-supertype") {
        val substitutor = TypeSubstitutor.create(mapOf(t.constructor to TypeProjectionImpl(intType)))
        val result = TypeUtils.createSubstitutedSupertype(nullableT, t, substitutor)
        check(result?.isMarkedNullable == true)
        val conflict = TypeSubstitutor.create(mapOf(t.constructor to TypeProjectionImpl(Variance.OUT_VARIANCE, intType)))
        text(result) + ";" + text(TypeUtils.createSubstitutedSupertype(t, t, conflict))
    }
    observation("star-projections") {
        val parameter = builtIns.list.typeConstructor.parameters.single()
        val ordinary = TypeUtils.makeStarProjection(parameter)
        val erased = TypeUtils.makeStarProjection(parameter, ErasureTypeAttributes(TypeUsage.SUPERTYPE))
        check(ordinary.isStarProjection && !erased.isStarProjection)
        val common = TypeUtils.makeStarProjection(parameter, ErasureTypeAttributes(TypeUsage.COMMON))
        check(common.isStarProjection)
        ordinary.toString() + ";supertype=" + text(erased.type)
    }
    fun unsigned(name: String, fqName: org.jetbrains.kotlin.name.FqName): SimpleType? {
        var result: SimpleType? = null
        observation("unsigned-resource-$name") {
            try { result = builtIns.getBuiltInClassByFqName(fqName).defaultType; text(result) }
            catch (failure: AssertionError) {
                check(failure.message?.contains("Can't find built-in class kotlin.") == true)
                failure.javaClass.name + ":" + failure.message
            }
        }
        return result
    }
    val uInt = unsigned("UInt", StandardNames.FqNames.uIntFqName)
    val uLong = unsigned("ULong", StandardNames.FqNames.uLongFqName)
    for ([id, types] in listOf("empty" to emptyList(), "double" to listOf(longType, intType, builtIns.doubleType), "int" to listOf(longType, intType),
      "long" to listOf(longType), "none" to listOf(stringType))) observation("number-default-$id") { text(TypeUtils.getDefaultPrimitiveNumberType(types)) }
    if (uInt != null && uLong != null) {
        observation("number-default-unsigned-int") { text(TypeUtils.getDefaultPrimitiveNumberType(listOf(uLong, uInt))) }
        observation("number-default-unsigned-long") { text(TypeUtils.getDefaultPrimitiveNumberType(listOf(uLong))) }
    } else {
        println("not-run\tnumber-default-unsigned-int\tgenuine unsigned descriptor resources absent")
        println("not-run\tnumber-default-unsigned-long\tgenuine unsigned descriptor resources absent")
    }
    val parameters = CompileTimeConstant.Parameters(true, true, false, false, false, false, false)
    val valueConstructor = IntegerValueTypeConstructor(123, builtIns.builtInsModule, parameters)
    val literalConstructor = IntegerLiteralTypeConstructor(123, builtIns.builtInsModule, parameters)
    for ([id, expected] in listOf("none" to TypeUtils.NO_EXPECTED_TYPE, "int" to intType, "byte" to builtIns.byteType, "long" to longType, "any" to builtIns.anyType,
      "inapplicable" to stringType, "error" to ErrorUtils.createErrorType(ErrorTypeKind.UNRESOLVED_TYPE, "number"))) observation("number-expected-$id") {
        text(TypeUtils.getPrimitiveNumberType(valueConstructor, expected)) + ";literal=" + text(TypeUtils.getPrimitiveNumberType(literalConstructor, expected))
    }
    val callbacks = originalCallbacks()
    val procedure = TypeCheckingProcedure(callbacks)
    val types = listOf("Int" to intType, "Long" to longType, "String" to stringType, "Any" to builtIns.anyType, "Any?" to builtIns.nullableAnyType,
      "Nothing" to builtIns.nothingType, "Int?" to intType.makeNullableAsSpecified(true), "List<Int>" to generic(false, TypeProjectionImpl(intType)),
      "List<Any>" to generic(false, TypeProjectionImpl(builtIns.anyType)), "Array<Int>" to generic(true, TypeProjectionImpl(intType)), "Array<Any>" to generic(true, TypeProjectionImpl(builtIns.anyType)), "Int!" to flexible)
    for ([firstId, first] in types) for ([secondId, second] in types) observation("checker-$firstId-$secondId") {
        "equal=${procedure.equalTypes(first, second)};subtype=${procedure.isSubtypeOf(first, second)}"
    }
    observation("checker-known-relations") {
        check(procedure.equalTypes(intType, intType) && !procedure.equalTypes(intType, longType))
        check(procedure.isSubtypeOf(intType, builtIns.anyType) && !procedure.isSubtypeOf(builtIns.anyType, intType))
        check(!callbacks.capture(t, TypeProjectionImpl(intType)) && !callbacks.noCorrespondingSupertype(intType, stringType))
        check(callbacks.assertEqualTypeConstructors(intType.constructor, intType.constructor) && !callbacks.assertEqualTypeConstructors(intType.constructor, stringType.constructor))
        check(callbacks.assertEqualTypes(intType, intType, procedure) && callbacks.assertSubtype(intType, builtIns.anyType, procedure))
        "four-relations;all-five-original-callback-bodies"
    }
    for (first in Variance.entries) for (second in Variance.entries) observation("effective-$first-$second") {
        val actual = TypeCheckingProcedure.getEffectiveProjectionKind(first, second)
        check(actual == EnrichedProjectionKind.getEffectiveProjectionKind(first, second))
        actual.toString()
    }
    observation("effective-parameter-overload") {
        TypeCheckingProcedure.getEffectiveProjectionKind(builtIns.list.typeConstructor.parameters.single(), TypeProjectionImpl(intType)).toString()
    }
    val collectionAny = KotlinTypeFactory.simpleType(TypeAttributes.Empty, builtIns.collection.typeConstructor, listOf(TypeProjectionImpl(builtIns.anyType)), false)
    observation("corresponding-generic-supertype") {
        val source = generic(false, TypeProjectionImpl(intType))
        val implicit = TypeCheckingProcedure.findCorrespondingSupertype(source, collectionAny)
        val explicit = TypeCheckingProcedure.findCorrespondingSupertype(source, collectionAny, callbacks)
        check(implicit?.arguments?.single()?.type == intType && implicit == explicit)
        text(implicit)
    }
    for (allowed in listOf(false, true)) observation("callback-capture-$allowed") {
        val client = CallbackClient(allowed, false)
        val checking = TypeCheckingProcedure(client)
        val result = checking.equalTypes(generic(true, TypeProjectionImpl(Variance.OUT_VARIANCE, intType)), generic(true, TypeProjectionImpl(t)))
        check(client.captures > 0 && result == allowed)
        "result=$result;capture-count=${client.captures}"
    }
    for (allowed in listOf(false, true)) observation("callback-missing-supertype-$allowed") {
        val client = CallbackClient(false, allowed)
        val result = TypeCheckingProcedure(client).isSubtypeOf(intType, stringType)
        check(result == allowed && client.missing == 1)
        "result=$result;missing-count=${client.missing}"
    }
}
