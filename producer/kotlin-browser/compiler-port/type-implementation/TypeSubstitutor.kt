/*
 * Copyright 2010-2016 JetBrains s.r.o.
 * Licensed under the Apache License, Version 2.0.
 * Port of the selected official TypeSubstitutor.java; see sources.lock.json.
 */
package org.jetbrains.kotlin.types

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic
import org.jetbrains.kotlin.builtins.KotlinBuiltIns
import org.jetbrains.kotlin.builtins.StandardNames
import org.jetbrains.kotlin.descriptors.TypeParameterDescriptor
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.descriptors.annotations.CompositeAnnotations
import org.jetbrains.kotlin.descriptors.annotations.FilteredAnnotations
import org.jetbrains.kotlin.portable.assertions.compilerAssert as assert
import org.jetbrains.kotlin.portable.descriptors.*
import org.jetbrains.kotlin.resolve.calls.inference.isCaptured
import org.jetbrains.kotlin.types.checker.NewCapturedTypeConstructor
import org.jetbrains.kotlin.types.error.ErrorTypeKind
import org.jetbrains.kotlin.types.error.ErrorUtils
import org.jetbrains.kotlin.types.model.TypeSubstitutorMarker
import org.jetbrains.kotlin.types.typeUtil.replaceAnnotations
import org.jetbrains.kotlin.types.typesApproximation.approximateCapturedTypesIfNecessary
import org.jetbrains.kotlin.utils.isProcessCanceledException

open class TypeSubstitutor protected constructor(private val substitutionValue: TypeSubstitution) : TypeSubstitutorMarker {
    private class SubstitutionException(message: String) : Exception(message)

    open fun replaceWithNonApproximatingSubstitution(): TypeSubstitutor {
        if (substitutionValue !is IndexedParametersSubstitution || !substitutionValue.approximateContravariantCapturedTypes()) return this
        return TypeSubstitutor(IndexedParametersSubstitution(substitutionValue.parameters, substitutionValue.arguments, false))
    }

    open fun replaceWithContravariantApproximatingSubstitution(): TypeSubstitutor {
        if (substitutionValue is SubstitutionWithCapturedTypeApproximation) {
            return TypeSubstitutor(SubstitutionWithContravariantCapturedTypeApproximation(substitutionValue.substitution))
        }
        if (substitutionValue is IndexedParametersSubstitution && !substitutionValue.approximateContravariantCapturedTypes()) {
            return TypeSubstitutor(IndexedParametersSubstitution(substitutionValue.parameters, substitutionValue.arguments, true))
        }
        return this
    }

    open fun isEmpty(): Boolean = substitutionValue.isEmpty()
    open fun getSubstitution(): TypeSubstitution = substitutionValue

    open fun safeSubstitute(type: KotlinType, howThisTypeIsUsed: Variance): KotlinType {
        if (isEmpty()) return type
        try {
            return unsafeSubstitute(TypeProjectionImpl(howThisTypeIsUsed, type), null, 0).getType()
        } catch (e: SubstitutionException) {
            // The private exception is constructed only with a non-null literal, as in the original Java path.
            return ErrorUtils.createErrorType(ErrorTypeKind.UNABLE_TO_SUBSTITUTE_TYPE, e.message!!)
        }
    }

    open fun substitute(type: KotlinType, howThisTypeIsUsed: Variance): KotlinType? {
        val projection = substitute(TypeProjectionImpl(howThisTypeIsUsed, getSubstitution().prepareTopLevelType(type, howThisTypeIsUsed)))
        return projection?.getType()
    }

    open fun substitute(typeProjection: TypeProjection): TypeProjection? {
        val substitutedTypeProjection = substituteWithoutApproximation(typeProjection)
        if (!substitutionValue.approximateCapturedTypes() && !substitutionValue.approximateContravariantCapturedTypes()) return substitutedTypeProjection
        return approximateCapturedTypesIfNecessary(substitutedTypeProjection, substitutionValue.approximateContravariantCapturedTypes())
    }

    open fun substituteWithoutApproximation(typeProjection: TypeProjection): TypeProjection? {
        if (isEmpty()) return typeProjection
        try {
            return unsafeSubstitute(typeProjection, null, 0)
        } catch (_: SubstitutionException) {
            return null
        }
    }

