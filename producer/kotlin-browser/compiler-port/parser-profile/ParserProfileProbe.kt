package org.jetbrains.kotlin.portable.parserprofile.probe

import org.jetbrains.kotlin.fir.lightTree.converter.requireMultiplatformParser

private fun String.units(): String = map { it.code.toString(16).padStart(4, '0') }.joinToString(":")

/** Observer shared by the exact original Java method slice, portable JVM, and Wasm. */
fun parserProfileProbe(): String {
    val inputs = listOf("", "a", "`", "``", "```", "`a`", "`a", "a`", "a`b", "a`b`", "`a`b",
        "`a``b`", "`a.b`", "`한글`", "`😀`", "`\uD83D`", "`\uDE00`", "`\u0000`", "`\uFFFF`",
        "`\r\n`", "`\uFEFF`", "` leading `", "`" + "한".repeat(1000) + "`", "한😀\r\n")
    val cases = inputs.mapIndexed { index, input ->
        val result = unquoteForProbe(input)
        "$index|${input.units()}|${result.units()}"
    }
    var utf16Digest = 0
    var utf16Cases = 0
    fun observe(input: String) {
        val result = unquoteForProbe(input)
        utf16Digest = 31 * utf16Digest + result.length
        for (unit in result) utf16Digest = 31 * utf16Digest + unit.code
        utf16Cases++
    }
    for (code in 0..65535) {
        val unit = code.toChar().toString()
        observe(unit)
        observe("`$unit`")
        observe("a${unit}b")
        observe("`$unit")
        observe("$unit`")
    }
    requireMultiplatformParser(true)
    var rejected = false
    try {
        requireMultiplatformParser(false)
    } catch (error: IllegalArgumentException) {
        check(error.message == "The browser compiler profile requires the official multiplatform parser")
        rejected = true
    }
    check(rejected)
    return "{\"identifierCases\":[" + cases.joinToString(",") { "\"$it\"" } +
        "],\"utf16Cases\":$utf16Cases,\"utf16Digest\":$utf16Digest," +
        "\"selectionGuard\":{\"acceptedTrue\":true,\"rejectedFalse\":true},\"resolvedFir\":\"not-run\"}"
}
