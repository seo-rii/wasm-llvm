package org.jetbrains.kotlin.portable.descriptorsignatures.entries

private fun hex(value: String?): String = value?.map { it.code.toString(16).padStart(4, '0') }?.joinToString("") ?: "null"
private fun outcome(action: () -> Unit): String = try { action(); "return" } catch (error: Throwable) { (error::class.simpleName ?: "null") + "\t" + hex(error.message) }

// Only the exact shipping entry checks. No compiler body or model follows them.
fun entry0(newOwner: Any?, modality: Any?, visibility: Any?, kind: Any?) {
    if (newOwner == null) throw NullPointerException("Parameter specified as non-null is null: method org.jetbrains.kotlin.ir.descriptors.IrBasedClassConstructorDescriptor.copy, parameter newOwner")
    if (modality == null) throw NullPointerException("Parameter specified as non-null is null: method org.jetbrains.kotlin.ir.descriptors.IrBasedClassConstructorDescriptor.copy, parameter modality")
    if (visibility == null) throw NullPointerException("Parameter specified as non-null is null: method org.jetbrains.kotlin.ir.descriptors.IrBasedClassConstructorDescriptor.copy, parameter visibility")
    if (kind == null) throw NullPointerException("Parameter specified as non-null is null: method org.jetbrains.kotlin.ir.descriptors.IrBasedClassConstructorDescriptor.copy, parameter kind")
}

// Only the exact shipping entry checks. No compiler body or model follows them.
fun entry1(newOwner: Any?, modality: Any?, visibility: Any?, kind: Any?) {
    if (newOwner == null) throw NullPointerException("Parameter specified as non-null is null: method org.jetbrains.kotlin.descriptors.impl.TypeAliasConstructorDescriptorImpl.copy, parameter newOwner")
    if (modality == null) throw NullPointerException("Parameter specified as non-null is null: method org.jetbrains.kotlin.descriptors.impl.TypeAliasConstructorDescriptorImpl.copy, parameter modality")
    if (visibility == null) throw NullPointerException("Parameter specified as non-null is null: method org.jetbrains.kotlin.descriptors.impl.TypeAliasConstructorDescriptorImpl.copy, parameter visibility")
    if (kind == null) throw NullPointerException("Parameter specified as non-null is null: method org.jetbrains.kotlin.descriptors.impl.TypeAliasConstructorDescriptorImpl.copy, parameter kind")
}

// Only the exact shipping entry checks. No compiler body or model follows them.
fun entry2(newOwner: Any?, modality: Any?, visibility: Any?, kind: Any?) {
    if (newOwner == null) throw NullPointerException("Parameter specified as non-null is null: method org.jetbrains.kotlin.types.error.ErrorFunctionDescriptor.copy, parameter newOwner")
    if (modality == null) throw NullPointerException("Parameter specified as non-null is null: method org.jetbrains.kotlin.types.error.ErrorFunctionDescriptor.copy, parameter modality")
    if (visibility == null) throw NullPointerException("Parameter specified as non-null is null: method org.jetbrains.kotlin.types.error.ErrorFunctionDescriptor.copy, parameter visibility")
    if (kind == null) throw NullPointerException("Parameter specified as non-null is null: method org.jetbrains.kotlin.types.error.ErrorFunctionDescriptor.copy, parameter kind")
}

// Only the exact shipping entry checks. No compiler body or model follows them.
fun entry3(key: Any?) {
    if (key == null) throw NullPointerException("Parameter specified as non-null is null: method org.jetbrains.kotlin.types.error.ErrorFunctionDescriptor.getUserData, parameter key")
}

fun observeDescriptorEntries(): String {
    val rows = mutableListOf<String>()
    val marker = Any()
    for (mask in 0..15) for (copyOverrides in listOf(false, true)) {
        var evaluated = ""
        fun argument(index: Int): Any? { evaluated += index; return if (mask and (1 shl index) == 0) marker else null }
        val label = "org.jetbrains.kotlin.ir.descriptors.IrBasedClassConstructorDescriptor:copy:" + mask + ":" + copyOverrides
        val a0 = argument(0); val a1 = argument(1); val a2 = argument(2); val a3 = argument(3)
        val observed = outcome { entry0(a0, a1, a2, a3) }
        rows += label + "\t" + observed
        rows += "evaluation:org.jetbrains.kotlin.ir.descriptors.IrBasedClassConstructorDescriptor:" + mask + ":" + copyOverrides + "\t" + evaluated
    }
    for (mask in 0..15) for (copyOverrides in listOf(false, true)) {
        var evaluated = ""
        fun argument(index: Int): Any? { evaluated += index; return if (mask and (1 shl index) == 0) marker else null }
        val label = "org.jetbrains.kotlin.descriptors.impl.TypeAliasConstructorDescriptorImpl:copy:" + mask + ":" + copyOverrides
        val a0 = argument(0); val a1 = argument(1); val a2 = argument(2); val a3 = argument(3)
        val observed = outcome { entry1(a0, a1, a2, a3) }
        rows += label + "\t" + observed
        rows += "evaluation:org.jetbrains.kotlin.descriptors.impl.TypeAliasConstructorDescriptorImpl:" + mask + ":" + copyOverrides + "\t" + evaluated
    }
    for (mask in 0..15) for (copyOverrides in listOf(false, true)) {
        var evaluated = ""
        fun argument(index: Int): Any? { evaluated += index; return if (mask and (1 shl index) == 0) marker else null }
        val label = "org.jetbrains.kotlin.types.error.ErrorFunctionDescriptor:copy:" + mask + ":" + copyOverrides
        val a0 = argument(0); val a1 = argument(1); val a2 = argument(2); val a3 = argument(3)
        val observed = outcome { entry2(a0, a1, a2, a3) }
        rows += label + "\t" + observed
        rows += "evaluation:org.jetbrains.kotlin.types.error.ErrorFunctionDescriptor:" + mask + ":" + copyOverrides + "\t" + evaluated
    }
    rows += "org.jetbrains.kotlin.types.error.ErrorFunctionDescriptor:userdata:0\t" + outcome { entry3(null) }
    rows += "org.jetbrains.kotlin.types.error.ErrorFunctionDescriptor:userdata:nonnull\t" + outcome { entry3(marker) }
    return rows.joinToString("\n", postfix = "\n")
}
