/* Non-shipping identity observations of the complete FirRegularTowerDataContexts source file.
 * Factories supply either explicitly opaque carriers or genuine JVM compiler objects.
 * No FIR resolution, scope lookup, or compiler pipeline is implemented by this fixture.
 */
package org.jetbrains.kotlin.portable.towermap.probe

import org.jetbrains.kotlin.fir.declarations.FirTowerDataContext
import org.jetbrains.kotlin.fir.resolve.FirRegularTowerDataContexts
import org.jetbrains.kotlin.fir.resolve.FirTowerDataMode
import org.jetbrains.kotlin.fir.scopes.impl.FirLocalScope

private data class Expected(
    val values: List<FirTowerDataContext?>,
    val active: FirTowerDataMode,
    val pure: FirLocalScope?,
    val all: FirLocalScope?,
)

fun towerModeSnapshot(): String {
    val contexts = List(14) { newContext() }
    val scopes = List(2) { newScope() }
    check(contexts.indices.all { i -> contexts.indices.all { j -> (contexts[i] === contexts[j]) == (i == j) } })
    check(scopes[0] !== scopes[1])
    val modes = FirTowerDataMode.entries
    check(modes.map { it.name } == listOf("REGULAR", "NESTED_CLASS", "COMPANION_BLOCK", "COMPANION_OBJECT", "CONSTRUCTOR_HEADER", "ENUM_ENTRY"))
    val output = StringBuilder()
    fun contextId(value: FirTowerDataContext?): String {
        if (value == null) return "-"
        val index = contexts.indexOfFirst { it === value }
        check(index >= 0) { "Unexpected context identity" }
        return "c$index"
    }
    fun scopeId(value: FirLocalScope?): String {
        if (value == null) return "-"
        val index = scopes.indexOfFirst { it === value }
        check(index >= 0) { "Unexpected scope identity" }
        return "s$index"
    }
    fun inspect(value: FirRegularTowerDataContexts, expected: Expected): String {
        check(value.activeMode == expected.active)
        check(value.currentContext === expected.values[expected.active.ordinal])
        check(value.primaryConstructorPureParametersScope === expected.pure)
        check(value.primaryConstructorAllParametersScope === expected.all)
        val identities = modes.map { mode ->
            val sibling = value.replaceTowerDataMode(mode)
            check((sibling === value) == (mode == expected.active))
            check(sibling.activeMode == mode)
            check(sibling.currentContext === expected.values[mode.ordinal])
            check(sibling.primaryConstructorPureParametersScope === expected.pure)
            check(sibling.primaryConstructorAllParametersScope === expected.all)
            contextId(sibling.currentContext)
        }
        return "${value.activeMode.name}|${identities.joinToString(",")}|${scopeId(expected.pure)},${scopeId(expected.all)}"
    }
    fun record(label: String, value: FirRegularTowerDataContexts, expected: Expected) {
        output.append(label).append('|').append(inspect(value, expected)).append('\n')
    }
    val defaults = FirRegularTowerDataContexts(contexts[0])
    record("defaults", defaults, Expected(listOf(contexts[0], null, null, null, null, null), modes[0], null, null))
    var states = 0
    var transitions = 0
    var historySteps = 0
    for (mask in 0 until 32) {
        val values = modes.indices.map { index -> if (index == 0 || mask and (1 shl (index - 1)) != 0) contexts[index] else null }
        for (scopeMask in 0 until 4) {
            val pure = scopes[0].takeIf { scopeMask and 1 != 0 }
            val all = scopes[1].takeIf { scopeMask and 2 != 0 }
            // The public constructor takes OBJECT before BLOCK, unlike enum ordinal order.
            val base = FirRegularTowerDataContexts(contexts[0], values[1], values[3], values[2], values[4], values[5], pure, all)
            val baseExpected = Expected(values, modes[0], pure, all)
            for (active in modes) {
                states++
                val label = "$mask/$scopeMask/${active.name}"
                val seed = base.replaceTowerDataMode(active)
                val expected = baseExpected.copy(active = active)
                check((seed === base) == (active == modes[0]))
                record("$label/initial", seed, expected)
                for (next in modes) {
                    transitions++
                    val sibling = seed.replaceTowerDataMode(next)
                    val siblingExpected = expected.copy(active = next)
                    check((sibling === seed) == (next == active))
                    record("$label/to-${next.name}", sibling, siblingExpected)
                    val changedValues = values.mapIndexed { index, value -> if (index == next.ordinal) contexts[6] else value }
                    val replaced = sibling.replaceCurrentlyActiveContext(contexts[6])
                    check(replaced !== sibling)
                    record("$label/replace-${next.name}", replaced, siblingExpected.copy(values = changedValues))
                    val regularValues = values.mapIndexed { index, value -> if (index == 0) contexts[7] else value }
                    val regularExpected = expected.copy(values = regularValues, active = modes[0])
                    val regular = sibling.replaceAndSetActiveRegularContext(contexts[7])
                    val composed = sibling.replaceTowerDataMode(modes[0]).replaceCurrentlyActiveContext(contexts[7])
                    check(regular !== sibling && composed !== sibling && regular !== composed)
                    check(inspect(regular, regularExpected) == inspect(composed, regularExpected))
                    record("$label/regular-${next.name}", regular, regularExpected)
                    // Mode views may share the map; replacement must not mutate any existing view.
                    inspect(replaced, siblingExpected.copy(values = changedValues))
                    inspect(sibling, siblingExpected)
                    inspect(seed, expected)
                    inspect(base, baseExpected)
                }
                val companion = seed.forCompanionBlock()
                val companionValue = values[2]
                val companionExpected = if (companionValue == null) {
                    check(companion === seed)
                    expected
                } else {
                    check(companion !== seed && companion !== base)
                    Expected(listOf(companionValue, null, null, null, null, null), modes[0], null, null)
                }
                record("$label/companion", companion, companionExpected)
                inspect(seed, expected)
                inspect(base, baseExpected)
                var current = seed
                var currentExpected = expected
                val history = mutableListOf(seed to expected, companion to companionExpected, base to baseExpected)
                for (next in modes) {
                    historySteps++
                    val sibling = current.replaceTowerDataMode(next)
                    val siblingExpected = currentExpected.copy(active = next)
                    history.add(sibling to siblingExpected)
                    val replacement = contexts[8 + next.ordinal]
                    current = sibling.replaceCurrentlyActiveContext(replacement)
                    currentExpected = siblingExpected.copy(values = siblingExpected.values.mapIndexed { index, value ->
                        if (index == next.ordinal) replacement else value
                    })
                    record("$label/history-${next.name}", current, currentExpected)
                    for (entry in history) inspect(entry.first, entry.second)
                    history.add(current to currentExpected)
                }
            }
        }
    }
    check(states == 768 && transitions == 4608 && historySteps == 4608)
    output.append("coverage|states=$states|transitions=$transitions|history=$historySteps\n")
    return output.toString()
}
