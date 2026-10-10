package org.jetbrains.kotlin.portable.visitorvoid.statements

private fun encode(value: String?): String = value?.map { it.code.toString(16).padStart(4, '0') }?.joinToString("") ?: "null"
private fun outcome(action: () -> Unit): String = try { action(); "return" } catch (error: Throwable) {
    (error::class.simpleName ?: "null") + "\t" + encode(error.message)
}

fun observeVoidStatements(): String = buildString {
    val marker = Any()
    val messages = listOf("", "plain", "한글", "\u0000", "\r\n", "\uD800", "\uDC00", "😀", "null", "visitor", "{ }", "\u2028", "java.lang.Void")
    for ((owner, body) in statementBodies) {
        append(owner).append(":null\t").append(outcome { marker.body(null) }).append('\n')
        for ((index, message) in messages.withIndex()) for (throws in listOf(false, true)) {
            var calls = 0
            val visitor: (Any, Nothing?) -> Nothing? = { descriptorMarker, nullableData ->
                check(descriptorMarker === marker && nullableData == null)
                calls++
                if (throws) throw IllegalArgumentException(message)
                null
            }
            val result = outcome { marker.body(visitor) }
            append(owner).append(':').append(index).append(':').append(throws).append('\t').append(result).append('\t').append(calls).append('\n')
        }
    }
}
