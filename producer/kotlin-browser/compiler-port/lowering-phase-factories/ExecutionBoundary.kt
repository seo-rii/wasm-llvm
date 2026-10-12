@file:OptIn(kotlin.contracts.ExperimentalContracts::class)
package org.jetbrains.kotlin.portable.phaseproof.boundary

import kotlin.contracts.contract
import kotlin.contracts.InvocationKind

open class ProbeElement(val id: String)
class ProbeFile(id: String) : ProbeElement(id)
class ProbeModule(id: String, val files: List<ProbeFile>) : ProbeElement(id)
class ProbeContext {
    var inVerbosePhase = false
    var factories = 0
    val events = mutableListOf<String>()
}
class ProbeCompilationException : RuntimeException() {
    var initializedFile: ProbeFile? = null
    fun initializeFileDetails(file: ProbeFile) { initializedFile = file }
}
open class ProbeAttachmentException : RuntimeException()
fun Throwable.wrapWithCompilationException(message: String, file: ProbeFile, ignored: Nothing?): Throwable = this
inline fun measureTimeMillis(block: () -> Unit): Long {
    contract { callsInPlace(block, InvocationKind.EXACTLY_ONCE) }
    block(); return 0
}
