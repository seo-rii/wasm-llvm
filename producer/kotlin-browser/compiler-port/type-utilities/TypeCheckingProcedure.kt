/* Copyright 2010-2016 JetBrains s.r.o. Apache-2.0.
 * Source-body port of selected TypeCheckingProcedure.java; see sources.lock.json. */
package org.jetbrains.kotlin.types.checker

import kotlin.jvm.JvmStatic
import org.jetbrains.kotlin.builtins.KotlinBuiltIns
import org.jetbrains.kotlin.descriptors.TypeParameterDescriptor
import org.jetbrains.kotlin.portable.assertions.compilerAssert as assert
import org.jetbrains.kotlin.portable.descriptors.*
import org.jetbrains.kotlin.resolve.descriptorUtil.builtIns
import org.jetbrains.kotlin.types.*
import org.jetbrains.kotlin.types.checker.findCorrespondingSupertype as findCorrespondingSupertypeImpl

open class TypeCheckingProcedure(private val constraints: TypeCheckingProcedureCallbacks) {
    open fun equalTypes(type1: KotlinType, type2: KotlinType): Boolean {
        if (type1 === type2) return true
        if (type1.isFlexible()) {
            if (type2.isFlexible()) return !type1.isError && !type2.isError && isSubtypeOf(type1, type2) && isSubtypeOf(type2, type1)
            return heterogeneousEquivalence(type2, type1)
        } else if (type2.isFlexible()) return heterogeneousEquivalence(type1, type2)
        if (type1.isMarkedNullable != type2.isMarkedNullable) return false
        if (type1.isMarkedNullable) return constraints.assertEqualTypes(TypeUtils.makeNotNullable(type1), TypeUtils.makeNotNullable(type2), this)
        val constructor1 = type1.constructor
        val constructor2 = type2.constructor
        if (!constraints.assertEqualTypeConstructors(constructor1, constructor2)) return false
        val type1Arguments = type1.arguments
        val type2Arguments = type2.arguments
        if (type1Arguments.size != type2Arguments.size) return false
        for (i in type1Arguments.indices) {
            val typeProjection1 = type1Arguments[i]
            val typeProjection2 = type2Arguments[i]
            if (typeProjection1.isStarProjection() && typeProjection2.isStarProjection()) continue
            val typeParameter1 = constructor1.parameters[i]
            val typeParameter2 = constructor2.parameters[i]
            if (capture(typeProjection1, typeProjection2, typeParameter1)) continue
            if (getEffectiveProjectionKind(typeParameter1, typeProjection1) != getEffectiveProjectionKind(typeParameter2, typeProjection2)) return false
            if (!constraints.assertEqualTypes(typeProjection1.getType(), typeProjection2.getType(), this)) return false
        }
        return true
    }

    protected open fun heterogeneousEquivalence(inflexibleType: KotlinType, flexibleType: KotlinType): Boolean {
        assert(!inflexibleType.isFlexible()) { "Only inflexible types are allowed here: $inflexibleType" }
        return isSubtypeOf(flexibleType.asFlexibleType().lowerBound, inflexibleType) && isSubtypeOf(inflexibleType, flexibleType.asFlexibleType().upperBound)
    }

    open fun isSubtypeOf(subtype: KotlinType, supertype: KotlinType): Boolean {
        if (sameTypeConstructors(subtype, supertype)) return !subtype.isMarkedNullable || supertype.isMarkedNullable
        val subtypeRepresentative = subtype.getSubtypeRepresentative()
        val supertypeRepresentative = supertype.getSupertypeRepresentative()
        if (subtypeRepresentative !== subtype || supertypeRepresentative !== supertype) return isSubtypeOf(subtypeRepresentative, supertypeRepresentative)
        return isSubtypeOfForRepresentatives(subtype, supertype)
    }

