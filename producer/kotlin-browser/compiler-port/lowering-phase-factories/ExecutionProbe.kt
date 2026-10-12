package org.jetbrains.kotlin.portable.phaseproof.probe

import org.jetbrains.kotlin.portable.phaseproof.boundary.*
import org.jetbrains.kotlin.portable.phaseproof.contracts.*
import org.jetbrains.kotlin.portable.phaseproof.factories.*
import org.jetbrains.kotlin.portable.phaseproof.phaser.*

class FileProbe(private val context: ProbeContext) : FileLoweringPass {
    init { context.factories++ }
    override fun lower(irFile: ProbeFile) { context.events.add("file-body:" + irFile.id + ":" + context.inVerbosePhase) }
}
class ModuleProbe(private val context: ProbeContext) : ModuleLoweringPass {
    init { context.factories++ }
    override fun lower(irModule: ProbeModule) { context.events.add("module-body:" + irModule.id + ":" + context.inVerbosePhase) }
}
class GenericFileProbe<T>(private val context: ProbeContext) : FileLoweringPass {
    init { context.factories++ }
    override fun lower(irFile: ProbeFile) { context.events.add("generic-file-body:" + irFile.id) }
}
class FailedFileProbe(private val context: ProbeContext) : FileLoweringPass {
    init { context.factories++ }
    override fun lower(irFile: ProbeFile) { context.events.add("failed-file-body:" + irFile.id); throw ProbeAttachmentException() }
}
private fun fileFactory(context: ProbeContext): FileProbe = FileProbe(context)
private fun moduleFactory(context: ProbeContext): ModuleProbe = ModuleProbe(context)
private fun genericFactory(context: ProbeContext): GenericFileProbe<ProbeContext> = GenericFileProbe(context)
private fun failedFactory(context: ProbeContext): FailedFileProbe = FailedFileProbe(context)
private class ErasedFileFactory<T : FileLoweringPass> : (ProbeContext) -> T {
    override fun invoke(context: ProbeContext): T = error("Metadata lookup must never invoke this factory")
}

fun executionSnapshot(): String = buildString {
    fun record(label: String, value: Any?) { append(label).append('|').append(value).append('\n') }
    val context = ProbeContext()
    val file = ProbeFile("input")
    val module = ProbeModule("module", listOf(file, ProbeFile("second")))
    val files = createFilePhases(null, registeredFile(::fileFactory), registeredGeneric(::genericFactory), registeredFile(::fileFactory), null)
    val modules = createModulePhases(null, registeredModule(::moduleFactory), registeredFile(::fileFactory), null)
    record("file-names", files.map { it.name }.joinToString(",")); record("module-names", modules.map { it.name }.joinToString(","))
    record("no-introspection-instantiation", context.factories)
    val enabled = PhaseConfig(verbose = PhaseSet.All, checkConditions = true)
    val state = PhaserState(depth = 3, phaseCount = 7)
    for (entry in files.withIndex()) {
        val output = entry.value.invoke(enabled, state, context, file)
        record("file.${entry.index}.identity", output === file)
        record("file.${entry.index}.state", "${state.depth}/${state.phaseCount}/${state.alreadyDone.size}/${context.inVerbosePhase}/${context.factories}")
    }
    for (entry in modules.withIndex()) {
        record("module.${entry.index}.identity", entry.value.invoke(enabled, state, context, module) === module)
        record("module.${entry.index}.state", "${state.depth}/${state.phaseCount}/${state.alreadyDone.size}/${context.inVerbosePhase}/${context.factories}")
    }
    record("execution-events", context.events.joinToString(";"))
    val disabled = PhaseConfig(disabled = PhaseSet.Enum(setOf("fileprobe", "genericfileprobe", "MODULEPROBE")), verbose = PhaseSet.All)
    val oldFactories = context.factories; val oldCount = state.phaseCount; val oldEvents = context.events.size
    for (phase in files) record("disabled.file.${phase.name}", phase.invoke(disabled, state, context, file) === file)
    for (phase in modules) record("disabled.module.${phase.name}", phase.invoke(disabled, state, context, module) === module)
    record("disabled-unchanged", "${context.factories == oldFactories}/${state.phaseCount == oldCount}/${context.events.size == oldEvents}/${context.inVerbosePhase}")
    val failure = createFilePhases(registeredFailure(::failedFactory)).single()
    val failureState = PhaserState(); val failureContext = ProbeContext()
    try { failure.invoke(enabled, failureState, failureContext, file); record("failure", "allowed") }
    catch (_: ProbeAttachmentException) { record("failure", "attachment") }
    record("failure-state", "${failureState.phaseCount}/${failureState.alreadyDone.size}/${failureContext.inVerbosePhase}/${failureContext.factories}")
    record("failure-events", failureContext.events.joinToString(";"))
    try { createFilePhases(ErasedFileFactory<FileProbe>()); record("unregistered", "allowed") }
    catch (_: IllegalStateException) { record("unregistered", "rejected") }
    record("unregistered-no-instantiation", context.factories == oldFactories)
    record("empty-file", createFilePhases<ProbeContext>(null).size)
    record("empty-module", createModulePhases<ProbeContext>(null).size)
}
