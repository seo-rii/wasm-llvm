package org.jetbrains.kotlin.portable.phaser.probe

import org.jetbrains.kotlin.backend.common.phaser.LoweringPhase
import org.jetbrains.kotlin.backend.common.phaser.createModulePhases
import org.jetbrains.kotlin.backend.wasm.wasmLowerings
import org.jetbrains.kotlin.backend.wasm.wasmLoweringsOfTheFirstPhase
import org.jetbrains.kotlin.ir.backend.js.jsLowerings
import org.jetbrains.kotlin.ir.backend.js.optimizationLoweringList
import org.jetbrains.kotlin.ir.backend.js.jsLoweringsOfTheFirstPhase
import org.jetbrains.kotlin.ir.inline.loweringsOfTheFirstPhase
import org.jetbrains.kotlin.config.LanguageFeature
import org.jetbrains.kotlin.config.LanguageVersion
import org.jetbrains.kotlin.config.LanguageVersionSettingsImpl
import org.jetbrains.kotlin.config.ApiVersion
import org.jetbrains.kotlin.config.phaser.NamedCompilerPhase

fun metadataSnapshot(): String = buildString {
    fun record(label: String, phase: NamedCompilerPhase<*, *, *>) {
        val lowering = phase as LoweringPhase<*, *, *>
        append(label).append('|').append(phase.name).append('|').append(classIdentity(lowering)).append('\n')
    }
    for (entry in wasmLowerings.withIndex()) { val index = entry.index; val phase = entry.value; record("wasm.$index", phase) }
    for (entry in jsLowerings.withIndex()) { val index = entry.index; val phase = entry.value; record("js.$index", phase) }
    for (entry in optimizationLoweringList.withIndex()) { val index = entry.index; val phase = entry.value; record("optimization.$index", phase) }
    val features = listOf(LanguageFeature.IrIntraModuleInlinerBeforeKlibSerialization,
        LanguageFeature.IrCrossModuleInlinerBeforeKlibSerialization, LanguageFeature.IrRichCallableReferencesInKlibs)
    for (mask in 0 until 8) {
        val flags = features.mapIndexed { index, feature -> feature to if (mask and (1 shl index) != 0) LanguageFeature.State.ENABLED else LanguageFeature.State.DISABLED }.toMap()
        val settings = LanguageVersionSettingsImpl(LanguageVersion.LATEST_STABLE, ApiVersion.LATEST_STABLE, specificFeatures = flags)
        val common = createModulePhases(*loweringsOfTheFirstPhase(settings).toTypedArray())
        for (entry in common.withIndex()) { val index = entry.index; val phase = entry.value; record("common.$mask.$index", phase) }
        for (entry in wasmLoweringsOfTheFirstPhase(settings).withIndex()) { val index = entry.index; val phase = entry.value; record("wasm-first.$mask.$index", phase) }
        for (entry in jsLoweringsOfTheFirstPhase(settings).withIndex()) { val index = entry.index; val phase = entry.value; record("js-first.$mask.$index", phase) }
    }
}
fun main() = print(metadataSnapshot())
