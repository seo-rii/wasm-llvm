package org.jetbrains.kotlin.portable.typecontracts.probe

import org.jetbrains.kotlin.builtins.DefaultBuiltIns
import org.jetbrains.kotlin.builtins.PlatformToKotlinClassMapper
import org.jetbrains.kotlin.portable.descriptors.*
import org.jetbrains.kotlin.types.TypeConstructor
import org.jetbrains.kotlin.types.TypeProjection
import org.jetbrains.kotlin.types.TypeProjectionImpl
import org.jetbrains.kotlin.types.Variance
import org.jetbrains.kotlin.types.checker.KotlinTypeChecker
import org.jetbrains.kotlin.types.checker.NewKotlinTypeChecker

// Genuine reference compiler objects bind the common interfaces; this is not a compiler host.
fun main() {
    val builtins = DefaultBuiltIns.Instance
    val constructor: TypeConstructor = builtins.intType.constructor
    check(constructor.parameters == constructor.getParameters())
    check(constructor.supertypes == constructor.getSupertypes())
    check(constructor.builtIns === constructor.getBuiltIns())
    check(constructor.declarationDescriptor === constructor.getDeclarationDescriptor())
    val projection: TypeProjection = TypeProjectionImpl(builtins.intType)
    check(projection.type === projection.getType())
    check(projection.projectionKind == Variance.INVARIANT)
    check(projection.isStarProjection == projection.isStarProjection())
    check(PlatformToKotlinClassMapper.Default().mapPlatformClass(builtins.any).isEmpty())
    val checker = KotlinTypeChecker.DEFAULT
    check(checker === NewKotlinTypeChecker.Default)
    check(checker.equalTypes(builtins.intType, builtins.intType))
    check(!checker.equalTypes(builtins.intType, builtins.longType))
    check(checker.isSubtypeOf(builtins.intType, builtins.anyType))
    check(!checker.isSubtypeOf(builtins.anyType, builtins.intType))
    println("seven typed aliases; genuine mapper default; original checker delegation and four relations: pass")
}
