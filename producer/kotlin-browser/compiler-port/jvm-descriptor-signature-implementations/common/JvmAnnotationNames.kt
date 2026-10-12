/* Complete pinned Java constants class, with measured foreign class names. */
package org.jetbrains.kotlin.load.java
import org.jetbrains.kotlin.name.FqName
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.resolve.jvm.JvmClassName
import org.jetbrains.kotlin.portable.jvmsignatures.*
class JvmAnnotationNames private constructor() {
    companion object {
        @kotlin.jvm.JvmField val METADATA_FQ_NAME: FqName = FqName("kotlin.Metadata")
        @kotlin.jvm.JvmField val METADATA_DESC: String = "L" + JvmClassName.byFqNameWithoutInnerClasses(METADATA_FQ_NAME).getInternalName() + ";"
        const val METADATA_VERSION_FIELD_NAME: String = "mv"
        const val KIND_FIELD_NAME: String = "k"
        const val METADATA_DATA_FIELD_NAME: String = "d1"
        const val METADATA_STRINGS_FIELD_NAME: String = "d2"
        const val METADATA_EXTRA_STRING_FIELD_NAME: String = "xs"
        const val METADATA_PACKAGE_NAME_FIELD_NAME: String = "pn"
        const val METADATA_MULTIFILE_CLASS_NAME_FIELD_NAME: String = METADATA_EXTRA_STRING_FIELD_NAME
        const val METADATA_EXTRA_INT_FIELD_NAME: String = "xi"
        const val METADATA_MULTIFILE_PARTS_INHERIT_FLAG: Int = 1 shl 0
        const val METADATA_PRE_RELEASE_FLAG: Int = 1 shl 1
        const val METADATA_SCRIPT_FLAG: Int = 1 shl 2
        const val METADATA_STRICT_VERSION_SEMANTICS_FLAG: Int = 1 shl 3
        const val METADATA_JVM_IR_FLAG: Int = 1 shl 4
        const val METADATA_JVM_IR_STABLE_ABI_FLAG: Int = 1 shl 5
        const val METADATA_FIR_FLAG: Int = 1 shl 6
        const val METADATA_PUBLIC_ABI_FLAG: Int = 1 shl 7
        const val METADATA_SYNTHETIC_CLASS_VISIBILITY_BIT_FIRST: Int = 8
        const val METADATA_SYNTHETIC_CLASS_VISIBILITY_BIT_LAST: Int = 10
        @kotlin.jvm.JvmField val DEFAULT_ANNOTATION_MEMBER_NAME: Name = Name.identifier("value")
        @kotlin.jvm.JvmField val TARGET_ANNOTATION: FqName = FqName(JvmForeignClassCatalog.require(JvmForeignClassKey.ANNOTATION_TARGET).name)
        @kotlin.jvm.JvmField val ELEMENT_TYPE_ENUM: FqName = FqName(JvmForeignClassCatalog.require(JvmForeignClassKey.ANNOTATION_ELEMENTTYPE).name)
        @kotlin.jvm.JvmField val RETENTION_ANNOTATION: FqName = FqName(JvmForeignClassCatalog.require(JvmForeignClassKey.ANNOTATION_RETENTION).name)
        @kotlin.jvm.JvmField val RETENTION_POLICY_ENUM: FqName = FqName(JvmForeignClassCatalog.require(JvmForeignClassKey.ANNOTATION_RETENTIONPOLICY).name)
        @kotlin.jvm.JvmField val DEPRECATED_ANNOTATION: FqName = FqName(JvmForeignClassCatalog.require(JvmForeignClassKey.ANNOTATION_DEPRECATED).name)
        @kotlin.jvm.JvmField val DOCUMENTED_ANNOTATION: FqName = FqName(JvmForeignClassCatalog.require(JvmForeignClassKey.ANNOTATION_DOCUMENTED).name)
        @kotlin.jvm.JvmField val REPEATABLE_ANNOTATION: FqName = FqName("java.lang.annotation.Repeatable")
        @kotlin.jvm.JvmField val INHERITED_ANNOTATION: FqName = FqName("java.lang.annotation.Inherited")
        @kotlin.jvm.JvmField val OVERRIDE_ANNOTATION: FqName = FqName(JvmForeignClassCatalog.require(JvmForeignClassKey.ANNOTATION_OVERRIDE).name)
        @kotlin.jvm.JvmField val JETBRAINS_NOT_NULL_ANNOTATION: FqName = FqName("org.jetbrains.annotations.NotNull")
        @kotlin.jvm.JvmField val JETBRAINS_NULLABLE_ANNOTATION: FqName = FqName("org.jetbrains.annotations.Nullable")
        @kotlin.jvm.JvmField val JETBRAINS_MUTABLE_ANNOTATION: FqName = FqName("org.jetbrains.annotations.Mutable")
        @kotlin.jvm.JvmField val JETBRAINS_READONLY_ANNOTATION: FqName = FqName("org.jetbrains.annotations.ReadOnly")
        @kotlin.jvm.JvmField val JETBRAINS_UNMODIFIABLE_ANNOTATION: FqName = FqName("org.jetbrains.annotations.Unmodifiable")
        @kotlin.jvm.JvmField val JETBRAINS_UNMODIFIABLE_VIEW_ANNOTATION: FqName = FqName("org.jetbrains.annotations.UnmodifiableView")
        @kotlin.jvm.JvmField val READONLY_ANNOTATION: FqName = FqName("kotlin.annotations.jvm.ReadOnly")
        @kotlin.jvm.JvmField val MUTABLE_ANNOTATION: FqName = FqName("kotlin.annotations.jvm.Mutable")
        @kotlin.jvm.JvmField val PURELY_IMPLEMENTS_ANNOTATION: FqName = FqName("kotlin.jvm.PurelyImplements")
        @kotlin.jvm.JvmField val KOTLIN_JVM_INTERNAL: FqName = FqName("kotlin.jvm.internal")
        const val SOURCE_DEBUG_EXTENSION_DESC: String = "Lkotlin/jvm/internal/SourceDebugExtension;"
        @kotlin.jvm.JvmField val ENHANCED_NULLABILITY_ANNOTATION: FqName = FqName("kotlin.jvm.internal.EnhancedNullability")
        @kotlin.jvm.JvmField val ENHANCED_MUTABILITY_ANNOTATION: FqName = FqName("kotlin.jvm.internal.EnhancedMutability")
    }
}
