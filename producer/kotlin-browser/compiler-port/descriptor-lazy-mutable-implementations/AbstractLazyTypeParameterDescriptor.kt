/* Copyright 2010-2015 JetBrains s.r.o. Apache-2.0. */
package org.jetbrains.kotlin.descriptors.impl

import org.jetbrains.kotlin.descriptors.DeclarationDescriptor
import org.jetbrains.kotlin.descriptors.SourceElement
import org.jetbrains.kotlin.descriptors.SupertypeLoopChecker
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.storage.StorageManager
import org.jetbrains.kotlin.types.Variance

abstract class AbstractLazyTypeParameterDescriptor(
    storageManager: StorageManager,
    containingDeclaration: DeclarationDescriptor,
    annotations: Annotations,
    name: Name,
    variance: Variance,
    isReified: Boolean,
    index: Int,
    source: SourceElement,
    supertypeLoopChecker: SupertypeLoopChecker,
) : AbstractTypeParameterDescriptor(
    storageManager, containingDeclaration, annotations, name, variance, isReified, index, source, supertypeLoopChecker,
) {
    // Preserve the original virtual-call order without forcing descriptor-renderer lazies.
    override fun toString(): String =
        (if (isReified()) "reified " else "") +
            (if (getVariance() == Variance.INVARIANT) "" else getVariance().toString() + " ") + getName()
}
