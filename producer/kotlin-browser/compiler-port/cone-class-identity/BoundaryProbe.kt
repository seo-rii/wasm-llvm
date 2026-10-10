package org.jetbrains.kotlin.portable.coneclassidentity.boundary

/** Explicit probe payloads, outside the compiler package and absent from every shipping source list. */
class IdentityPayload(val label: Int) { override fun hashCode(): Int = label }
data class ValuePayload(val label: Int)

fun boundarySnapshot(): String {
    val output = StringBuilder()
    fun record(id: String, value: Any?) { output.append(id).append('\t').append(value).append('\n') }
    val identity = IdentityPayload(19); val a = ValuePayload(1); val b = ValuePayload(2)
    val captured = ConeCapturedType(constructor = identity)
    val values: List<Any?> = listOf(
        captured, captured, ConeCapturedType(constructor = identity), ConeCapturedType(true, identity),
        ConeCapturedType(constructor = identity, attributes = "ignored"), ConeCapturedType(constructor = IdentityPayload(19)),
        ConeIntersectionType(listOf(a, b)), ConeIntersectionType(listOf(a, b), b), ConeIntersectionType(listOf(b, a)),
        ConeIntersectionType(setOf(a, b)), ConeIntersectionType(emptyList()), ConeIntersectionType(emptySet()),
        ConeUnionType(a, listOf(a, b)), ConeUnionType(a, listOf(a, b), "ignored"), ConeUnionType(b, listOf(a, b)),
        ConeUnionType(a, listOf(b, a)), ConeUnionType(a, listOf(a, a)),
        identity, a, null, "unrelated", 19,
    )
    for ([i, value] in values.withIndex()) {
        val first = value.hashCode()
        record("hash-$i", first)
        record("hash-stable-$i", (0 until 16).all { first == value.hashCode() })
        for ([j, other] in values.withIndex()) {
            record("equal-$i-$j", value == other)
            record("equal-hash-$i-$j", value != other || value.hashCode() == other.hashCode())
        }
    }
    check(captured.equals(values[4])); check(!captured.equals(values[3])); check(!captured.equals(values[5]))
    check(values[6]!!.equals(values[7])); check(!values[6]!!.equals(values[8])); check(!values[6]!!.equals(values[9]))
    check(values[12]!!.equals(values[13])); check(!values[12]!!.equals(values[14])); check(!values[12]!!.equals(values[15]))
    for (value in values.take(17)) {
        check(!value!!.equals(null)); check(!value.equals(a)); check(!value.equals(identity)); check(!value.equals("unrelated"))
    }
    record("boundary-contracts", true)
    return output.toString()
}

