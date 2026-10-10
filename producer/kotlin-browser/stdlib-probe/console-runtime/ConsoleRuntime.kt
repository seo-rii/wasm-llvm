private var executions = 0

private fun reportLine(value: String) {
    println("${value.length}:" + value.map { it.code.toString(16) }.joinToString(","))
}

fun main() {
    when (readln()) {
        "lines" -> {
            while (true) reportLine(readlnOrNull() ?: break)
            check(readlnOrNull() == null)
            check(readlnOrNull() == null)
            try {
                readln()
                error("Expected EOF exception")
            } catch (e: RuntimeException) {
                println("eof:${e.message}")
            }
        }
        "unicode" -> {
            print("한글🙂λe\u0301\u0000\uFEFF")
            print("\uD800")
            print("\uDC00")
            println()
        }
        "stderr" -> {
            val failure = IllegalStateException("오류🙂", IllegalArgumentException("원인λ"))
            failure.addSuppressed(IllegalArgumentException("보조e\u0301"))
            failure.printStackTrace()
            println("stdout-after-stderr")
        }
        "caught" -> {
            var caught = 0
            try { "invalid".toInt() } catch (e: NumberFormatException) { caught++ }
            try { require(false) { "required" } } catch (e: IllegalArgumentException) { check(e.message == "required"); caught++ }
            try { error("state") } catch (e: IllegalStateException) { check(e.message == "state"); caught++ }
            println("caught:$caught")
        }
        "uncaught" -> {
            println("before-throw")
            throw IllegalStateException("unhandled-한🙂")
        }
        "limits" -> { println("α🙂"); print("xyz") }
        "state" -> println("state:${++executions}")
        "loop" -> { println("loop-started"); while (true) {} }
        else -> error("Unknown console probe mode")
    }
}
