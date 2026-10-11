/*
 * Copyright 2010-2015 JetBrains s.r.o.
 * Licensed under the Apache License, Version 2.0.
 * Complete port of DescriptorSubstitutor.java; see sources.lock.json.
 */
package org.jetbrains.kotlin.types

import org.jetbrains.kotlin.descriptors.DeclarationDescriptor
import org.jetbrains.kotlin.descriptors.SourceElement
import org.jetbrains.kotlin.descriptors.TypeParameterDescriptor
import org.jetbrains.kotlin.descriptors.impl.TypeParameterDescriptorImpl
import org.jetbrains.kotlin.types.typeUtil.hasTypeParameterRecursiveBounds

class DescriptorSubstitutor private constructor() {
    companion object {
        @kotlin.jvm.JvmStatic
        fun substituteTypeParameters(
            typeParameters: List<TypeParameterDescriptor>,
            originalSubstitution: TypeSubstitution,
            newContainingDeclaration: DeclarationDescriptor,
            result: MutableList<TypeParameterDescriptor>,
        ): TypeSubstitutor = substituteTypeParameters(
            typeParameters, originalSubstitution, newContainingDeclaration, result, null,
        ) ?: throw AssertionError("Substitution failed")

        @kotlin.jvm.JvmStatic
        fun substituteTypeParameters(
            typeParameters: List<TypeParameterDescriptor>,
            originalSubstitution: TypeSubstitution,
            newContainingDeclaration: DeclarationDescriptor,
            result: MutableList<TypeParameterDescriptor>,
            wereChanges: BooleanArray?,
        ): TypeSubstitutor? {
            val mutableSubstitutionMap = HashMap<TypeConstructor, TypeProjection>()
            val substitutedMap = HashMap<TypeParameterDescriptor, TypeParameterDescriptorImpl>()
            var index = 0
            for (descriptor in typeParameters) {
                val substituted = TypeParameterDescriptorImpl.createForFurtherModification(
                    newContainingDeclaration, descriptor.annotations, descriptor.isReified(),
                    descriptor.getVariance(), descriptor.getName(), index++,
                    SourceElement.NO_SOURCE, descriptor.getStorageManager(),
                )
                mutableSubstitutionMap[descriptor.getTypeConstructor()] = TypeProjectionImpl(substituted.getDefaultType())
                substitutedMap[descriptor] = substituted
                result.add(substituted)
            }
            val mutableSubstitution = TypeConstructorSubstitution.createByConstructorsMap(mutableSubstitutionMap)
            val substitutor = TypeSubstitutor.createChainedSubstitutor(originalSubstitution, mutableSubstitution)
            val nonApproximatingSubstitutor = TypeSubstitutor.createChainedSubstitutor(
                originalSubstitution.replaceWithNonApproximating(), mutableSubstitution,
            )
            for (descriptor in typeParameters) {
                val substituted = substitutedMap[descriptor]!!
                for (upperBound in descriptor.getUpperBounds()) {
                    val upperBoundDeclaration = upperBound.constructor.declarationDescriptor
                    val boundSubstitutor = if (upperBoundDeclaration is TypeParameterDescriptor &&
                        hasTypeParameterRecursiveBounds(upperBoundDeclaration)) substitutor else nonApproximatingSubstitutor
                    val substitutedBound = boundSubstitutor.substitute(upperBound, Variance.OUT_VARIANCE) ?: return null
                    if (substitutedBound !== upperBound && wereChanges != null) wereChanges[0] = true
                    substituted.addUpperBound(substitutedBound)
                }
                substituted.setInitialized()
            }
            return substitutor
        }
    }
}
