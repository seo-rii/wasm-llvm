package org.jetbrains.kotlin.portable.positioningprobe

import com.intellij.openapi.util.TextRange

// Observe the real range contract used by the official algorithms.
fun rangeSnapshots(): List<Pair<String, String>> {
    val result = mutableListOf<Pair<String, String>>()
    fun record(id: String, action: () -> Any?) {
        result.add(id to try { "ok:${action()}" } catch (failure: Throwable) {
            val kind = when (failure) {
                is IllegalArgumentException -> "IllegalArgumentException"
                is IndexOutOfBoundsException -> "IndexOutOfBoundsException"
                else -> failure::class.simpleName
            }
            "$kind:${if (failure is IllegalArgumentException && failure !is IndexOutOfBoundsException) failure.message else ""}"
        })
    }
    record("empty") { "${TextRange.EMPTY_RANGE}:${TextRange.EMPTY_RANGE.isEmpty}:${TextRange.EMPTY_ARRAY.size}" }
    record("constructors") { "${TextRange(2, 7)}:${TextRange.from(2, 5)}:${TextRange.create(2, 7)}:${TextRange.allOf("한😀")}" }
    record("properties") { val r = TextRange(2, 7); "${r.startOffset}:${r.endOffset}:${r.length}:${r.isEmpty}:${r.hashCode()}:${r.isProperRange()}" }
    record("equality") { val r = TextRange(2, 7); "${r == TextRange(2, 7)}:${r == TextRange(2, 8)}:${r.equalsToRange(2, 7)}:${r.equals(null)}" }
    record("substring-utf16") { TextRange(1, 4).substring("A한😀Z") }
    record("subsequence") { TextRange(1, 4).subSequence("A한😀Z") }
    record("replace") { TextRange(1, 4).replace("A한😀Z", "B") }
    record("cut") { TextRange(2, 7).cutOut(TextRange(1, 4)) }
    record("cut-exceeds") { TextRange(2, 7).cutOut(TextRange(0, 6)) }
    record("shift-identity") { val r = TextRange(2, 7); "${r.shiftRight(0) === r}:${r.shiftLeft(0) === r}:${r.shiftRight(3)}:${r.shiftLeft(2)}" }
    record("grow") { TextRange(2, 7).grown(4) }
    record("grow-invalid") { TextRange(2, 7).grown(-6) }
    record("invalid-start") { TextRange(-1, 0) }
    record("invalid-order") { TextRange(7, 2) }
    record("invalid-overflow") { TextRange.from(Int.MAX_VALUE, 1) }
    record("assert-message") { TextRange.assertProperRange(5, 3, "guard") }
    record("out-of-bounds-substring") { TextRange(1, 9).substring("abc") }
    for (a in 0..4) for (b in a..5) for (c in 0..4) for (d in c..5) {
        val first = TextRange(a, b); val second = TextRange(c, d)
        record("pair/$a/$b/$c/$d") {
            "${first.contains(second)}:${first.containsRange(c, d)}:${TextRange.containsRange(first, second)}:" +
                "${first.intersects(second)}:${first.intersects(c, d)}:${first.intersectsStrict(second)}:${first.intersection(second)}:${first.union(second)}:" +
                "${TextRange.areSegmentsEqual(first, second)}:${first.contains(c)}:${first.containsOffset(c)}:" +
                "${first.intersection(second) === first}:${first.union(second) === first}"
        }
    }
    return result
}
