/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.util.portable.probe

import org.jetbrains.kotlin.platform.*
import org.jetbrains.kotlin.stats.*
import org.jetbrains.kotlin.util.*
import org.jetbrains.kotlin.util.portable.*

internal class ProbeFault : Exception("host fault")
internal class Collector(override val name: String, var millis: Long, var count: Long) : PerformanceGarbageCollector {
    override val collectionTime get() = millis
    override val collectionCount get() = count
}
internal class ProbeHost : PerformanceManagerHost {
    var nanos = 0L
    var wall = 1_700_000_000_123L
    var user = 0L
    var cpu = 0L
    var jit = 10L
    var jitAvailable = true
    var enabled = false
    var reads = 0
    var enableCalls = 0
    var writeFault: ProbeFault? = null
    var cpuFault: ProbeFault? = null
    var worker: Any = Any()
    val z = Collector("zeta", 31, 4)
    val a = Collector("alpha", 17, 2)
    var collectors: List<PerformanceGarbageCollector> = listOf(z, a)
    val writes = mutableListOf<Pair<String, ByteArray>>()
    fun advance(n: Long) { nanos += n; user += n * 2; cpu += n * 3 }
    fun monotonic(): Long { reads++; return nanos }
    override fun currentTimeMillis() = wall
    override fun currentWorker(): Any = worker
    override fun threadMeasurements() = object : PerformanceThreadMeasurements {
        override var isThreadCpuTimeEnabled: Boolean
            get() = enabled
            set(value) { cpuFault?.let { throw it }; enableCalls++; enabled = value }
        override val currentThreadUserTime get() = user
        override val currentThreadCpuTime get() = cpu
    }
    override fun compilationMeasurements(): PerformanceCompilationMeasurements? = if (!jitAvailable) null else object : PerformanceCompilationMeasurements {
        override val totalCompilationTime get() = jit
    }
    override fun garbageCollectors() = collectors
    override val pathSeparator = '/'
    override fun isDirectory(path: String) = path == "reports" || path == "reports/"
    override fun pathExtension(path: String) = path.substringAfterLast('/').substringAfterLast('.', "")
    override fun writeBytes(path: String, bytes: ByteArray) { writeFault?.let { throw it }; writes.add(path to bytes) }
    override fun format(pattern: String, english: Boolean, arguments: Array<out Any?>) = hostFormat(pattern, english, arguments)
    override fun dateFormatter(kind: PerformanceDateFormat) = hostDateFormatter(kind)
}

internal fun oracleKey(pattern: String, english: Boolean, args: Array<out Any?>): String =
    "$english:$pattern:" + args.joinToString("|") { value -> when (value) {
        is Double -> "double:${value.toBits()}"
        is Long -> "long:$value"
        is Int -> "int:$value"
        is String -> "string:${value.length}:$value"
        null -> "null"
        else -> error("Unexpected formatting argument")
    } }

private val wasmPlatform = object : WasmPlatform("Wasm") {}.toTargetPlatform()
private val jsPlatform = object : JsPlatform() {}.toTargetPlatform()
private fun manager(host: ProbeHost, detailed: Boolean = true, platform: TargetPlatform = wasmPlatform): PerformanceManagerImpl =
    PerformanceManagerImpl(platform, "Kotlin probe").also {
        it.targetDescription = "probe"; it.outputKind = "klib"; it.detailedPerf = detailed; it.addSourcesStats(2, 120)
    }

