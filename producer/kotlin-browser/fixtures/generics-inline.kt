inline fun <reified T> keep(values: List<Any?>): List<T> = values.filterIsInstance<T>()

data class PairValue<T>(val left: T, val right: T)

fun main() {
    val selected = keep<Int>(listOf(3, "x", null, 1)).sorted()
    val pair = PairValue(selected.first(), selected.last())
    println("${pair.left}:${pair.right}")
}
