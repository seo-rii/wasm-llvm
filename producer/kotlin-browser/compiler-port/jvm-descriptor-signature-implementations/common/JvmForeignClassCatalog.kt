/* Measured finite metadata for genuine upstream foreign Class expressions; no Java class stand-ins. */
package org.jetbrains.kotlin.portable.jvmsignatures
enum class JvmForeignClassKey {
    CLASSID_CLASS,
    CLASSID_ATOMICINTEGER,
    CLASSID_ATOMICLONG,
    CLASSID_ATOMICBOOLEAN,
    CLASSID_ATOMICREFERENCE,
    CLASSID_ATOMICINTEGERARRAY,
    CLASSID_ATOMICLONGARRAY,
    CLASSID_ATOMICREFERENCEARRAY,
    CLASSID_VOID,
    TOPLEVEL_ANY,
    TOPLEVEL_STRING,
    TOPLEVEL_CHARSEQUENCE,
    TOPLEVEL_THROWABLE,
    TOPLEVEL_CLONEABLE,
    TOPLEVEL_NUMBER,
    TOPLEVEL_COMPARABLE,
    TOPLEVEL_ENUM,
    TOPLEVEL_ANNOTATION,
    MUTABILITY_ITERABLE,
    MUTABILITY_ITERATOR,
    MUTABILITY_COLLECTION,
    MUTABILITY_LIST,
    MUTABILITY_SET,
    MUTABILITY_LISTITERATOR,
    MUTABILITY_MAP,
    MUTABILITY_MAP_ENTRY,
    ANNOTATION_TARGET,
    ANNOTATION_ELEMENTTYPE,
    ANNOTATION_RETENTION,
    ANNOTATION_RETENTIONPOLICY,
    ANNOTATION_DEPRECATED,
    ANNOTATION_DOCUMENTED,
    ANNOTATION_OVERRIDE
}
class JvmForeignClassMetadata internal constructor(
    val name: String, val canonicalName: String, val simpleName: String,
    private val declaringClassName: String?, val isPrimitive: Boolean, val isArray: Boolean,
) {
    val declaringClass: JvmForeignClassMetadata? get() = declaringClassName?.let(JvmForeignClassCatalog::byName)
}
object JvmForeignClassCatalog {
    private val records: Map<JvmForeignClassKey, JvmForeignClassMetadata> = mapOf(
        JvmForeignClassKey.CLASSID_CLASS to JvmForeignClassMetadata("java.lang.Class", "java.lang.Class", "Class", null, false, false),
        JvmForeignClassKey.CLASSID_ATOMICINTEGER to JvmForeignClassMetadata("java.util.concurrent.atomic.AtomicInteger", "java.util.concurrent.atomic.AtomicInteger", "AtomicInteger", null, false, false),
        JvmForeignClassKey.CLASSID_ATOMICLONG to JvmForeignClassMetadata("java.util.concurrent.atomic.AtomicLong", "java.util.concurrent.atomic.AtomicLong", "AtomicLong", null, false, false),
        JvmForeignClassKey.CLASSID_ATOMICBOOLEAN to JvmForeignClassMetadata("java.util.concurrent.atomic.AtomicBoolean", "java.util.concurrent.atomic.AtomicBoolean", "AtomicBoolean", null, false, false),
        JvmForeignClassKey.CLASSID_ATOMICREFERENCE to JvmForeignClassMetadata("java.util.concurrent.atomic.AtomicReference", "java.util.concurrent.atomic.AtomicReference", "AtomicReference", null, false, false),
        JvmForeignClassKey.CLASSID_ATOMICINTEGERARRAY to JvmForeignClassMetadata("java.util.concurrent.atomic.AtomicIntegerArray", "java.util.concurrent.atomic.AtomicIntegerArray", "AtomicIntegerArray", null, false, false),
        JvmForeignClassKey.CLASSID_ATOMICLONGARRAY to JvmForeignClassMetadata("java.util.concurrent.atomic.AtomicLongArray", "java.util.concurrent.atomic.AtomicLongArray", "AtomicLongArray", null, false, false),
        JvmForeignClassKey.CLASSID_ATOMICREFERENCEARRAY to JvmForeignClassMetadata("java.util.concurrent.atomic.AtomicReferenceArray", "java.util.concurrent.atomic.AtomicReferenceArray", "AtomicReferenceArray", null, false, false),
        JvmForeignClassKey.CLASSID_VOID to JvmForeignClassMetadata("java.lang.Void", "java.lang.Void", "Void", null, false, false),
        JvmForeignClassKey.TOPLEVEL_ANY to JvmForeignClassMetadata("java.lang.Object", "java.lang.Object", "Object", null, false, false),
        JvmForeignClassKey.TOPLEVEL_STRING to JvmForeignClassMetadata("java.lang.String", "java.lang.String", "String", null, false, false),
        JvmForeignClassKey.TOPLEVEL_CHARSEQUENCE to JvmForeignClassMetadata("java.lang.CharSequence", "java.lang.CharSequence", "CharSequence", null, false, false),
        JvmForeignClassKey.TOPLEVEL_THROWABLE to JvmForeignClassMetadata("java.lang.Throwable", "java.lang.Throwable", "Throwable", null, false, false),
        JvmForeignClassKey.TOPLEVEL_CLONEABLE to JvmForeignClassMetadata("java.lang.Cloneable", "java.lang.Cloneable", "Cloneable", null, false, false),
        JvmForeignClassKey.TOPLEVEL_NUMBER to JvmForeignClassMetadata("java.lang.Number", "java.lang.Number", "Number", null, false, false),
        JvmForeignClassKey.TOPLEVEL_COMPARABLE to JvmForeignClassMetadata("java.lang.Comparable", "java.lang.Comparable", "Comparable", null, false, false),
        JvmForeignClassKey.TOPLEVEL_ENUM to JvmForeignClassMetadata("java.lang.Enum", "java.lang.Enum", "Enum", null, false, false),
        JvmForeignClassKey.TOPLEVEL_ANNOTATION to JvmForeignClassMetadata("java.lang.annotation.Annotation", "java.lang.annotation.Annotation", "Annotation", null, false, false),
        JvmForeignClassKey.MUTABILITY_ITERABLE to JvmForeignClassMetadata("java.lang.Iterable", "java.lang.Iterable", "Iterable", null, false, false),
        JvmForeignClassKey.MUTABILITY_ITERATOR to JvmForeignClassMetadata("java.util.Iterator", "java.util.Iterator", "Iterator", null, false, false),
        JvmForeignClassKey.MUTABILITY_COLLECTION to JvmForeignClassMetadata("java.util.Collection", "java.util.Collection", "Collection", null, false, false),
        JvmForeignClassKey.MUTABILITY_LIST to JvmForeignClassMetadata("java.util.List", "java.util.List", "List", null, false, false),
        JvmForeignClassKey.MUTABILITY_SET to JvmForeignClassMetadata("java.util.Set", "java.util.Set", "Set", null, false, false),
        JvmForeignClassKey.MUTABILITY_LISTITERATOR to JvmForeignClassMetadata("java.util.ListIterator", "java.util.ListIterator", "ListIterator", null, false, false),
        JvmForeignClassKey.MUTABILITY_MAP to JvmForeignClassMetadata("java.util.Map", "java.util.Map", "Map", null, false, false),
        JvmForeignClassKey.MUTABILITY_MAP_ENTRY to JvmForeignClassMetadata("java.util.Map\$Entry", "java.util.Map.Entry", "Entry", "java.util.Map", false, false),
        JvmForeignClassKey.ANNOTATION_TARGET to JvmForeignClassMetadata("java.lang.annotation.Target", "java.lang.annotation.Target", "Target", null, false, false),
        JvmForeignClassKey.ANNOTATION_ELEMENTTYPE to JvmForeignClassMetadata("java.lang.annotation.ElementType", "java.lang.annotation.ElementType", "ElementType", null, false, false),
        JvmForeignClassKey.ANNOTATION_RETENTION to JvmForeignClassMetadata("java.lang.annotation.Retention", "java.lang.annotation.Retention", "Retention", null, false, false),
        JvmForeignClassKey.ANNOTATION_RETENTIONPOLICY to JvmForeignClassMetadata("java.lang.annotation.RetentionPolicy", "java.lang.annotation.RetentionPolicy", "RetentionPolicy", null, false, false),
        JvmForeignClassKey.ANNOTATION_DEPRECATED to JvmForeignClassMetadata("java.lang.Deprecated", "java.lang.Deprecated", "Deprecated", null, false, false),
        JvmForeignClassKey.ANNOTATION_DOCUMENTED to JvmForeignClassMetadata("java.lang.annotation.Documented", "java.lang.annotation.Documented", "Documented", null, false, false),
        JvmForeignClassKey.ANNOTATION_OVERRIDE to JvmForeignClassMetadata("java.lang.Override", "java.lang.Override", "Override", null, false, false)
    )
    private val byBinaryName: Map<String, JvmForeignClassMetadata> = records.values.associateBy { it.name }
    fun require(key: JvmForeignClassKey): JvmForeignClassMetadata = records.getValue(key)
    internal fun byName(name: String): JvmForeignClassMetadata = byBinaryName.getValue(name)
}
