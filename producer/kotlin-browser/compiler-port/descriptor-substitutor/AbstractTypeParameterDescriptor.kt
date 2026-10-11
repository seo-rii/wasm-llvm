/*
 * Copyright 2010-2016 JetBrains s.r.o.
 * Licensed under the Apache License, Version 2.0.
 * Complete port of AbstractTypeParameterDescriptor.java; see sources.lock.json.
 */
package org.jetbrains.kotlin.descriptors.impl

import org.jetbrains.kotlin.builtins.KotlinBuiltIns
import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.resolve.DescriptorEquivalenceForOverrides
import org.jetbrains.kotlin.resolve.descriptorUtil.builtIns
import org.jetbrains.kotlin.resolve.scopes.LazyScopeAdapter
import org.jetbrains.kotlin.resolve.scopes.TypeIntersectionScope
import org.jetbrains.kotlin.storage.StorageManager
import org.jetbrains.kotlin.types.*
import org.jetbrains.kotlin.types.error.ErrorTypeKind
import org.jetbrains.kotlin.types.error.ErrorUtils

abstract class AbstractTypeParameterDescriptor protected constructor(
    private val storageManager: StorageManager,
    containingDeclaration: DeclarationDescriptor,
    annotations: Annotations,
    name: Name,
    private val variance: Variance,
    private val reified: Boolean,
    private val index: Int,
    source: SourceElement,
    supertypeLoopChecker: SupertypeLoopChecker,
) : DeclarationDescriptorNonRootImpl(containingDeclaration, annotations, name, source), TypeParameterDescriptor {
    private val typeConstructor = storageManager.createLazyValue<TypeConstructor> {
        TypeParameterTypeConstructor(storageManager, supertypeLoopChecker)
    }
    private val defaultType = storageManager.createLazyValue {
        KotlinTypeFactory.simpleTypeWithNonTrivialMemberScope(
            TypeAttributes.Empty, getTypeConstructor(), emptyList(), false,
            LazyScopeAdapter { TypeIntersectionScope.create("Scope for type parameter " + name.asString(), getUpperBounds()) },
        )
    }
    protected abstract fun reportSupertypeLoopError(type: KotlinType)
    protected abstract fun resolveUpperBounds(): List<KotlinType>
    override fun getVariance(): Variance = variance
    override fun isReified(): Boolean = reified
    override fun getIndex(): Int = index
    override fun isCapturedFromOuterDeclaration(): Boolean = false
    override fun getUpperBounds(): List<KotlinType> = (getTypeConstructor() as TypeParameterTypeConstructor).getSupertypes()
    final override fun getTypeConstructor(): TypeConstructor = typeConstructor()
    override fun getDefaultType(): SimpleType = defaultType()
    override fun getOriginal(): TypeParameterDescriptor = super.getOriginal() as TypeParameterDescriptor
    protected open fun processBoundsWithoutCycles(bounds: List<KotlinType>): List<KotlinType> = bounds
    override fun <R, D> accept(visitor: DeclarationDescriptorVisitor<R, D>?, data: D): R? =
        visitor!!.visitTypeParameterDescriptor(this, data)
    override fun getStorageManager(): StorageManager = storageManager

    private inner class TypeParameterTypeConstructor(
        storageManager: StorageManager,
        override val supertypeLoopChecker: SupertypeLoopChecker,
    ) : AbstractTypeConstructor(storageManager) {
        override fun computeSupertypes(): Collection<KotlinType> = resolveUpperBounds()
        override fun getParameters(): List<TypeParameterDescriptor> = emptyList()
        override fun isFinal(): Boolean = false
        override fun isDenotable(): Boolean = true
        override fun getDeclarationDescriptor(): ClassifierDescriptor = this@AbstractTypeParameterDescriptor
        override fun getBuiltIns(): KotlinBuiltIns = this@AbstractTypeParameterDescriptor.builtIns
        override fun toString(): String = getName().toString()
        override fun reportSupertypeLoopError(type: KotlinType) = this@AbstractTypeParameterDescriptor.reportSupertypeLoopError(type)
        override fun processSupertypesWithoutCycles(supertypes: List<KotlinType>): List<KotlinType> = processBoundsWithoutCycles(supertypes)
        override fun defaultSupertypeIfEmpty(): KotlinType = ErrorUtils.createErrorType(ErrorTypeKind.CYCLIC_UPPER_BOUNDS)
        override fun isSameClassifier(classifier: ClassifierDescriptor): Boolean =
            classifier is TypeParameterDescriptor && DescriptorEquivalenceForOverrides.areTypeParametersEquivalent(
                this@AbstractTypeParameterDescriptor, classifier, true,
            )
    }
}