    private fun unsafeSubstitute(originalProjection: TypeProjection, typeParameter: TypeParameterDescriptor?, recursionDepth: Int): TypeProjection {
        assertRecursionDepth(recursionDepth, originalProjection, substitutionValue)
        if (originalProjection.isStarProjection()) return originalProjection

        val type = originalProjection.getType()
        if (type is TypeWithEnhancement) {
            val origin = type.origin
            val enhancement = type.enhancement
            val substitution = unsafeSubstitute(TypeProjectionImpl(originalProjection.getProjectionKind(), origin), typeParameter, recursionDepth + 1)
            if (substitution.isStarProjection()) return substitution
            val substitutedEnhancement = substitute(enhancement, originalProjection.getProjectionKind())
            val resultingType = substitution.getType().unwrap().wrapEnhancement(substitutedEnhancement)
            return TypeProjectionImpl(substitution.getProjectionKind(), resultingType)
        }

        if (type.isDynamic() || type.unwrap() is RawType) return originalProjection
        val substituted = substitutionValue[type]
        val replacement = if (substituted != null) projectedTypeForConflictedTypeWithUnsafeVariance(type, substituted, typeParameter, originalProjection) else null
        val originalProjectionKind = originalProjection.getProjectionKind()
        if (replacement == null && type.isFlexible() && !type.isCustomTypeParameter()) {
            val flexibleType = type.asFlexibleType()
            val substitutedLower = unsafeSubstitute(TypeProjectionImpl(originalProjectionKind, flexibleType.lowerBound), typeParameter, recursionDepth + 1)
            val substitutedUpper = unsafeSubstitute(TypeProjectionImpl(originalProjectionKind, flexibleType.upperBound), typeParameter, recursionDepth + 1)
            val substitutedProjectionKind = substitutedLower.getProjectionKind()
            // Keep the original Java && / || precedence and the profile's enabled invariant check.
            assert((substitutedProjectionKind == substitutedUpper.getProjectionKind()) && originalProjectionKind == Variance.INVARIANT || originalProjectionKind == substitutedProjectionKind) {
                "Unexpected substituted projection kind: $substitutedProjectionKind; original: $originalProjectionKind"
            }
            if (substitutedLower.getType() === flexibleType.lowerBound && substitutedUpper.getType() === flexibleType.upperBound) return originalProjection
            val substitutedFlexibleType = KotlinTypeFactory.flexibleType(substitutedLower.getType().asSimpleType(), substitutedUpper.getType().asSimpleType())
            return TypeProjectionImpl(substitutedProjectionKind, substitutedFlexibleType)
        }

        if (KotlinBuiltIns.isNothing(type) || type.isError) return originalProjection
        if (replacement != null) {
            val varianceConflict = conflictType(originalProjectionKind, replacement.getProjectionKind())
            val allowVarianceConflict = type.isCaptured()
            if (!allowVarianceConflict) {
                when (varianceConflict) {
                    VarianceConflictType.OUT_IN_IN_POSITION -> throw SubstitutionException("Out-projection in in-position")
                    VarianceConflictType.IN_IN_OUT_POSITION -> return TypeProjectionImpl(Variance.OUT_VARIANCE, type.constructor.builtIns.nullableAnyType)
                    VarianceConflictType.NO_CONFLICT -> Unit
                }
            }
            val customTypeParameter = type.getCustomTypeParameter()
            if (replacement.isStarProjection()) return replacement
            var substitutedType = if (customTypeParameter != null) customTypeParameter.substitutionResult(replacement.getType()) else TypeUtils.makeNullableIfNeeded(replacement.getType(), type.isMarkedNullable)
            if (!type.annotations.isEmpty()) {
                val typeAnnotations = filterOutUnsafeVariance(substitutionValue.filterAnnotations(type.annotations))
                substitutedType = substitutedType.replaceAnnotations(CompositeAnnotations(substitutedType.annotations, typeAnnotations))
            }
            val resultingProjectionKind = if (varianceConflict == VarianceConflictType.NO_CONFLICT) combine(originalProjectionKind, replacement.getProjectionKind()) else originalProjectionKind
            return TypeProjectionImpl(resultingProjectionKind, substitutedType)
        }
        return substituteCompoundType(originalProjection, recursionDepth)
    }

    private fun substituteCompoundType(originalProjection: TypeProjection, recursionDepth: Int): TypeProjection {
        val type = originalProjection.getType()
        val projectionKind = originalProjection.getProjectionKind()
        if (type.constructor.declarationDescriptor is TypeParameterDescriptor) return originalProjection
        var substitutedAbbreviation: KotlinType? = null
        val abbreviation = type.getAbbreviation()
        if (abbreviation != null) {
            val substitutorForAbbreviation = replaceWithNonApproximatingSubstitution()
            substitutedAbbreviation = substitutorForAbbreviation.substitute(abbreviation, Variance.INVARIANT)
        }
        val substitutedArguments = substituteTypeArguments(type.constructor.parameters, type.arguments, recursionDepth)
        var substitutedType = type.replace(substitutedArguments, substitutionValue.filterAnnotations(type.annotations))
        if (substitutedType is SimpleType && substitutedAbbreviation is SimpleType) substitutedType = substitutedType.withAbbreviation(substitutedAbbreviation)
        return TypeProjectionImpl(projectionKind, substitutedType)
    }

