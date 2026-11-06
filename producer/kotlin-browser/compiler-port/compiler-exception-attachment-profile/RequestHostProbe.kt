package policyprobe

import kotlin.coroutines.cancellation.CancellationException
import org.jetbrains.kotlin.portable.exceptions.*
import org.jetbrains.kotlin.utils.exceptions.shouldIjPlatformExceptionBeRethrown

/** Dispatch fixtures only; these classes do not model a browser fatal taxonomy. */
private class RequestPolicy(
    val fatal: Throwable,
    val control: Throwable,
    val index: Throwable,
    val decoded: String,
) : CompilerExceptionHost {
    val calls = mutableListOf<String>()
    var decoderFailure: Throwable? = null
    override fun isVirtualMachineError(throwable: Throwable): Boolean {
        calls.add("fatal")
        return throwable === fatal
    }
    override fun isControlFlowException(throwable: Throwable): Boolean {
        calls.add("control")
        return throwable === control
    }
    override fun isIndexNotReadyException(throwable: Throwable): Boolean {
        calls.add("index")
        return throwable === index
    }
    override fun decodeExternalAttachmentUtf8(bytes: ByteArray): String {
        calls.add("decode")
        check(bytes.contentEquals(byteArrayOf(48, 49)))
        decoderFailure?.let { throw it }
        return decoded
    }
}

fun requestHostSnapshot(): String {
    check(!compilerExceptionHostInstalled())
    val fatal = IllegalStateException("fatal fixture")
    val control = IllegalStateException("control fixture")
    val index = IllegalStateException("index fixture")
    val plain = IllegalStateException("plain")
    val outer = RequestPolicy(fatal, control, index, "outer decoded")
    val nested = RequestPolicy(plain, plain, plain, "nested decoded")
    var reads = 0
    val external = object : CompilerExceptionAttachment {
        override val path = "external"
        override val displayText = "caller-owned bytes"
        override val bytes: ByteArray get() { reads++; return byteArrayOf(48, 49) }
    }
    val bodyFailure = IllegalArgumentException("request failure")
    val callbackFailure = IllegalArgumentException("decoder failure")
    val answer = withCompilerExceptionHost(outer) {
        check(compilerExceptionHostInstalled())
        check(isVirtualMachineError(fatal) && !isVirtualMachineError(plain))
        check(shouldIjPlatformExceptionBeRethrown(control))
        check(shouldIjPlatformExceptionBeRethrown(index))
        check(!shouldIjPlatformExceptionBeRethrown(plain))
        outer.calls.clear()
        check(shouldIjPlatformExceptionBeRethrown(CancellationException("cancel")))
        check(outer.calls.isEmpty())
        check(decodeCompilerAttachmentUtf8(external) == "outer decoded")
        check(reads == 1 && outer.calls == listOf("decode"))
        withCompilerExceptionHost(nested) {
            check(isVirtualMachineError(plain) && !isVirtualMachineError(fatal))
            check(decodeCompilerAttachmentUtf8(external) == "nested decoded")
        }
        check(isVirtualMachineError(fatal))
        var bodyCaught = false
        try {
            withCompilerExceptionHost(nested) { throw bodyFailure }
        } catch (error: Throwable) {
            check(error === bodyFailure)
            bodyCaught = true
        }
        check(bodyCaught)
        check(isVirtualMachineError(fatal))
        nested.decoderFailure = callbackFailure
        var callbackCaught = false
        try {
            withCompilerExceptionHost(nested) { decodeCompilerAttachmentUtf8(external) }
        } catch (error: Throwable) {
            check(error === callbackFailure)
            callbackCaught = true
        }
        check(callbackCaught)
        check(isVirtualMachineError(fatal))
        42
    }
    check(answer == 42 && !compilerExceptionHostInstalled())
    val priorReads = reads
    try {
        decodeCompilerAttachmentUtf8(external)
        error("missing host must fail before reading external bytes")
    } catch (_: CompilerExceptionHostRequired) {
        check(reads == priorReads)
    }
    var outerBodyCaught = false
    try {
        withCompilerExceptionHost(outer) { throw bodyFailure }
    } catch (error: Throwable) {
        check(error === bodyFailure)
        outerBodyCaught = true
    }
    check(outerBodyCaught)
    check(!compilerExceptionHostInstalled())
    return listOf("request installation", "classification dispatch", "cancellation shortcut",
        "external decoder", "nested restoration", "body failure restoration",
        "callback failure restoration", "uninstalled read rejection").joinToString("\n", postfix = "\n")
}
