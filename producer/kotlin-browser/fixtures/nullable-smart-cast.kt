fun describe(value: String?): String {
    if (value == null) return "none"
    return "${value.length}:${value.uppercase()}"
}

fun main() {
    println(describe(readlnOrNull()))
}
