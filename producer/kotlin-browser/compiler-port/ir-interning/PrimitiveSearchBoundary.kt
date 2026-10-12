package org.jetbrains.kotlin.portable.interning.probe

/** Proof-only equivalent of the unavailable Wasm IntArray.binarySearch default-range overload. */
fun IntArray.binarySearch(element: Int): Int {
    var low = 0
    var high = lastIndex
    while (low <= high) {
        val middle = (low + high) ushr 1
        val value = this[middle]
        when {
            value < element -> low = middle + 1
            value > element -> high = middle - 1
            else -> return middle
        }
    }
    return -low - 1
}
