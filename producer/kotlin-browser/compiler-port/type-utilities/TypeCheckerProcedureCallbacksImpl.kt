/* Copyright 2010-2015 JetBrains s.r.o. Apache-2.0.
 * Exact selected callback bodies; false results are original type-check failure decisions. */
package org.jetbrains.kotlin.types.checker

import org.jetbrains.kotlin.types.KotlinType
import org.jetbrains.kotlin.types.TypeConstructor
import org.jetbrains.kotlin.types.TypeProjection

internal open class TypeCheckerProcedureCallbacksImpl : TypeCheckingProcedureCallbacks {
    override fun assertEqualTypes(a: KotlinType, b: KotlinType, typeCheckingProcedure: TypeCheckingProcedure): Boolean = typeCheckingProcedure.equalTypes(a, b)
    override fun assertEqualTypeConstructors(a: TypeConstructor, b: TypeConstructor): Boolean = a == b
    override fun assertSubtype(subtype: KotlinType, supertype: KotlinType, typeCheckingProcedure: TypeCheckingProcedure): Boolean = typeCheckingProcedure.isSubtypeOf(subtype, supertype)
    override fun capture(type: KotlinType, typeProjection: TypeProjection): Boolean = false
    override fun noCorrespondingSupertype(subtype: KotlinType, supertype: KotlinType): Boolean = false
}