    private fun isSubtypeOfForRepresentatives(subtype: KotlinType, supertype: KotlinType): Boolean {
        if (subtype.isError || supertype.isError) return true
        if (!supertype.isMarkedNullable && subtype.isMarkedNullable) return false
        if (KotlinBuiltIns.isNothingOrNullableNothing(subtype)) return true
        val closestSupertype = findCorrespondingSupertype(subtype, supertype, constraints)
        if (closestSupertype == null) return constraints.noCorrespondingSupertype(subtype, supertype)
        if (!supertype.isMarkedNullable && closestSupertype.isMarkedNullable) return false
        return checkSubtypeForTheSameConstructor(closestSupertype, supertype)
    }

    private fun checkSubtypeForTheSameConstructor(subtype: KotlinType, supertype: KotlinType): Boolean {
        val constructor = subtype.constructor
        val subArguments = subtype.arguments
        val superArguments = supertype.arguments
        if (subArguments.size != superArguments.size) return false
        val parameters = constructor.parameters
        for (i in parameters.indices) {
            val parameter = parameters[i]
            val superArgument = superArguments[i]
            val subArgument = subArguments[i]
            if (superArgument.isStarProjection()) continue
            if (capture(subArgument, superArgument, parameter)) continue
            val argumentIsErrorType = subArgument.getType().isError || superArgument.getType().isError
            if (!argumentIsErrorType && parameter.variance == Variance.INVARIANT && subArgument.getProjectionKind() == Variance.INVARIANT && superArgument.getProjectionKind() == Variance.INVARIANT) {
                if (!constraints.assertEqualTypes(subArgument.getType(), superArgument.getType(), this)) return false
                continue
            }
            val superOut = getOutType(parameter, superArgument)
            val subOut = getOutType(parameter, subArgument)
            if (!constraints.assertSubtype(subOut, superOut, this)) return false
            val superIn = getInType(parameter, superArgument)
            val subIn = getInType(parameter, subArgument)
            if (superArgument.getProjectionKind() != Variance.OUT_VARIANCE) {
                if (!constraints.assertSubtype(superIn, subIn, this)) return false
            } else assert(KotlinBuiltIns.isNothing(superIn)) { "In component must be Nothing for out-projection" }
        }
        return true
    }

    private fun capture(subtypeArgumentProjection: TypeProjection, supertypeArgumentProjection: TypeProjection, parameter: TypeParameterDescriptor): Boolean {
        if (parameter.variance != Variance.INVARIANT) return false
        if (subtypeArgumentProjection.getProjectionKind() != Variance.INVARIANT && supertypeArgumentProjection.getProjectionKind() == Variance.INVARIANT) return constraints.capture(supertypeArgumentProjection.getType(), subtypeArgumentProjection)
        return false
    }

    companion object {
        @JvmStatic fun findCorrespondingSupertype(subtype: KotlinType, supertype: KotlinType): KotlinType? =
            findCorrespondingSupertype(subtype, supertype, TypeCheckerProcedureCallbacksImpl())
        @JvmStatic fun findCorrespondingSupertype(subtype: KotlinType, supertype: KotlinType, typeCheckingProcedureCallbacks: TypeCheckingProcedureCallbacks): KotlinType? =
            findCorrespondingSupertypeImpl(subtype, supertype, typeCheckingProcedureCallbacks)
        private fun getOutType(parameter: TypeParameterDescriptor, argument: TypeProjection): KotlinType =
            if (argument.getProjectionKind() == Variance.IN_VARIANCE || parameter.variance == Variance.IN_VARIANCE) parameter.builtIns.nullableAnyType else argument.getType()
        private fun getInType(parameter: TypeParameterDescriptor, argument: TypeProjection): KotlinType =
            if (argument.getProjectionKind() == Variance.OUT_VARIANCE || parameter.variance == Variance.OUT_VARIANCE) parameter.builtIns.nothingType else argument.getType()
        @JvmStatic fun getEffectiveProjectionKind(typeParameter: TypeParameterDescriptor, typeArgument: TypeProjection): EnrichedProjectionKind =
            getEffectiveProjectionKind(typeParameter.variance, typeArgument.getProjectionKind())
        @JvmStatic fun getEffectiveProjectionKind(typeParameterVariance: Variance, typeArgumentVariance: Variance): EnrichedProjectionKind =
            EnrichedProjectionKind.getEffectiveProjectionKind(typeParameterVariance, typeArgumentVariance)
    }
}
