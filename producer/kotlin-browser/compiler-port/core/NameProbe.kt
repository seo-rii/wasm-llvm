package org.jetbrains.kotlin.portable.nameprobe

import org.jetbrains.kotlin.name.Name

private fun String.codeUnits(): String = map { it.code.toString(16).padStart(4, '0') }.joinToString(":")

private fun observe(block: () -> String?): String = try {
    block()?.let { "ok:" + it.codeUnits() } ?: "null"
} catch (error: Throwable) {
    when (error) {
        is IndexOutOfBoundsException -> "error:index-out-of-bounds"
        is IllegalStateException -> "error:illegal-state:" + error.message.orEmpty().codeUnits()
        is IllegalArgumentException -> "error:illegal-argument:" + error.message.orEmpty().codeUnits()
        else -> throw error
    }
}

/** Same observer source compiles against original Java, portable JVM and Wasm. */
fun nameProbe(): String {
    val inputs = listOf("", "a", "aa", "b", "Z", "한글", "😀", "\uD83D", "\uDE00", "\u0000", "\uFFFF",
        " leading", "has space", "<x>", "<", "<>", "<x", "x>", "x.y", "x/y", "x;y", "x[y", "x<y", "`quoted`",
        "Aa", "BB", "a\u0000b", "\r\n", "\uFEFF", "𝄞", "a".repeat(1000), "\uFFFF".repeat(1000))
    val cases = inputs.mapIndexed { index, text ->
        val identifier = Name.identifier(text)
        val guessed = Name.guessByFirstCharacter(text)
        val valid = Name.identifierIfValid(text)
        check(identifier.identifier == identifier.getIdentifier())
        check(identifier.isSpecial == identifier.isSpecial())
        check(guessed.identifierOrNullIfSpecial == guessed.getIdentifierOrNullIfSpecial())
        val other = Name.identifier(text)
        listOf(index.toString(), text.codeUnits(), Name.isValidIdentifier(text).toString(),
            observe { valid?.asString() }, identifier.isSpecial.toString(), identifier.hashCode().toString(),
            (identifier == other).toString(), (identifier == guessed).toString(), (identifier == null).toString(),
            (identifier.equals(text)).toString(), guessed.isSpecial.toString(), guessed.hashCode().toString(),
            observe { guessed.identifier }, observe { guessed.asStringStripSpecialMarkers() },
            observe { guessed.getIdentifierOrNullIfSpecial() }, observe { Name.special(text).asString() }).joinToString("|")
    }
    var orderingDigest = 0
    var orderingCases = 0
    for (left in inputs) for (right in inputs) {
        orderingDigest = 31 * orderingDigest + Name.identifier(left).compareTo(Name.guessByFirstCharacter(right))
        orderingCases++
    }
    var utf16Digest = 0
    for (code in 0..65535) {
        val text = code.toChar().toString()
        val name = Name.identifier(text)
        check(name.asString() == text && name.identifier == text && !name.isSpecial)
        utf16Digest = 31 * utf16Digest + if (Name.isValidIdentifier(text)) 1 else 0
        utf16Digest = 31 * utf16Digest + name.hashCode()
        utf16Digest = 31 * utf16Digest + name.compareTo(Name.identifier("a"))
    }
    val collisionA = Name.identifier("Aa")
    val collisionB = Name.identifier("BB")
    check(collisionA.hashCode() == collisionB.hashCode() && collisionA != collisionB)
    val ordinarySpecialText = Name.identifier("<x>")
    val special = Name.special("<x>")
    check(ordinarySpecialText.compareTo(special) == 0 && ordinarySpecialText != special)
    check(special.hashCode() == ordinarySpecialText.hashCode() + 1)
    return "{\"cases\":[" + cases.joinToString(",") { "\"" + it + "\"" } +
        "],\"orderingCases\":" + orderingCases + ",\"orderingDigest\":" + orderingDigest +
        ",\"utf16Cases\":65536,\"utf16Digest\":" + utf16Digest + ",\"collisionGuards\":true}"
}
