/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.util.portable.probe

import org.jetbrains.kotlin.util.PerformanceCounter
import org.jetbrains.kotlin.util.portable.performanceCounterNanoTime
import org.jetbrains.kotlin.util.portable.withPerformanceCounterClock

private class Fault : Exception("probe fault")
private class Clock(var now: Long = 0) {
    var reads = 0
    fun read(): Long { reads++; return now }
}

fun observePerformanceCounter(): String = buildString {
    fun record(label: String, value: Any?) { append(label).append(':').append(value).append('\n') }
    fun snapshot(label: String, clock: Clock? = null) {
        PerformanceCounter.report { name, count, nanos -> record("$label:$name", "$count,$nanos") }
        PerformanceCounter.report { text -> record("$label:text", text) }
        if (clock != null) record("$label:clockReads", clock.reads)
    }
    fun nanos(counter: PerformanceCounter): Long {
        var result = 0L
        counter.report { _, _, value -> result = value }
        return result
    }
    val nullableCell = ProbeLocal<String?>()
    var defaults = 0
    check(PerformanceCounter.getOrPut(nullableCell) { defaults++; null } == null)
    check(PerformanceCounter.getOrPut(nullableCell) { defaults++; null } == null)
    check(PerformanceCounter.getOrPut(nullableCell) { defaults++; "stored" } == "stored")
    check(PerformanceCounter.getOrPut(nullableCell) { defaults++; "wrong" } == "stored")
    check(defaults == 3)
    record("nullableCell", "$defaults,${nullableCell.get()}")
    record("initialCount", PerformanceCounter.numberOfCounters)
    check(PerformanceCounter.numberOfCounters == 0)
    val disabled = PerformanceCounter.create("disabled")
    val fault = Fault()
    check(disabled.time { 19 } == 19)
    disabled.increment()
    try { disabled.time<Int> { throw fault } } catch (error: Fault) { check(error === fault) }
    snapshot("disabled")
    check(nanos(disabled) == 0L)
    val missing = try { performanceCounterNanoTime(); false } catch (error: IllegalArgumentException) {
        error.message == "Performance counter clock is not installed for this request"
    }
    record("missingClock", missing); check(missing)
    PerformanceCounter.setTimeCounterEnabled(true)
    val clock = Clock()
    withPerformanceCounterClock(clock::read) {
        val simple = PerformanceCounter.create("simple")
        check(simple.time { clock.now += 12; 41 } == 41)
        try { simple.time<Int> { clock.now += 7; throw fault } } catch (error: Fault) { check(error === fault) }
        check(nanos(simple) == 19L)
        snapshot("simple", clock)
        val reentrant = PerformanceCounter.create("reentrant", true)
        reentrant.time { clock.now += 2; reentrant.time { clock.now += 3 }; clock.now += 5 }
        check(nanos(reentrant) == 10L)
        try { reentrant.time { clock.now += 7; reentrant.time<Int> { clock.now += 11; throw fault } } }
        catch (error: Fault) { check(error === fault) }
        reentrant.time { clock.now += 13 }
        check(nanos(reentrant) == 41L)
        snapshot("reentrant", clock)
        val excluded = PerformanceCounter.create("excluded", true)
        val main = PerformanceCounter.create("main", excluded)
        excluded.time { clock.now += 17 } // An excluded call outside the main counter.
        check(nanos(main) == 0L)
        main.time {
            clock.now += 2
            excluded.time { clock.now += 3; excluded.time { clock.now += 5 } }
            clock.now += 7
            main.time { clock.now += 11 }
        }
        check(nanos(main) == 20L)
        try { main.time { clock.now += 13; excluded.time<Int> { clock.now += 19; throw fault } } }
        catch (error: Fault) { check(error === fault) }
        main.time { clock.now += 23 }
        check(nanos(main) == 56L)
        snapshot("excluded", clock)
        val inner = Clock(800)
        check(withPerformanceCounterClock(inner::read) { performanceCounterNanoTime() } == 800L)
        check(performanceCounterNanoTime() == clock.now)
        try { withPerformanceCounterClock(inner::read) { throw fault } } catch (error: Fault) { check(error === fault) }
        check(performanceCounterNanoTime() == clock.now)
        try { withPerformanceCounterClock({ throw fault }) { performanceCounterNanoTime() } } catch (error: Fault) { check(error === fault) }
        check(performanceCounterNanoTime() == clock.now)
        record("scopeRestoration", inner.reads)
        for (iteration in 0 until 16) {
            PerformanceCounter.resetAllCounters()
            val a = PerformanceCounter.create("a$iteration", iteration % 2 == 0)
            val b = PerformanceCounter.create("b$iteration", iteration % 3 == 0)
            val c = PerformanceCounter.create("c$iteration", a, b)
            val start = clock.reads
            try {
                c.time {
                    clock.now += iteration + 1
                    a.time { clock.now += 5; c.time { clock.now += 7 }; b.time { clock.now += 11 } }
                    b.time { clock.now += 13; a.time { clock.now += 17 } }
                    c.time { clock.now += 19; if (iteration % 2 == 0) throw fault }
                    clock.now += 23
                }
            } catch (error: Fault) { check(error === fault) }
            c.time { clock.now += 29 }
            for (counter in listOf(a, b, c)) {
                counter.report { name, count, time -> record("scenario$iteration:$name", "$count,$time") }
                counter.report { text -> record("scenario$iteration:text", text) }
            }
            record("scenario$iteration:clockReads", clock.reads - start)
        }
        for (delta in listOf(999_999L, 1_000_000L, 1_999_999L, -999_999L, -1_000_001L, Long.MIN_VALUE, Long.MAX_VALUE)) {
            val counter = PerformanceCounter.create("millis$delta")
            clock.now = 0
            counter.time { clock.now = delta }
            check(nanos(counter) == delta)
            counter.report { text -> record("millis", text) }
        }
        val wrap = PerformanceCounter.create("wrap")
        clock.now = Long.MAX_VALUE - 4
        wrap.time { clock.now = Long.MIN_VALUE + 5 }
        check(nanos(wrap) == 10L)
        wrap.report { name, count, time -> record(name, "$count,$time") }
        val before = PerformanceCounter.numberOfCounters
        var observed = 0
        PerformanceCounter.report { _: String -> if (observed++ == 0) PerformanceCounter.create("addedDuringReport") }
        check(observed == before && PerformanceCounter.numberOfCounters == before + 1)
        record("reportSnapshot", "$before,$observed,${PerformanceCounter.numberOfCounters}")
        PerformanceCounter.setTimeCounterEnabled(false)
        val readsBefore = clock.reads
        wrap.time { clock.now += 10 }
        check(clock.reads == readsBefore)
        record("disabledAgain", readsBefore)
        PerformanceCounter.resetAllCounters()
        var reset = 0
        PerformanceCounter.report { _, count, nanos -> check(count == 0 && nanos == 0L); reset++ }
        record("reset", reset)
    }
    val restoredMissing = try { performanceCounterNanoTime(); false } catch (error: IllegalArgumentException) { true }
    check(restoredMissing); record("restoredMissing", restoredMissing)
}
