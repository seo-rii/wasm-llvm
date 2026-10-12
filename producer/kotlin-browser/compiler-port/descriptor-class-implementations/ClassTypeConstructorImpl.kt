/* Copyright 2010-2015 JetBrains s.r.o. Apache-2.0. */
package org.jetbrains.kotlin.types

import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.resolve.DescriptorUtils
import org.jetbrains.kotlin.storage.StorageManager

open class ClassTypeConstructorImpl(
    private val classDescriptor: ClassDescriptor, parameters: List<TypeParameterDescriptor>,
    private val supertypes: Collection<KotlinType>, storageManager: StorageManager,
) : AbstractClassTypeConstructor(storageManager), TypeConstructor {
    // A snapshot of parameters and a live view of the caller's supertypes, matching the Java carriers.
    private val parameters: List<TypeParameterDescriptor> = parameters.toList()
    override fun getParameters(): List<TypeParameterDescriptor> = parameters
    override fun toString(): String = DescriptorUtils.getFqName(classDescriptor).asString()
    override fun isDenotable(): Boolean = true
    override fun getDeclarationDescriptor(): ClassDescriptor = classDescriptor
    override fun computeSupertypes(): Collection<KotlinType> = supertypes
    override val supertypeLoopChecker: SupertypeLoopChecker get() = SupertypeLoopChecker.EMPTY
}
