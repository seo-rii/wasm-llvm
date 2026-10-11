/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.util.portable

/** Host operations used by the genuine performance manager and its report renderers.
 *
 * Install for one synchronous compiler request in one Worker. Callbacks must not suspend
 * or reenter compilation. There are deliberately no clocks, metrics or filesystem defaults.
 * A null compilation provider and an empty collector list mean those facilities are absent.
 * CPU/user values and enabling failures have the provider's semantics (including -1 for
 * unsupported measurements); the compiler must not substitute fabricated zero timings.
 */
interface PerformanceManagerHost {
    fun currentTimeMillis(): Long
    fun currentWorker(): Any
    fun threadMeasurements(): PerformanceThreadMeasurements
    fun compilationMeasurements(): PerformanceCompilationMeasurements?
    fun garbageCollectors(): List<PerformanceGarbageCollector>
    val pathSeparator: Char
    fun isDirectory(path: String): Boolean
    fun pathExtension(path: String): String
    fun writeBytes(path: String, bytes: ByteArray)
    /** Match Java Formatter's pattern/argument semantics; english selects Locale.ENGLISH. */
    fun format(pattern: String, english: Boolean, arguments: Array<out Any?>): String
    /** Capture locale/timezone at creation, as SimpleDateFormat does. */
    fun dateFormatter(kind: PerformanceDateFormat): PerformanceDateFormatter
}

interface PerformanceThreadMeasurements {
    var isThreadCpuTimeEnabled: Boolean
    val currentThreadUserTime: Long
    val currentThreadCpuTime: Long
}
interface PerformanceCompilationMeasurements { val totalCompilationTime: Long }
interface PerformanceGarbageCollector {
    val name: String
    val collectionTime: Long
    val collectionCount: Long
}
enum class PerformanceDateFormat {
    /** yyyy-MM-dd-HH-mm-ss, host default locale and timezone. */
    FileName,
    /** yyyy-MM-dd'T'HH:mm:ss, English locale and UTC. */
    Markdown,
}
fun interface PerformanceDateFormatter { fun format(timeStampMs: Long): String }

private var installedPerformanceManagerHost: PerformanceManagerHost? = null

fun performanceManagerHost(): PerformanceManagerHost = requireNotNull(installedPerformanceManagerHost) {
    "Performance manager host is not installed for this request"
}

fun <T> withPerformanceManagerHost(host: PerformanceManagerHost, block: () -> T): T {
    val previous = installedPerformanceManagerHost
    installedPerformanceManagerHost = host
    try { return block() } finally { installedPerformanceManagerHost = previous }
}

fun String.performanceFormat(vararg arguments: Any?): String = performanceManagerHost().format(this, false, arguments)
fun String.performanceFormatEnglish(vararg arguments: Any?): String = performanceManagerHost().format(this, true, arguments)

/** Kotlin/JVM's default UTF-8 encoder replaces an isolated UTF-16 surrogate with '?'. */
fun String.performanceReportBytes(): ByteArray = buildString(length) {
    var index = 0
    while (index < this@performanceReportBytes.length) {
        val char = this@performanceReportBytes[index++]
        if (char in '\uD800'..'\uDBFF') {
            if (index < this@performanceReportBytes.length && this@performanceReportBytes[index] in '\uDC00'..'\uDFFF') {
                append(char); append(this@performanceReportBytes[index++])
            } else append('?')
        } else if (char in '\uDC00'..'\uDFFF') append('?') else append(char)
    }
}.encodeToByteArray()
