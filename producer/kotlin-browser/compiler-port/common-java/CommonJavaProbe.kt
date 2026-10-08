package org.jetbrains.kotlin.portable.commoncheck

import org.jetbrains.kotlin.descriptors.SourceElement
import org.jetbrains.kotlin.descriptors.SourceFile
import org.jetbrains.kotlin.renderer.KeywordStringsGenerated
import org.jetbrains.kotlin.resolve.calls.tasks.ExplicitReceiverKind
import org.jetbrains.kotlin.types.expressions.CoercionStrategy
import org.jetbrains.kotlin.serialization.deserialization.AnnotatedCallableKind
import org.jetbrains.kotlin.portable.common.*

fun observeCommonJava(): String {
    val result = ArrayList<String>()
    fun record(name: String, value: Any?) { result += "$name=$value" }
    record("noSourceText", SourceElement.NO_SOURCE.toString())
    record("sentinelIdentity", SourceElement.NO_SOURCE.getContainingFile() === SourceFile.NO_SOURCE_FILE)
    record("sentinelName", SourceFile.NO_SOURCE_FILE.getName())
    record("sourceProperty", SourceElement.NO_SOURCE.containingFile === SourceFile.NO_SOURCE_FILE)
    record("sourceFileProperty", SourceFile.NO_SOURCE_FILE.name)
    val file = object : SourceFile { override fun getName(): String = "한글.kt" }
    val source = object : SourceElement { override fun getContainingFile(): SourceFile = file }
    record("customFile", source.getContainingFile() === file)
    record("customName", source.containingFile.name)
    for (receiver in ExplicitReceiverKind.values()) {
        record("receiver.${receiver.name}", "${receiver.ordinal}:${receiver.isExtensionReceiver()}:${receiver.isDispatchReceiver()}")
        record("receiverProperty.${receiver.name}", "${receiver.isExtensionReceiver}:${receiver.isDispatchReceiver}")
        record("receiverValueOf.${receiver.name}", ExplicitReceiverKind.valueOf(receiver.name) === receiver)
    }
    for (value in CoercionStrategy.values()) record("coercion.${value.name}", "${value.ordinal}:${CoercionStrategy.valueOf(value.name) === value}")
    for (value in AnnotatedCallableKind.values()) record("callable.${value.name}", "${value.ordinal}:${AnnotatedCallableKind.valueOf(value.name) === value}")
    fun invalidValue(block: () -> Unit): Boolean = try { block(); false } catch (_: IllegalArgumentException) { true }
    record("invalidReceiver", invalidValue { ExplicitReceiverKind.valueOf("unknown") })
    record("invalidCoercion", invalidValue { CoercionStrategy.valueOf("unknown") })
    record("invalidCallable", invalidValue { AnnotatedCallableKind.valueOf("unknown") })
    val keywords = KeywordStringsGenerated.KEYWORDS
    val snapshot = keywords.toSet()
    record("keywords", keywords.sorted().joinToString())
    record("keywordCount", keywords.size)
    record("keywordMembers", listOf("fun", "typeof", "when", "foo", "FUN", "", "한글").map { it in keywords })
    record("keywordDuplicateAdd", keywords.add("fun"))
    record("keywordNewAdd", keywords.add("portable_test_keyword"))
    record("keywordNewMember", "portable_test_keyword" in keywords)
    record("keywordDelete", keywords.remove("portable_test_keyword"))
    record("keywordAbsentDelete", keywords.remove("portable_test_keyword"))
    val iterator = keywords.iterator()
    val removed = iterator.next(); iterator.remove()
    record("keywordIteratorRemoved", removed !in keywords)
    keywords.add(removed)
    record("keywordRestored", keywords == snapshot)
    return result.joinToString("\n")
}
