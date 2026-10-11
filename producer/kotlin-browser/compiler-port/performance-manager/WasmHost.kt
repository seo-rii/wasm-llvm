/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.util.portable.probe

import org.jetbrains.kotlin.util.portable.*

private var hostEvent = 0
private fun replay(key: String): String {
    check(hostEvent < oracleEvents.size) { "Unexpected host request: $key" }
    val [expected, answer] = oracleEvents[hostEvent++]
    check(expected == key) { "Host request $hostEvent changed: expected $expected; received $key" }
    return answer
}
internal fun hostFormat(pattern: String, english: Boolean, args: Array<out Any?>): String = replay("format:" + oracleKey(pattern, english, args))
internal fun hostDateFormatter(kind: PerformanceDateFormat): PerformanceDateFormatter {
    replay("date:create:$kind")
    return PerformanceDateFormatter { stamp -> replay("date:$kind:$stamp") }
}
internal fun verifyHostReplayComplete() { check(hostEvent == oracleEvents.size) { "Unused host responses" } }
