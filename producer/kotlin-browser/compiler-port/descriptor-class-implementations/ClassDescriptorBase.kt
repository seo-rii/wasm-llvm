/* Copyright 2010-2015 JetBrains s.r.o. Apache-2.0. */
package org.jetbrains.kotlin.descriptors.impl

import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.storage.StorageManager

abstract class ClassDescriptorBase protected constructor(
    storageManager: StorageManager, private val containingDeclaration: DeclarationDescriptor,
    name: Name, private val source: SourceElement, private val isExternal: Boolean,
) : AbstractClassDescriptor(storageManager, name) {
    override fun isExternal(): Boolean = isExternal
    override fun getContainingDeclaration(): DeclarationDescriptor = containingDeclaration
    override fun getSource(): SourceElement = source
}
