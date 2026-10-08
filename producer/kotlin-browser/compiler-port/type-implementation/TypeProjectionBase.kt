/*
 * Copyright 2010-2016 JetBrains s.r.o.
 * Licensed under the Apache License, Version 2.0.
 * Port of the selected official TypeProjectionBase.java; see sources.lock.json.
 */
package org.jetbrains.kotlin.types

abstract class TypeProjectionBase : TypeProjection {
    override fun toString(): String {
        if (isStarProjection()) return "*"
        if (getProjectionKind() == Variance.INVARIANT) return getType().toString()
        return getProjectionKind().toString() + " " + getType()
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is TypeProjection) return false
        if (isStarProjection() != other.isStarProjection()) return false
        if (getProjectionKind() != other.getProjectionKind()) return false
        if (getType() != other.getType()) return false
        return true
    }

    override fun hashCode(): Int {
        var result = getProjectionKind().hashCode()
        result = if (TypeUtils.noExpectedType(getType())) {
            31 * result + 19
        } else {
            31 * result + if (isStarProjection()) 17 else getType().hashCode()
        }
        return result
    }
}
