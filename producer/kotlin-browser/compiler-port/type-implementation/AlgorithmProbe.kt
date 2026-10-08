package org.jetbrains.kotlin.portable.typeimplementation.probe

import com.intellij.openapi.progress.ProcessCanceledException
import org.jetbrains.kotlin.builtins.DefaultBuiltIns
import org.jetbrains.kotlin.builtins.StandardNames
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.descriptors.annotations.BuiltInAnnotationDescriptor
import org.jetbrains.kotlin.descriptors.impl.TypeParameterDescriptorImpl
import org.jetbrains.kotlin.load.java.lazy.types.RawTypeImpl
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.renderer.DescriptorRenderer
import org.jetbrains.kotlin.resolve.calls.inference.createCapturedType
import org.jetbrains.kotlin.storage.LockBasedStorageManager
import org.jetbrains.kotlin.types.*
import org.jetbrains.kotlin.types.checker.KotlinTypeRefiner
import org.jetbrains.kotlin.types.checker.NewCapturedType
import org.jetbrains.kotlin.types.checker.NewCapturedTypeConstructor
import org.jetbrains.kotlin.types.error.ErrorTypeKind
import org.jetbrains.kotlin.types.error.ErrorUtils
import org.jetbrains.kotlin.types.model.CaptureStatus
import org.jetbrains.kotlin.types.typeUtil.replaceAnnotations

// Real compiler type factories and builtins supply all tested types. No type-system implementation is replaced by a fixture.
private val builtIns = DefaultBuiltIns.Instance
private val tParameter = TypeParameterDescriptorImpl.createWithDefaultBound(
    builtIns.list, Annotations.EMPTY, false, Variance.INVARIANT, Name.identifier("T"), 0, LockBasedStorageManager("type-port-T"),
)
private val uParameter = TypeParameterDescriptorImpl.createWithDefaultBound(
    builtIns.list, Annotations.EMPTY, false, Variance.INVARIANT, Name.identifier("U"), 1, LockBasedStorageManager("type-port-U"),
)
private val t = tParameter.defaultType
private val u = uParameter.defaultType
private val intType = builtIns.intType
private val stringType = builtIns.stringType
private val renderer = DescriptorRenderer.FQ_NAMES_IN_TYPES
private fun typeText(type: KotlinType?): String = type?.let(renderer::renderType) ?: "null"
private fun projectionText(projection: TypeProjection?): String = projection?.let {
    if (it.isStarProjection) "*" else it.projectionKind.toString() + ":" + typeText(it.type)
} ?: "null"
private fun mapped(projection: TypeProjection): TypeSubstitutor = TypeSubstitutor.create(mapOf(t.constructor to projection))
private fun generic(argument: TypeProjection, nullable: Boolean = false): SimpleType =
    KotlinTypeFactory.simpleType(TypeAttributes.Empty, builtIns.list.typeConstructor, listOf(argument), nullable)
private fun observation(id: String, body: () -> String) = println(id + "\t" + body())
private fun expectThrown(id: String, expected: Class<out Throwable>, body: () -> Any?) {
    val failure = try { body(); null } catch (e: Throwable) { e }
    check(failure != null && expected.isInstance(failure)) { "$id: missing or wrong failure: $failure" }
    println(id + "\t" + failure.javaClass.name + ":" + failure.message)
}
private class CancelChild : ProcessCanceledException()