@OptIn(DeprecatedMeasurementForBackCompatibility::class, PotentiallyIncorrectPhaseTimeMeasurement::class)
fun observePerformanceManager(): String = buildString {
    fun record(label: String, value: Any?) { append(label).append(':').append(value).append('\n') }
    fun stats(label: String, value: UnitStats) { record(label, UnitStatsJsonDumper.dump(value)) }
    fun bytes(value: ByteArray) = value.joinToString(",") { (it.toInt() and 255).toString() }
    val missing = try { performanceManagerHost(); false } catch (error: IllegalArgumentException) {
        error.message == "Performance manager host is not installed for this request"
    }
    check(missing); record("missingHost", missing)
    val h = ProbeHost()
    val fault = ProbeFault()
    withPerformanceCounterClock(h::monotonic) {
        withPerformanceManagerHost(h) {
            check(performanceManagerHost() === h)
            val nested = ProbeHost()
            check(withPerformanceManagerHost(nested) { performanceManagerHost() } === nested)
            try { withPerformanceManagerHost(nested) { throw fault } } catch (error: ProbeFault) { check(error === fault) }
            check(performanceManagerHost() === h); record("hostRestored", true)
            val broken = ProbeHost().also { it.cpuFault = fault }
            try { withPerformanceManagerHost(broken) { manager(broken) }; error("missing CPU enable failure") }
            catch (error: ProbeFault) { check(error === fault) }
            check(performanceManagerHost() === h)
            record("cpuEnableFailure", true)
            val p = manager(h)
            p.compilerType = CompilerType.K1
            p.enableExtendedStats()
            val counter = PerformanceCounter.create("manager-observer")
            h.advance(1_000_000); p.notifyPhaseFinished(PhaseType.Initialization)
            for (phase in PhaseType.entries.drop(1)) {
                p.tryMeasurePhaseTime(phase) {
                    h.advance(2_000_000)
                    p.tryMeasureDynamicPhaseTime("dynamic-${phase.ordinal}", phase) { h.advance(3_000_000) }
                    p.tryMeasureSideTime(PhaseSideType.FindJavaClass) { h.advance(1_000_000) }
                    try { p.tryMeasureSideTime<Int>(PhaseSideType.BinaryClassFromKotlinFile) { h.advance(2_000_000); throw fault } }
                    catch (error: ProbeFault) { check(error === fault) }
                    counter.time { h.advance(1_000_000) }
                }
            }
            p.registerKlibElementStats(listOf("z" to 7L, "a" to 11L, "z" to 13L))
            h.z.millis += 6; h.z.count += 2; h.a.millis += 9; h.a.count += 1; h.jit += 12
            p.notifyCompilationFinished()
            check(!p.hasErrors && p.isFinalized && !p.isPhaseMeasuring)
            check(p.unitStats === p.unitStats)
            check(p.unitStats.gcStats.map { it.kind } == listOf("alpha", "zeta"))
            check(p.unitStats.klibElementStats!!.map { it.path } == listOf("a", "z"))
            stats("full", p.unitStats)
            record("targetInfo", p.getTargetInfo())
            for (format in PerformanceManager.DumpFormat.entries) record("report:$format", p.createPerformanceReport(format))
            for (destination in listOf("reports", "reports/", "*.json", "nested/*.md", "nested/name.log", "name.unknown", "*.a.json", "no-extension")) {
                p.dumpPerformanceReport(destination)
            }
            for ([filename, content] in h.writes) record("write:$filename", bytes(content))
            h.writeFault = fault
            try { p.dumpPerformanceReport("fault.json"); error("missing write failure") } catch (error: ProbeFault) { check(error === fault) }
            h.writeFault = null; record("writeFailure", true)
            val child = PerformanceManagerImpl.createChildIfNeeded(p, false)!!
            check(child.compilerType == CompilerType.K1 && !child.isPhaseMeasuring)
            child.targetDescription = "child"; child.addOtherUnitStats(p.unitStats); child.addOtherUnitStats(null)
            child.registerKlibElementStats(listOf("z" to 1L))
            child.tryMeasurePhaseTime(PhaseType.Backend) { h.advance(500_000) }
            stats("childAggregate", child.unitStats)
            check(PerformanceManagerImpl.createChildIfNeeded(null, true) == null)
            record("childNull", true)
            val runningChild = PerformanceManagerImpl.createChildIfNeeded(p, true)!!
            check(runningChild.isPhaseMeasuring); h.advance(3); stats("unfinishedChild", runningChild.unitStats)
            val errors = manager(h)
            errors.notifyCurrentPhaseFinishedIfNeeded()
            errors.notifyCurrentPhaseFinishedIfNeeded()
            try { errors.tryMeasurePhaseTime<Int>(PhaseType.Analysis) {
                try { errors.tryMeasureDynamicPhaseTime<Int>("throw", PhaseType.Analysis) { h.advance(8); throw fault } }
                finally { h.advance(5) }
            }; error("missing phase failure") } catch (error: ProbeFault) { check(error === fault) }
            errors.tryMeasurePhaseTime(PhaseType.Analysis) { h.advance(7) }
            stats("unfinishedPhase", errors.unitStats)
            check(errors.hasErrors && !errors.isPhaseMeasuring)
            val noMetrics = ProbeHost().also { it.jitAvailable = false; it.collectors = emptyList(); it.user = -1; it.cpu = -1 }
            withPerformanceManagerHost(noMetrics) {
                val absent = manager(noMetrics)
                absent.enableExtendedStats(); absent.notifyPhaseFinished(PhaseType.Initialization)
                absent.tryMeasurePhaseTime(PhaseType.Backend) { h.advance(17) }
                check(absent.unitStats.jitTimeMillis == null && absent.unitStats.gcStats.isEmpty())
                stats("absentMetrics", absent.unitStats)
                val normal = manager(noMetrics, false)
                normal.notifyPhaseFinished(PhaseType.Initialization)
                normal.tryMeasurePhaseTime(PhaseType.Backend) { h.advance(10_000) }
                record("notDetailedPlain", normal.createPerformanceReport(PerformanceManager.DumpFormat.PlainText))
                try { normal.createPerformanceReport(PerformanceManager.DumpFormat.Markdown); error("upstream table arity did not fail") }
                catch (error: IllegalArgumentException) { record("upstreamUndetailedMarkdown", error.message) }
            }
            for (platform in listOf(jsPlatform, wasmPlatform, TargetPlatform(setOf(object : JsPlatform() {}, object : WasmPlatform("Wasm") {})))) {
                val sample = manager(h, platform = platform); sample.notifyPhaseFinished(PhaseType.Initialization)
                sample.tryMeasurePhaseTime(PhaseType.Backend) { h.advance(1) }; record("platform", sample.unitStats.platform)
            }
            val nullManager: PerformanceManager? = null
            check(nullManager.tryMeasurePhaseTime(PhaseType.Backend) { 42 } == 42)
            check(nullManager.tryMeasureDynamicPhaseTime("none", PhaseType.Backend) { 43 } == 43)
            check(nullManager.tryMeasureSideTime(PhaseSideType.FindJavaClass) { 44 } == 44)
            record("nullWrappers", true)
            val units = (0..14).map { i -> p.unitStats.copy(name = "u$i", timeStampMs = h.wall + i * 1000,
                filesCount = i + 1, linesCount = (i + 1) * 20, compilerType = if (i % 2 == 0) CompilerType.K2 else CompilerType.K1,
                analysisStats = Time((i % 4 + 1) * 1_000_000L, (i % 4 + 1) * 2_000_000L, (i % 4 + 1) * 3_000_000L),
                hasErrors = i == 4, gcStats = if (i % 3 == 0) emptyList() else p.unitStats.gcStats, jitTimeMillis = if (i % 3 == 0) null else 10L) }
            val calculator = StatsCalculator(ModulesReportsData(units.associateBy { it.name!! }))
            stats("total", calculator.totalStats); stats("average", calculator.averageStats)
            for (count in listOf(0, 1, 3, 7, 15, 20)) for (maximum in listOf(false, true)) {
                record("top:$count:$maximum", calculator.getTopModulesBy(count, maximum) { it.analysisStats!!.nanos }.map { it.name })
            }
            try { calculator.getTopModulesBy(-1) { it.filesCount }; error("missing negative capacity failure") }
            catch (error: IllegalArgumentException) { record("negativeCapacity", true) }
            try { StatsCalculator(ModulesReportsData(emptyMap())); error("missing empty stats failure") }
            catch (error: IllegalArgumentException) { record("emptyStats", error.message) }
            record("modulesMarkdown", MarkdownReportRenderer(calculator).render())
            for (reverse in listOf(false, true)) {
                val timestamps = timestampReports("runs", units.reversed(), reverse)
                record("timestamps:$reverse", timestamps.unitStats.map { it.timeStampMs })
                record("timestampsMarkdown:$reverse", MarkdownReportRenderer(StatsCalculator(timestamps)).render())
            }
            val zero = p.unitStats.copy(linesCount = 0, dynamicStats = emptyList(), klibElementStats = emptyList(),
                initStats = Time.ZERO, analysisStats = null, translationToIrStats = null, irPreLoweringStats = null,
                irSerializationStats = null, klibWritingStats = null, klibMetadataWritingStats = null, irLinkingStats = null,
                irLoweringStats = null, backendStats = null, findJavaClassStats = null, findKotlinClassStats = null)
            record("zeroMarkdown", MarkdownReportRenderer(StatsCalculator(SingleReportsData(zero))).render())
            record("hostReads", "${h.reads},${h.enableCalls},${h.enabled}")
            for (nanos in listOf(Long.MIN_VALUE, -1_000_001L, -999_999L, 0, 999_999L, 1_000_001L, Long.MAX_VALUE)) {
                val time = Time(nanos, nanos, nanos); record("time:$nanos", "${time.millis}|${time + Time.ZERO}|${time / 2}|${-time}")
            }
            record("utf8", bytes(probeReportBytes("A한😀\uD800B\uDC00")))
        }
    }
    val restored = try { performanceManagerHost(); false } catch (_: IllegalArgumentException) { true }
    check(restored); record("hostRemoved", restored)
}
