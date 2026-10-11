/*
 * Copyright 2010-2015 JetBrains s.r.o.
 * Licensed under the Apache License, Version 2.0.
 * Complete port of TypeParameterDescriptorImpl.java; see sources.lock.json.
 */
package org.jetbrains.kotlin.descriptors.impl

import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.resolve.DescriptorUtils
import org.jetbrains.kotlin.resolve.descriptorUtil.builtIns
import org.jetbrains.kotlin.storage.StorageManager
import org.jetbrains.kotlin.types.KotlinType
import org.jetbrains.kotlin.types.Variance
import org.jetbrains.kotlin.types.isError

class TypeParameterDescriptorImpl private constructor(
    containingDeclaration: DeclarationDescriptor,
    annotations: Annotations,
    reified: Boolean,
    variance: Variance,
    name: Name,
    index: Int,
    source: SourceElement,
    private val reportCycleError: ((KotlinType) -> Nothing?)?,
    supertypeLoopsChecker: SupertypeLoopChecker,
    storageManager: StorageManager,
) : AbstractTypeParameterDescriptor(storageManager, containingDeclaration, annotations, name, variance, reified, index, source, supertypeLoopsChecker) {
    private val upperBounds = ArrayList<KotlinType>(1)
    private var initialized = false
    private fun checkInitialized() {
        if (!initialized) throw IllegalStateException("Type parameter descriptor is not initialized: " + nameForAssertions())
    }
    private fun checkUninitialized() {
        if (initialized) throw IllegalStateException("Type parameter descriptor is already initialized: " + nameForAssertions())
    }
    private fun nameForAssertions(): String = getName().toString() + " declared in " + DescriptorUtils.getFqName(getContainingDeclaration())
    fun setInitialized() { checkUninitialized(); initialized = true }
    fun isInitialized(): Boolean = initialized
    fun addUpperBound(bound: KotlinType) { checkUninitialized(); doAddUpperBound(bound) }
    private fun doAddUpperBound(bound: KotlinType) { if (bound.isError) return; upperBounds.add(bound) }
    fun addDefaultUpperBound() {
        checkUninitialized()
        if (upperBounds.isEmpty()) doAddUpperBound(getContainingDeclaration().builtIns.defaultBound)
    }
    override fun reportSupertypeLoopError(type: KotlinType) { reportCycleError?.invoke(type) }
    override fun resolveUpperBounds(): List<KotlinType> { checkInitialized(); return upperBounds }

    companion object {
        @kotlin.jvm.JvmStatic
        fun createWithDefaultBound(containingDeclaration: DeclarationDescriptor, annotations: Annotations, reified: Boolean,
            variance: Variance, name: Name, index: Int, storageManager: StorageManager): TypeParameterDescriptor {
            val descriptor = createForFurtherModification(containingDeclaration, annotations, reified, variance, name, index, SourceElement.NO_SOURCE, storageManager)
            descriptor.addUpperBound(containingDeclaration.builtIns.defaultBound)
            descriptor.setInitialized()
            return descriptor
        }
        @kotlin.jvm.JvmStatic
        fun createForFurtherModification(containingDeclaration: DeclarationDescriptor, annotations: Annotations, reified: Boolean,
            variance: Variance, name: Name, index: Int, source: SourceElement, storageManager: StorageManager): TypeParameterDescriptorImpl =
            createForFurtherModification(containingDeclaration, annotations, reified, variance, name, index, source, null, SupertypeLoopChecker.EMPTY, storageManager)
        @kotlin.jvm.JvmStatic
        fun createForFurtherModification(containingDeclaration: DeclarationDescriptor, annotations: Annotations, reified: Boolean,
            variance: Variance, name: Name, index: Int, source: SourceElement, reportCycleError: ((KotlinType) -> Nothing?)?,
            supertypeLoopsResolver: SupertypeLoopChecker, storageManager: StorageManager): TypeParameterDescriptorImpl =
            TypeParameterDescriptorImpl(containingDeclaration, annotations, reified, variance, name, index, source, reportCycleError, supertypeLoopsResolver, storageManager)
    }
}
