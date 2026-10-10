@file:OptIn(org.jetbrains.kotlin.fir.types.DelicateIntersectionConstructor::class, org.jetbrains.kotlin.fir.types.DelicateUnionConstructor::class, org.jetbrains.kotlin.fir.types.DynamicTypeConstructor::class)

package org.jetbrains.kotlin.portable.coneclassidentity.probe

import org.jetbrains.kotlin.fir.diagnostics.ConeSimpleDiagnostic
import org.jetbrains.kotlin.fir.symbols.impl.ConeClassLikeLookupTagImpl
import org.jetbrains.kotlin.fir.symbols.impl.FirTypeParameterSymbol
import org.jetbrains.kotlin.fir.types.*
import org.jetbrains.kotlin.name.ClassId
import org.jetbrains.kotlin.name.FqName
import org.jetbrains.kotlin.types.model.CaptureStatus

/** Full selected official classes; external helpers are genuine verified-bootstrap objects. */
fun main() {
    fun record(id: String, value: Any?) { println("$id\t$value") }
    fun simple(name: String, nullable: Boolean = false) = ConeClassLikeTypeImpl(
        ConeClassLikeLookupTagImpl(ClassId.topLevel(FqName("probe.$name"))), emptyArray(), nullable,
    )
    val a = simple("A"); val b = simple("B"); val attributes = ConeAttributes.WithExtensionFunctionType
    val constructor = ConeCapturedTypeConstructor(ConeStarProjection, null, CaptureStatus.FOR_SUBTYPING)
    val captured = ConeCapturedType(constructor = constructor)
    val intersection = ConeIntersectionType(listOf(a, b), null)
    val errorA = ConeErrorType(ConeSimpleDiagnostic("A")); val errorB = ConeErrorType(ConeSimpleDiagnostic("B"))
    val union = ConeUnionType(a, listOf(errorA, errorB), ConeAttributes.Empty)
    val variable = ConeTypeVariable("T")
    for (empty in listOf(emptyList<ConeKotlinType>(), emptySet<ConeKotlinType>())) {
        val outcome = try { ConeIntersectionType(empty, null); "constructed" } catch (failure: NoSuchElementException) { "NoSuchElementException" }
        check(outcome == "NoSuchElementException")
        record("empty-intersection-construction-${if (empty is List<*>) "list" else "set"}", outcome)
    }
    val values: List<Any?> = listOf(
        captured, captured, captured.copy(), captured.copy(isMarkedNullable = true), captured.copy(attributes = attributes),
        ConeCapturedType(constructor = ConeCapturedTypeConstructor(ConeStarProjection, null, CaptureStatus.FOR_SUBTYPING)),
        intersection, ConeIntersectionType(listOf(a, b), b), ConeIntersectionType(listOf(b, a), null),
        ConeIntersectionType(setOf(a, b), null),
        union, ConeUnionType(a, listOf(errorA, errorB), attributes), ConeUnionType(b, listOf(errorA, errorB), ConeAttributes.Empty),
        ConeUnionType(a, listOf(errorB, errorA), ConeAttributes.Empty), ConeUnionType(a, listOf(errorA, errorA), ConeAttributes.Empty),
        a, b, errorA, ConeTypeParameterType(FirTypeParameterSymbol().toLookupTag(), false),
        ConeFlexibleType(a, b, false), ConeDynamicType(a, b), ConeRawType.create(a, b), ConeDefinitelyNotNullType(a),
        variable.defaultType, ConeStubTypeForTypeVariableInSubtyping(variable, false),
        ConeIntegerLiteralConstantTypeImpl(3L, listOf(a, b), false, false), ConeIntegerConstantOperatorTypeImpl(false, false),
        null, "unrelated", Any(),
    )
    val expectedClasses = setOf("ConeCapturedType", "ConeIntersectionType", "ConeUnionType", "ConeClassLikeTypeImpl", "ConeErrorType",
        "ConeTypeParameterType", "ConeFlexibleType", "ConeDynamicType", "ConeRawType", "ConeDefinitelyNotNullType", "ConeTypeVariableType",
        "ConeStubTypeForTypeVariableInSubtyping", "ConeIntegerLiteralConstantTypeImpl", "ConeIntegerConstantOperatorTypeImpl")
    check(values.filterIsInstance<ConeKotlinType>().map { it::class.simpleName }.toSet() == expectedClasses)
    record("all-selected-concrete-type-kinds", expectedClasses.size)
    for ([i, value] in values.withIndex()) {
        record("class-$i", value?.let { it::class.simpleName })
        val first = value.hashCode()
        record("hash-stable-$i", (0 until 16).all { first == value.hashCode() })
        for ([j, other] in values.withIndex()) {
            record("equal-$i-$j", value == other)
            record("equal-hash-$i-$j", value != other || value.hashCode() == other.hashCode())
        }
    }
    check(captured.equals(captured.copy(attributes = attributes)))
    check(intersection.equals(ConeIntersectionType(listOf(a, b), b)))
    check(union.equals(ConeUnionType(a, listOf(errorA, errorB), attributes)))
    check(!intersection.equals(ConeIntersectionType(listOf(b, a), null)))
    check(!captured.equals(values[5]))
    // The existing open-family broad equality remains deliberately broader than exact class equality.
    check(ConeFlexibleType(a, b, false).equals(ConeDynamicType(a, b)))
    record("ignored-metadata-and-open-family-preserved", true)
}
