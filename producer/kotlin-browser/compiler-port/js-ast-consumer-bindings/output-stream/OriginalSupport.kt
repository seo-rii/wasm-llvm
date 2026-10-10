package org.jetbrains.kotlin.js.outputprobe
import java.io.OutputStream
import java.io.DataOutputStream

private class SelectedSink(val state: SinkState) : OutputStream() {
    override fun write(value: Int) = state.write(byteArrayOf(value.toByte()), 0, 1)
    override fun write(bytes: ByteArray, offset: Int, length: Int) = state.write(bytes, offset, length)
    override fun flush() = state.flush()
    override fun close() = state.close()
}
private class LifecycleOutput(private val value: DataOutputStream) {
    fun writeInt(number: Int) = value.writeInt(number)
    fun write(bytes: ByteArray) = value.write(bytes)
    fun close() = value.close()
    fun useAction(action: (LifecycleOutput) -> Unit) { value.use { action(this) } }
}
private fun lifecycle(state: SinkState) = LifecycleOutput(DataOutputStream(SelectedSink(state)))
