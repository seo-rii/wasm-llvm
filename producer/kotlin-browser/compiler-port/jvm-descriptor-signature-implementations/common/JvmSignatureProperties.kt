/* Precisely typed synthetic getter bridges used only by these complete source ports. */
package org.jetbrains.kotlin.portable.jvmsignatures
import org.jetbrains.kotlin.builtins.PrimitiveType
import org.jetbrains.kotlin.name.FqName
import org.jetbrains.kotlin.resolve.jvm.JvmClassName
import org.jetbrains.kotlin.resolve.jvm.JvmPrimitiveType
val JvmClassName.internalName: String get() = getInternalName()
val JvmPrimitiveType.desc: String get() = getDesc()
val JvmPrimitiveType.primitiveType: PrimitiveType get() = getPrimitiveType()
val JvmPrimitiveType.wrapperFqName: FqName get() = getWrapperFqName()
