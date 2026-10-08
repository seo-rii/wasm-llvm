fun main() {
    val items = listOf(2, 4)
    try {
        println(items[5])
    } catch (error: IndexOutOfBoundsException) {
        println("caught")
    }
    println(items.sum())
}
