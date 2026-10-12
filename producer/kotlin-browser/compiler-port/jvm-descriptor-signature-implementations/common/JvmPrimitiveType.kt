/* Copyright 2010-2015 JetBrains s.r.o. Apache-2.0. Complete pinned Java enum translation. */
package org.jetbrains.kotlin.resolve.jvm

import org.jetbrains.kotlin.builtins.PrimitiveType
import org.jetbrains.kotlin.name.FqName

enum class JvmPrimitiveType(
    private val primitiveTypeValue: PrimitiveType,
    private val keywordName: String,
    private val descValue: String,
    wrapperClassName: String,
) {
    BOOLEAN(PrimitiveType.BOOLEAN, "boolean", "Z", "java.lang.Boolean"),
    CHAR(PrimitiveType.CHAR, "char", "C", "java.lang.Character"),
    BYTE(PrimitiveType.BYTE, "byte", "B", "java.lang.Byte"),
    SHORT(PrimitiveType.SHORT, "short", "S", "java.lang.Short"),
    INT(PrimitiveType.INT, "int", "I", "java.lang.Integer"),
    FLOAT(PrimitiveType.FLOAT, "float", "F", "java.lang.Float"),
    LONG(PrimitiveType.LONG, "long", "J", "java.lang.Long"),
    DOUBLE(PrimitiveType.DOUBLE, "double", "D", "java.lang.Double");

    private val wrapperFqNameValue = FqName(wrapperClassName)
    fun getPrimitiveType(): PrimitiveType = primitiveTypeValue
    fun getJavaKeywordName(): String = keywordName
    fun getDesc(): String = descValue
    fun getWrapperFqName(): FqName = wrapperFqNameValue

    companion object {
        private val TYPE_BY_NAME = HashMap<String, JvmPrimitiveType>()
        // The original private EnumMap is used only for put/get; enum key equality is retained.
        private val TYPE_BY_PRIMITIVE_TYPE = HashMap<PrimitiveType, JvmPrimitiveType>()
        private val TYPE_BY_DESC = HashMap<String, JvmPrimitiveType>()
        private val WRAPPER_CLASS_INTERNAL_NAMES = HashSet<String>()
        private val OWNER_TO_BOXING_METHOD_DESCRIPTOR = HashMap<String, String>()
        init {
            for (type in values()) {
                TYPE_BY_NAME[type.getJavaKeywordName()] = type
                TYPE_BY_PRIMITIVE_TYPE[type.getPrimitiveType()] = type
                TYPE_BY_DESC[type.getDesc()] = type
                val internalName = type.wrapperFqNameValue.asString().replace('.', '/')
                WRAPPER_CLASS_INTERNAL_NAMES.add(internalName)
                OWNER_TO_BOXING_METHOD_DESCRIPTOR[internalName] = "(" + type.descValue + ")L" + internalName + ";"
            }
        }
        @kotlin.jvm.JvmStatic fun isWrapperClassInternalName(internalName: String): Boolean = WRAPPER_CLASS_INTERNAL_NAMES.contains(internalName)
        @kotlin.jvm.JvmStatic fun isBoxingMethodDescriptor(owner: String, methodDescriptor: String): Boolean = methodDescriptor == OWNER_TO_BOXING_METHOD_DESCRIPTOR[owner]
        @kotlin.jvm.JvmStatic fun get(name: String): JvmPrimitiveType = TYPE_BY_NAME[name] ?: throw AssertionError("Non-primitive type name passed: " + name)
        @kotlin.jvm.JvmStatic fun get(type: PrimitiveType): JvmPrimitiveType = TYPE_BY_PRIMITIVE_TYPE[type]!!
        @kotlin.jvm.JvmStatic fun getByDesc(desc: String): JvmPrimitiveType? = TYPE_BY_DESC[desc]
    }
}
