/*
 * Copyright 2010-2015 JetBrains s.r.o.
 * Licensed under the Apache License, Version 2.0.
 * Port of the selected official TypeProjectionImpl.java; see sources.lock.json.
 */
package org.jetbrains.kotlin.types

import org.jetbrains.kotlin.types.checker.KotlinTypeRefiner

open class TypeProjectionImpl(
    private val projectionValue: Variance,
    private val typeValue: KotlinType,
) : TypeProjectionBase() {
    constructor(type: KotlinType) : this(Variance.INVARIANT, type)

    override fun replaceType(type: KotlinType): TypeProjectionBase = TypeProjectionImpl(projectionValue, type)
    override fun getProjectionKind(): Variance = projectionValue
    override fun getType(): KotlinType = typeValue
    override fun isStarProjection(): Boolean = false

    @TypeRefinement
    override fun refine(kotlinTypeRefiner: KotlinTypeRefiner): TypeProjection =
        TypeProjectionImpl(projectionValue, kotlinTypeRefiner.refineType(typeValue))
}
