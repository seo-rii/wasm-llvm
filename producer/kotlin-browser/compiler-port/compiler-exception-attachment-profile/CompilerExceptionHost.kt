package org.jetbrains.kotlin.portable.exceptions

/** Caller-owned taxonomy and decoder for one synchronous compiler request.
 * Callbacks must not suspend or reenter compilation. There are no default
 * classifications: the caller must supply its platform's actual policy.
 */
interface CompilerExceptionHost {
    fun isVirtualMachineError(throwable: Throwable): Boolean
    fun isControlFlowException(throwable: Throwable): Boolean
    fun isIndexNotReadyException(throwable: Throwable): Boolean
    fun decodeExternalAttachmentUtf8(bytes: ByteArray): String
}

private var installedCompilerExceptionHost: CompilerExceptionHost? = null

fun installCompilerExceptionHost(host: CompilerExceptionHost) {
    check(installedCompilerExceptionHost == null) { "Compiler exception host already installed" }
    installedCompilerExceptionHost = host
}

fun compilerExceptionHostInstalled(): Boolean = installedCompilerExceptionHost != null

/** Restore the prior request even when compilation or a host callback throws. */
fun <T> withCompilerExceptionHost(host: CompilerExceptionHost, block: () -> T): T {
    val previous = installedCompilerExceptionHost
    installedCompilerExceptionHost = host
    try { return block() } finally { installedCompilerExceptionHost = previous }
}

class CompilerExceptionHostRequired : IllegalStateException("Compiler exception host is required and has not been installed")

internal fun requiredCompilerExceptionHost(): CompilerExceptionHost =
    installedCompilerExceptionHost ?: throw CompilerExceptionHostRequired()

fun isVirtualMachineError(throwable: Throwable): Boolean = requiredCompilerExceptionHost().isVirtualMachineError(throwable)
fun isControlFlowException(throwable: Throwable): Boolean = requiredCompilerExceptionHost().isControlFlowException(throwable)
fun isIndexNotReadyException(throwable: Throwable): Boolean = requiredCompilerExceptionHost().isIndexNotReadyException(throwable)
