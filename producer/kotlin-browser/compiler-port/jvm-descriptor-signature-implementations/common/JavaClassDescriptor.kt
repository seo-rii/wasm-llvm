/* Copyright 2010-2015 JetBrains s.r.o. Apache-2.0. Complete pinned Java interface. */
package org.jetbrains.kotlin.load.java.descriptors
import org.jetbrains.kotlin.descriptors.ClassDescriptor
import org.jetbrains.kotlin.mpp.MppJavaImplicitActualizatorMarker
interface JavaClassDescriptor : ClassDescriptor, MppJavaImplicitActualizatorMarker {
    fun isRecord(): Boolean
}
