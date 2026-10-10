package org.jetbrains.kotlin.js.outputprobe
import org.jetbrains.kotlin.js.portable.CompilerByteSink
import org.jetbrains.kotlin.js.portable.JsAstStreamOutput
import org.jetbrains.kotlin.js.portable.useJsAstOutput

private class SelectedSink(val state: SinkState) : CompilerByteSink {
    override fun write(bytes: ByteArray, offset: Int, length: Int) = state.write(bytes, offset, length)
    override fun flush() = state.flush()
    override fun close() = state.close()
}
private class LifecycleOutput(private val value: JsAstStreamOutput) {
    fun writeInt(number: Int) = value.writeInt(number)
    fun write(bytes: ByteArray) = value.write(bytes)
    fun close() = value.close()
    fun useAction(action: (LifecycleOutput) -> Unit) { value.useJsAstOutput { action(this) } }
}
private fun lifecycle(state: SinkState) = LifecycleOutput(JsAstStreamOutput(SelectedSink(state)))