    private fun substituteTypeArguments(typeParameters: List<TypeParameterDescriptor>, typeArguments: List<TypeProjection>, recursionDepth: Int): List<TypeProjection> {
        val substitutedArguments = ArrayList<TypeProjection>(typeParameters.size)
        var wereChanges = false
        for (i in typeParameters.indices) {
            val typeParameter = typeParameters[i]
            val typeArgument = typeArguments[i]
            var substitutedTypeArgument = unsafeSubstitute(typeArgument, typeParameter, recursionDepth + 1)
            when (conflictType(typeParameter.variance, substitutedTypeArgument.getProjectionKind())) {
                VarianceConflictType.NO_CONFLICT -> if (typeParameter.variance != Variance.INVARIANT && !substitutedTypeArgument.isStarProjection()) {
                    substitutedTypeArgument = TypeProjectionImpl(Variance.INVARIANT, substitutedTypeArgument.getType())
                }
                VarianceConflictType.OUT_IN_IN_POSITION, VarianceConflictType.IN_IN_OUT_POSITION -> substitutedTypeArgument = TypeUtils.makeStarProjection(typeParameter)
            }
            if (substitutedTypeArgument !== typeArgument) wereChanges = true
            substitutedArguments.add(substitutedTypeArgument)
        }
        if (!wereChanges) return typeArguments
        return substitutedArguments
    }

    private enum class VarianceConflictType { NO_CONFLICT, IN_IN_OUT_POSITION, OUT_IN_IN_POSITION }

    companion object {
        private const val MAX_RECURSION_DEPTH = 100
        @JvmField val EMPTY: TypeSubstitutor = create(TypeSubstitution.EMPTY)
        @JvmStatic fun create(substitution: TypeSubstitution): TypeSubstitutor = TypeSubstitutor(substitution)
        @JvmStatic fun createChainedSubstitutor(first: TypeSubstitution, second: TypeSubstitution): TypeSubstitutor = create(DisjointKeysUnionTypeSubstitution.create(first, second))
        @JvmStatic fun create(substitutionContext: Map<TypeConstructor, TypeProjection>): TypeSubstitutor = create(TypeConstructorSubstitution.createByConstructorsMap(substitutionContext))
        @JvmStatic fun create(context: KotlinType): TypeSubstitutor = create(TypeConstructorSubstitution.create(context.constructor, context.arguments))

        private fun projectedTypeForConflictedTypeWithUnsafeVariance(originalType: KotlinType, substituted: TypeProjection, typeParameter: TypeParameterDescriptor?, originalProjection: TypeProjection): TypeProjection {
            if (!originalType.annotations.hasAnnotation(StandardNames.FqNames.unsafeVariance)) return substituted
            val constructor = substituted.getType().constructor
            if (constructor !is NewCapturedTypeConstructor) return substituted
            val capturedTypeProjection = constructor.projection
            val varianceOfCapturedType = capturedTypeProjection.getProjectionKind()
            val conflictWithTopLevelType = conflictType(originalProjection.getProjectionKind(), varianceOfCapturedType)
            if (conflictWithTopLevelType == VarianceConflictType.OUT_IN_IN_POSITION) return TypeProjectionImpl(capturedTypeProjection.getType())
            if (typeParameter == null) return substituted
            val conflictTypeWithTypeParameter = conflictType(typeParameter.variance, varianceOfCapturedType)
            if (conflictTypeWithTypeParameter == VarianceConflictType.OUT_IN_IN_POSITION) return TypeProjectionImpl(capturedTypeProjection.getType())
            return substituted
        }

        private fun filterOutUnsafeVariance(annotations: Annotations): Annotations {
            if (!annotations.hasAnnotation(StandardNames.FqNames.unsafeVariance)) return annotations
            return FilteredAnnotations(annotations) { name -> name != StandardNames.FqNames.unsafeVariance }
        }

        @JvmStatic fun combine(typeParameterVariance: Variance, typeProjection: TypeProjection): Variance {
            if (typeProjection.isStarProjection()) return Variance.OUT_VARIANCE
            return combine(typeParameterVariance, typeProjection.getProjectionKind())
        }

        @JvmStatic fun combine(typeParameterVariance: Variance, projectionKind: Variance): Variance {
            if (typeParameterVariance == Variance.INVARIANT) return projectionKind
            if (projectionKind == Variance.INVARIANT) return typeParameterVariance
            if (typeParameterVariance == projectionKind) return projectionKind
            throw AssertionError("Variance conflict: type parameter variance '$typeParameterVariance' and projection kind '$projectionKind' cannot be combined")
        }

        private fun conflictType(position: Variance, argument: Variance): VarianceConflictType {
            if (position == Variance.IN_VARIANCE && argument == Variance.OUT_VARIANCE) return VarianceConflictType.OUT_IN_IN_POSITION
            if (position == Variance.OUT_VARIANCE && argument == Variance.IN_VARIANCE) return VarianceConflictType.IN_IN_OUT_POSITION
            return VarianceConflictType.NO_CONFLICT
        }

        private fun assertRecursionDepth(recursionDepth: Int, projection: TypeProjection, substitution: TypeSubstitution) {
            if (recursionDepth > MAX_RECURSION_DEPTH) throw IllegalStateException("Recursion too deep. Most likely infinite loop while substituting " + safeToString(projection) + "; substitution: " + safeToString(substitution))
        }

        private fun safeToString(value: Any): String {
            try {
                return value.toString()
            } catch (e: Throwable) {
                if (e.isProcessCanceledException()) throw (e as RuntimeException)
                return "[Exception while computing toString(): $e]"
            }
        }
    }
}
