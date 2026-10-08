fun main() {
    val lines = generateSequence(::readlnOrNull).toList()
    println(lines.joinToString("|"))
}