@OptIn(TypeRefinement::class)
fun main() {
    for (variance in Variance.entries) {
        observation("projection-" + variance) {
            val original = TypeProjectionImpl(variance, intType)
            check(original.projectionKind == variance && original.type === intType && !original.isStarProjection)
            check(original == TypeProjectionImpl(variance, intType) && original != TypeProjectionImpl(variance, stringType))
            check(original != Any() && !original.equals(null))
            check(original.hashCode() == 31 * variance.hashCode() + intType.hashCode())
            val replaced = original.replaceType(stringType)
            check(replaced.type === stringType && replaced.projectionKind == variance && replaced !== original)
            val refined = original.refine(KotlinTypeRefiner.Default)
            check(refined.type === intType && refined.projectionKind == variance && refined !== original)
            original.toString() + ";replace=" + projectionText(replaced) + ";refine=" + projectionText(refined)
        }
    }
    observation("projection-special-hash") {
        val absent = TypeProjectionImpl(TypeUtils.NO_EXPECTED_TYPE)
        check(absent.hashCode() == 31 * Variance.INVARIANT.hashCode() + 19)
        val unit = TypeProjectionImpl(TypeUtils.UNIT_EXPECTED_TYPE)
        check(unit.hashCode() == 31 * Variance.INVARIANT.hashCode() + 19)
        "both original sentinel identities use 19"
    }
    observation("projection-star") {
        val star = StarProjectionImpl(tParameter)
        check(star.toString() == "*" && star.isStarProjection)
        check(star.hashCode() == 31 * star.projectionKind.hashCode() + 17)
        check(star == StarProjectionImpl(tParameter) && star != TypeProjectionImpl(star.type))
        "*;hash-and-equality"
    }
    for (first in Variance.entries) for (second in Variance.entries) {
        val id = "combine-$first-$second"
        if (first != Variance.INVARIANT && second != Variance.INVARIANT && first != second) {
            expectThrown(id, AssertionError::class.java) { TypeSubstitutor.combine(first, second) }
        } else observation(id) { TypeSubstitutor.combine(first, second).toString() }
    }
    observation("combine-star") { TypeSubstitutor.combine(Variance.IN_VARIANCE, StarProjectionImpl(tParameter)).also { check(it == Variance.OUT_VARIANCE) }.toString() }
    observation("empty-identities") {
        val projection = TypeProjectionImpl(t)
        check(TypeSubstitutor.EMPTY.isEmpty && TypeSubstitutor.EMPTY.safeSubstitute(t, Variance.INVARIANT) === t)
        check(TypeSubstitutor.EMPTY.substituteWithoutApproximation(projection) === projection)
        check(TypeSubstitutor.create(emptyMap<TypeConstructor, TypeProjection>()).isEmpty)
        "type-and-projection-preserved"
    }
    for (replacement in Variance.entries) for (position in Variance.entries) {
        val substitutor = mapped(TypeProjectionImpl(replacement, intType))
        observation("substitute-$position-$replacement") {
            val result = substitutor.substituteWithoutApproximation(TypeProjectionImpl(position, t))
            if (position == Variance.IN_VARIANCE && replacement == Variance.OUT_VARIANCE) check(result == null)
            else if (position == Variance.OUT_VARIANCE && replacement == Variance.IN_VARIANCE) check(result?.type == builtIns.nullableAnyType)
            else check(result?.type === intType)
            projectionText(result)
        }
    }
    observation("safe-conflict-error") {
        val result = mapped(TypeProjectionImpl(Variance.OUT_VARIANCE, intType)).safeSubstitute(t, Variance.IN_VARIANCE)
        check(result.isError)
        typeText(result)
    }
    observation("nullable-replacement") {
        val result = mapped(TypeProjectionImpl(intType)).substitute(t.makeNullableAsSpecified(true), Variance.INVARIANT)
        check(result != null && result.isMarkedNullable && result.constructor === intType.constructor)
        typeText(result)
    }
    observation("star-replacement-identity") {
        val star = StarProjectionImpl(tParameter)
        val result = mapped(star).substituteWithoutApproximation(TypeProjectionImpl(t))
        check(result === star)
        projectionText(result)
    }
    observation("unmapped-parameter-identity") {
        val original = TypeProjectionImpl(u)
        check(mapped(TypeProjectionImpl(intType)).substituteWithoutApproximation(original) === original)
        "same-projection"
    }
    observation("generic-arguments") {
        val original = generic(TypeProjectionImpl(t))
        val result = mapped(TypeProjectionImpl(intType)).substitute(original, Variance.INVARIANT)!!
        check(result.arguments.single().type === intType && result.arguments.single().projectionKind == Variance.INVARIANT)
        typeText(result)
    }
    observation("generic-conflict-star") {
        val original = generic(TypeProjectionImpl(t))
        val result = mapped(TypeProjectionImpl(Variance.IN_VARIANCE, intType)).substitute(original, Variance.INVARIANT)!!
        check(result.arguments.single().isStarProjection)
        typeText(result)
    }
    observation("generic-unchanged-list-identity") {
        val original = generic(StarProjectionImpl(builtIns.list.typeConstructor.parameters.single()))
        val result = mapped(TypeProjectionImpl(intType)).substitute(original, Variance.INVARIANT)!!
        check(result === original && result.arguments === original.arguments)
        typeText(result)
    }
    observation("flexible-substitution") {
        val original = KotlinTypeFactory.flexibleType(t, t.makeNullableAsSpecified(true))
        val result = mapped(TypeProjectionImpl(intType)).substitute(original, Variance.INVARIANT)!!
        check(result.isFlexible() && result.lowerIfFlexible().constructor === intType.constructor && result.upperIfFlexible().isMarkedNullable)
        typeText(result)
    }
    observation("flexible-unchanged-identity") {
        val original = TypeProjectionImpl(KotlinTypeFactory.flexibleType(u, u.makeNullableAsSpecified(true)))
        check(mapped(TypeProjectionImpl(intType)).substituteWithoutApproximation(original) === original)
        projectionText(original)
    }
    observation("dynamic-identity") {
        val original = TypeProjectionImpl(createDynamicType(builtIns))
        check(mapped(TypeProjectionImpl(intType)).substituteWithoutApproximation(original) === original)
        projectionText(original)
    }
    observation("raw-identity") {
        val lower = generic(TypeProjectionImpl(t))
        val raw = RawTypeImpl(lower, lower.makeNullableAsSpecified(true))
        val original = TypeProjectionImpl(raw)
        check(mapped(TypeProjectionImpl(intType)).substituteWithoutApproximation(original) === original)
        "same-real-raw-projection"
    }
    observation("nothing-identity") {
        val original = TypeProjectionImpl(builtIns.nothingType)
        check(mapped(TypeProjectionImpl(intType)).substituteWithoutApproximation(original) === original)
        projectionText(original)
    }
    observation("error-identity") {
        val original = TypeProjectionImpl(ErrorUtils.createErrorType(ErrorTypeKind.UNRESOLVED_TYPE, "missing"))
        check(mapped(TypeProjectionImpl(intType)).substituteWithoutApproximation(original) === original)
        projectionText(original)
    }
    observation("enhancement-substitution") {
        val original = t.wrapEnhancement(t.makeNullableAsSpecified(true))
        val result = mapped(TypeProjectionImpl(intType)).substitute(original, Variance.INVARIANT)!!
        check(result is TypeWithEnhancement && result.origin.constructor === intType.constructor && result.enhancement.isMarkedNullable)
        typeText(result) + ";enhancement=" + typeText(result.enhancement)
    }
    observation("annotation-legacy-filtered-empty") {
        val unsafe = BuiltInAnnotationDescriptor(builtIns, StandardNames.FqNames.unsafeVariance, emptyMap())
        val deprecated = BuiltInAnnotationDescriptor(builtIns, StandardNames.FqNames.deprecated, emptyMap())
        val original = t.replaceAnnotations(Annotations.create(listOf(unsafe, deprecated)))
        val result = mapped(TypeProjectionImpl(intType)).substitute(original, Variance.INVARIANT)!!
        // The selected legacy FilteredAnnotations.isEmpty path reports delegate.any(filter).
        // Preserve this upstream behavior, rather than repairing it inside a host port.
        check(result.annotations.isEmpty() && !result.annotations.hasAnnotation(StandardNames.FqNames.unsafeVariance) && !result.annotations.hasAnnotation(StandardNames.FqNames.deprecated))
        "original-legacy-empty-annotation-result"
    }
    observation("annotation-unsafe-variance-filter") {
        val unsafe = BuiltInAnnotationDescriptor(builtIns, StandardNames.FqNames.unsafeVariance, emptyMap())
        val deprecated = BuiltInAnnotationDescriptor(builtIns, StandardNames.FqNames.deprecated, emptyMap())
        val original = t.replaceAnnotations(Annotations.create(listOf(unsafe, deprecated)))
        val replacement = intType.replaceAnnotations(Annotations.create(listOf(deprecated)))
        val result = mapped(TypeProjectionImpl(replacement)).substitute(original, Variance.INVARIANT)!!
        check(!result.annotations.hasAnnotation(StandardNames.FqNames.unsafeVariance) && result.annotations.hasAnnotation(StandardNames.FqNames.deprecated))
        result.annotations.map { it.fqName.toString() }.sorted().joinToString(",")
    }
    observation("captured-opposite-variance") {
        val captured = createCapturedType(TypeProjectionImpl(Variance.IN_VARIANCE, intType))
        val substitutor = TypeSubstitutor.create(mapOf(captured.constructor to TypeProjectionImpl(Variance.IN_VARIANCE, intType)))
        val result = substitutor.substituteWithoutApproximation(TypeProjectionImpl(Variance.OUT_VARIANCE, captured))!!
        check(result.projectionKind == Variance.OUT_VARIANCE && result.type === intType)
        projectionText(result)
    }
    observation("unsafe-variance-new-captured") {
        val original = t.replaceAnnotations(Annotations.create(listOf(BuiltInAnnotationDescriptor(builtIns, StandardNames.FqNames.unsafeVariance, emptyMap()))))
        val captured = NewCapturedType(CaptureStatus.FOR_SUBTYPING, NewCapturedTypeConstructor(TypeProjectionImpl(Variance.OUT_VARIANCE, intType)), null)
        val result = mapped(TypeProjectionImpl(captured)).substituteWithoutApproximation(TypeProjectionImpl(Variance.IN_VARIANCE, original))!!
        check(result.type.constructor === intType.constructor && result.projectionKind == Variance.IN_VARIANCE)
        check(!result.type.annotations.hasAnnotation(StandardNames.FqNames.unsafeVariance))
        projectionText(result)
    }
    observation("custom-definitely-not-null") {
        val original = DefinitelyNotNullType.makeDefinitelyNotNull(t.makeNullableAsSpecified(true), avoidCheckingActualTypeNullability = true)!!
        val result = mapped(TypeProjectionImpl(intType.makeNullableAsSpecified(true))).substitute(original, Variance.INVARIANT)!!
        check(!result.isMarkedNullable && result.constructor === intType.constructor)
        typeText(result)
    }
    observation("abbreviation-substitution") {
        val original = generic(TypeProjectionImpl(t)).withAbbreviation(generic(TypeProjectionImpl(t)))
        val result = mapped(TypeProjectionImpl(intType)).substitute(original, Variance.INVARIANT)!!
        check(result.getAbbreviation()?.arguments?.single()?.type === intType)
        typeText(result) + ";abbr=" + typeText(result.getAbbreviation())
    }
    observation("indexed-approximation-controls") {
        val initial = TypeSubstitutor.create(IndexedParametersSubstitution(arrayOf(tParameter), arrayOf(TypeProjectionImpl(intType)), true))
        val nonApproximating = initial.replaceWithNonApproximatingSubstitution()
        check(!nonApproximating.substitution.approximateContravariantCapturedTypes())
        check(nonApproximating.replaceWithNonApproximatingSubstitution() === nonApproximating)
        val contravariant = nonApproximating.replaceWithContravariantApproximatingSubstitution()
        check(contravariant.substitution.approximateContravariantCapturedTypes())
        check(contravariant.replaceWithContravariantApproximatingSubstitution() === contravariant)
        typeText(initial.substitute(t, Variance.INVARIANT))
    }
    observation("delegated-approximation-controls") {
        val ordinary = TypeConstructorSubstitution.createByConstructorsMap(mapOf(t.constructor to TypeProjectionImpl(intType)))
        val initial = TypeSubstitutor.create(SubstitutionWithCapturedTypeApproximation(ordinary))
        val result = initial.replaceWithContravariantApproximatingSubstitution()
        check(result.substitution.approximateCapturedTypes() && result.substitution.approximateContravariantCapturedTypes())
        check(TypeSubstitutor.EMPTY.replaceWithContravariantApproximatingSubstitution() === TypeSubstitutor.EMPTY)
        typeText(result.substitute(t, Variance.INVARIANT))
    }
    observation("captured-approximation") {
        val captured = createCapturedType(TypeProjectionImpl(Variance.OUT_VARIANCE, intType))
        val initial = TypeSubstitutor.create(SubstitutionWithCapturedTypeApproximation(TypeConstructorSubstitution.createByConstructorsMap(mapOf(t.constructor to TypeProjectionImpl(captured)))))
        val result = initial.substitute(t, Variance.OUT_VARIANCE)!!
        check(result.constructor === intType.constructor)
        typeText(result)
    }
    observation("chained-substitution") {
        val first = TypeConstructorSubstitution.createByConstructorsMap(mapOf(t.constructor to TypeProjectionImpl(intType)))
        val second = TypeConstructorSubstitution.createByConstructorsMap(mapOf(u.constructor to TypeProjectionImpl(stringType)))
        val chained = TypeSubstitutor.createChainedSubstitutor(first, second)
        check(chained.substitute(t, Variance.INVARIANT) === intType && chained.substitute(u, Variance.INVARIANT) === stringType)
        typeText(chained.substitute(t, Variance.INVARIANT)) + ";" + typeText(chained.substitute(u, Variance.INVARIANT))
    }
    observation("context-substitution-factory") {
        val context = generic(TypeProjectionImpl(intType))
        val result = TypeSubstitutor.create(context).substitute(builtIns.list.typeConstructor.parameters.single().defaultType, Variance.INVARIANT)
        check(result === intType)
        typeText(result)
    }
    observation("top-level-preparation") {
        var calls = 0
        val substitution = object : TypeSubstitution() {
            override fun get(key: KotlinType) = if (key.constructor == t.constructor) TypeProjectionImpl(intType) else null
            override fun prepareTopLevelType(topLevelType: KotlinType, position: Variance): KotlinType { ++calls; return t }
        }
        val substitutor = TypeSubstitutor.create(substitution)
        check(substitutor.substitute(u, Variance.INVARIANT) === intType && calls == 1)
        check(substitutor.safeSubstitute(u, Variance.INVARIANT) === u && calls == 1)
        "ordinary=prepared;safe=unprepared"
    }
    var deep: KotlinType = t
    repeat(110) { deep = generic(TypeProjectionImpl(deep)) }
    val recursive = object : TypeSubstitution() {
        override fun get(key: KotlinType): TypeProjection? = if (key.constructor == t.constructor) TypeProjectionImpl(intType) else null
        override fun toString(): String = "stable-recursion-substitution"
    }
    expectThrown("recursion-depth-guard", IllegalStateException::class.java) { TypeSubstitutor.create(recursive).substitute(deep, Variance.INVARIANT) }
    val failingRender = object : TypeSubstitution() {
        override fun get(key: KotlinType): TypeProjection? = null
        override fun toString(): String = throw IllegalArgumentException("cannot-render-substitution")
    }
    expectThrown("recursion-render-failure", IllegalStateException::class.java) { TypeSubstitutor.create(failingRender).substitute(deep, Variance.INVARIANT) }
    val cancelRender = object : TypeSubstitution() {
        override fun get(key: KotlinType): TypeProjection? = null
        override fun toString(): String = throw CancelChild()
    }
    expectThrown("recursion-render-cancellation", CancelChild::class.java) { TypeSubstitutor.create(cancelRender).substitute(deep, Variance.INVARIANT) }
}
