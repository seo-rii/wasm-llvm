package org.jetbrains.kotlin.portable.descriptorvisitor.guard

private fun encode(value: String?): String =
    value?.map { it.code.toString(16).padStart(4, '0') }?.joinToString("") ?: "null"

/** Execute exact null-entry statements; full descriptor forwarding has a separate actual JVM observer. */
fun observeCheckedEntries(): String = buildString {
    for ((index, entry) in entryFunctions.withIndex()) {
        val owner = entryOwners[index]
        val result = try { entry(null); "return" } catch (error: NullPointerException) {
            (error::class.simpleName ?: "null") + "\t" + encode(error.message)
        }
        append("entry-check:").append(owner).append('\t').append(result).append('\n')
        // Common stdlib marker probes only the check's nonnull branch; it models no compiler class.
        entry(Any())
        append("entry-marker:").append(owner).append("\treturn\n")
    }
}
