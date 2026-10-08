/* Observe actual selected version algorithms; no user-language parser or emitter. */
package org.jetbrains.kotlin.portable.versions.probe
import org.jetbrains.kotlin.config.KotlinCompilerVersion
import org.jetbrains.kotlin.config.MavenComparableVersion
import org.jetbrains.kotlin.tooling.core.*

private fun hex(text: String): String = text.map { it.code.toString(16).padStart(4, '0') }.joinToString("")
private fun fromCodePoint(ch: Int): String = if (ch < 0x10000) ch.toChar().toString() else
    (0xd800 + ((ch - 0x10000) ushr 10)).toChar().toString() + (0xdc00 + ((ch - 0x10000) and 0x3ff)).toChar()

fun versionSnapshot(): String {
    val output = StringBuilder()
    fun record(id: String, value: Any?) { output.append(id).append(':').append(value).append('\n') }

    // Exact changed mappings and exact identity count for all Unicode code points.
    var unchanged = 0
    for (ch in 0..0x10ffff) {
        val text = fromCodePoint(ch)
        val lowered = policyLower(text)
        if (lowered == text) unchanged++ else record("unicode-lower-$ch", hex(lowered))
    }
    record("unicode-lower-identity-count", unchanged)
    for (ch in 0..0xffff) {
        val digit = policyDigit(ch.toChar())
        if (digit >= 0) record("unicode-digit-$ch", digit)
    }
    // Every BMP char participates in three real final-Sigma contexts. Emit the
    // full result (no digest-only reduction of these public observations).
    for (pattern in 0..2) {
        val mask = StringBuilder(65536)
        for (ch in 0..0xffff) {
            val char = ch.toChar()
            val text = when (pattern) {
                0 -> "A\u03a3${char}A"
                1 -> "A${char}\u03a3"
                else -> "A\u03a3${char}\u03a3A"
            }
            val lowered = policyLower(text)
            val index = if (pattern == 1) 2 else 1
            mask.append(if (lowered[index] == '\u03c2') '1' else '0')
        }
        record("unicode-sigma-bmp-mask-$pattern", mask)
    }
    val unicode = listOf("I\u0130\u0131i", "\u039f\u03a3", "\u039f\u03a31\u0391", "\u039f\u03a3-\u0391", "\u039f\u03a3'\u0391",
        "A\u03a3\u0307A", "A\u03a3\uffffA", "A\ud801\udc00\u03a3", "A\u03a3\ud801\udc00", "\ud800\u03a3\udfff",
        "\u212a\u212b\u1e9e", "\u2c2f\ua7c0\ua7d0", "한글\u03a3한국어", "\u0391\u03a3\u0085\u0391")
    for ([index, text] in unicode.withIndex()) record("unicode-context-$index", hex(policyLower(text)))
    for ([index, text] in listOf("0", "-0", "+42", "2147483647", "2147483648", "-2147483648", "-2147483649", "", "+", "-",
        "\u0661\u0662\u0663", "\uff11\uff12\uff13", "\ud835\udfce", "\u00b2", " 1", "1\n", "000000000000000000001").withIndex()) record("unicode-int-$index", policyInt(text))

    val versions = mutableListOf("", ".", "-", "1", "1.0", "1.0.0", "1.0-0", "1.0-", "1.0-ga", "1.0-final", "1.0-FINAL",
        "1.0alpha1", "1.0a1", "1.0b1", "1.0m1", "1.0cr1", "1.0-rc1", "1.0-sp", "1.0-snapshot", "1.0--1", "1..2", "1.-2",
        "01.0002.0003", "1.0.alpha", "1.0-alpha", "1.0.foo", "1.0-foo", "1-1", "1.0.1", "1.0-foo1bar2", "1.0a", "1.0b", "1.0m",
        "1.0-ga-0-ga", "1.0-foo-ga-0", "1.0\u0661", "\u0661.\uff10.\u0660", "1.0-\u039f\u03a31\u0391", "1.0-\u0130", "1.0-\u2c2f", "1.0-\u1e9e",
        "1.0-x\u0000y", "1.0-\ud800", "1.0-\udfff", "1.0-\ud801\udc00")
    for (qualifier in listOf("alpha", "beta", "milestone", "rc", "snapshot", "", "sp", "ga", "final", "cr", "unknown", "z", "aa")) {
        versions.add("2.5-$qualifier")
        versions.add("2.5-${qualifier}1")
        versions.add("2.5-${qualifier}02-release-123")
    }
    versions.add("1." + "9".repeat(1024))
    versions.add("1.1" + "0".repeat(1024))
    versions.add("1." + "0".repeat(4096) + "1")
    versions.add("1." + "\u0669".repeat(1024))
    val parsed = versions.map { MavenComparableVersion(it) }
    for ([index, value] in parsed.withIndex()) record("maven-$index", hex(value.toString()) + "/" + hex(value.canonical) + "/" + value.hashCode())
    for (left in parsed.indices) for (right in parsed.indices) record("maven-compare-$left-$right", parsed[left].compareTo(parsed[right]).toString() + "/" + (parsed[left] == parsed[right]))
    val reparse = MavenComparableVersion("1.0-rc1")
    for ([index, value] in listOf("2.0-ga", "1..0--1", "1.0a1", "1", "0", "", "1." + "9".repeat(128)).withIndex()) {
        reparse.parseVersion(value)
        record("maven-reparse-$index", hex(reparse.toString()) + "/" + hex(reparse.canonical) + "/" + reparse.hashCode())
    }

    val tooling = mutableListOf("1.6", "1.6.20", "1.6.20.99", "1.6.20-", "1.6.20-SNAPSHOT", "1.6.20-snapshot", "1.6.20-dev-myWildcard21-510",
        "1.6.20-dev1", "1.6.20-M1", "1.6.20-m1", "1.6.20-RC1-123", "1.6.20-rc1-123", "1.6.20-rc", "1.6.20-rc1-release-123",
        "1.6.20-release-123", "1.6.20-123", "1.6.20-beta2-release-5", "1.6.20-alpha1", "1.6.20-M1-release-5", "1.6.20-foo\u0085123",
        "1.6.20-foo\n123", "1.6.20-foo\r123", "1.6.20-foo\u2028123", "1.6.20-foo\u2029123", "1.6.20-rc2147483648", "1.6.20-rc2147483647",
        "2147483647.1.0", "+1.+2.+3", "\u0661.\u0662.\u0663-rc1", "\uff11.\uff12.\uff13", "1.6.bad", "1.6.-1", "1.6.2147483648")
    for (classifier in listOf("alpha", "beta", "m", "rc", "dev", "snapshot", "ga", "RELEASE")) {
        tooling.add("2.5.0-$classifier")
        tooling.add("2.5.0-${classifier}1-release-123")
    }
    val tools = tooling.map { KotlinToolingVersion(it) }.toMutableList()
    tools.add(KotlinToolingVersion(Int.MIN_VALUE, 1, 0, "rc"))
    tools.add(KotlinToolingVersion(Int.MAX_VALUE, Int.MIN_VALUE, Int.MAX_VALUE, "rc2147483647"))
    for ([index, value] in tools.withIndex()) record("tooling-$index", hex(value.toString()) + "/${value.maturity}/${value.buildNumber}/${value.classifierNumber}/${value.hashCode()}/${value.isPreRelease}")
    for (left in tools.indices) for (right in tools.indices) record("tooling-compare-$left-$right", tools[left].compareTo(tools[right]).toString() + "/" + (tools[left] == tools[right]))
    for ([index, invalid] in listOf("", "1", "bad.1", "1.bad", "2147483648.1", "-1.2", "\ud835\udfce.1").withIndex()) {
        try { record("tooling-invalid-$index", KotlinToolingVersion(invalid)) }
        catch (error: IllegalArgumentException) { record("tooling-invalid-$index", hex(error.message.orEmpty())) }
    }
    val conversion = KotlinToolingVersion(KotlinVersion(1, 2, 3), "rc1")
    record("tooling-kotlin-version", conversion.toKotlinVersion())
    record("tooling-from-kotlin-version", KotlinVersion(1, 2, 3).toKotlinToolingVersion("rc1"))
    record("tooling-string-compare-left", "1.2.3".compareTo(conversion))
    record("tooling-string-compare-right", conversion.compareTo("1.2.3"))
    record("compiler-version-path", KotlinCompilerVersion.VERSION_FILE_PATH)
    record("compiler-version", KotlinCompilerVersion.VERSION)
    record("compiler-getVersion", KotlinCompilerVersion.getVersion())
    for ([index, value] in listOf(null, "", "true", "TRUE", "TrUe", " false ", "false", "1", " true", "true\n", "tr\u00fc e").withIndex()) {
        setTestPreReleaseOverride(value)
        record("compiler-test-preRelease-$index", KotlinCompilerVersion.isPreRelease())
    }
    setTestPreReleaseOverride(null)
    record("compiler-default-preRelease", KotlinCompilerVersion.isPreRelease())
    return output.toString()
}
