/* Copyright 2010-2016 JetBrains s.r.o. Apache-2.0. */
package org.jetbrains.kotlin.types

import org.jetbrains.kotlin.builtins.KotlinBuiltIns
import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.resolve.descriptorUtil.builtIns
import org.jetbrains.kotlin.storage.StorageManager
import org.jetbrains.kotlin.utils.SmartList

abstract class AbstractClassTypeConstructor(storageManager: StorageManager) : AbstractTypeConstructor(storageManager), TypeConstructor {
    abstract override fun getDeclarationDescriptor(): ClassDescriptor
    final override fun isFinal(): Boolean {
        val descriptor = getDeclarationDescriptor()
        return descriptor.isFinalClass && !descriptor.isExpect()
    }
    override fun getBuiltIns(): KotlinBuiltIns = getDeclarationDescriptor().builtIns
    override fun isSameClassifier(classifier: ClassifierDescriptor): Boolean = classifier is ClassDescriptor && areFqNamesEqual(getDeclarationDescriptor(), classifier)
    override fun getAdditionalNeighboursInSupertypeGraph(useCompanions: Boolean): Collection<KotlinType> {
        val containing = getDeclarationDescriptor().getContainingDeclaration()
        if (containing !is ClassDescriptor) return emptyList()
        val result = SmartList<KotlinType>(); result.add(containing.getDefaultType())
        val companion = containing.getCompanionObjectDescriptor()
        if (useCompanions && companion != null) result.add(companion.getDefaultType())
        return result
    }
    override fun defaultSupertypeIfEmpty(): KotlinType? =
        if (KotlinBuiltIns.isSpecialClassWithNoSupertypes(getDeclarationDescriptor())) null else getBuiltIns().anyType
}
