/* Copyright 2010-2015 JetBrains s.r.o. Apache-2.0. Complete pinned Java class translation. */
package org.jetbrains.kotlin.resolve.jvm

import org.jetbrains.kotlin.name.ClassId
import org.jetbrains.kotlin.name.FqName

open class JvmClassName private constructor(private val internalNameValue: String) {
    private var fqName: FqName? = null

    open fun getFqNameForClassNameWithoutDollars(): FqName {
        if (fqName == null) fqName = FqName(internalNameValue.replace('$', '.').replace('/', '.'))
        return fqName!!
    }
    open fun getFqNameForTopLevelClassMaybeWithDollars(): FqName = FqName(internalNameValue.replace('/', '.'))
    open fun getPackageFqName(): FqName {
        val lastSlash = internalNameValue.lastIndexOf('/')
        if (lastSlash == -1) return FqName.ROOT
        return FqName(internalNameValue.substring(0, lastSlash).replace('/', '.'))
    }
    open fun getInternalName(): String = internalNameValue
    override fun toString(): String = internalNameValue
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other == null || this::class != other::class) return false
        return internalNameValue == (other as JvmClassName).internalNameValue
    }
    override fun hashCode(): Int = internalNameValue.hashCode()

    companion object {
        @kotlin.jvm.JvmStatic fun byInternalName(internalName: String): JvmClassName = JvmClassName(internalName)
        @kotlin.jvm.JvmStatic fun byClassId(classId: ClassId): JvmClassName = JvmClassName(internalNameByClassId(classId))
        @kotlin.jvm.JvmStatic fun internalNameByClassId(classId: ClassId): String {
            val packageFqName = classId.packageFqName
            val relativeClassName = classId.relativeClassName.asString().replace('.', '$')
            return if (packageFqName.isRoot) relativeClassName else packageFqName.asString().replace('.', '/') + "/" + relativeClassName
        }
        @kotlin.jvm.JvmStatic fun byFqNameWithoutInnerClasses(fqName: FqName): JvmClassName {
            val result = JvmClassName(fqName.asString().replace('.', '/'))
            result.fqName = fqName
            return result
        }
        @kotlin.jvm.JvmStatic fun byFqNameWithoutInnerClasses(fqName: String): JvmClassName = byFqNameWithoutInnerClasses(FqName(fqName))
    }
}
