fun fibonacci(n: Int): Long {
    require(n in 0..90)
    var previous = 0L
    var current = 1L
    repeat(n) {
        val next = previous + current
        previous = current
        current = next
    }
    return previous
}

fun main() {
    val n = readln().trim().toInt()
    println(fibonacci(n))
}
