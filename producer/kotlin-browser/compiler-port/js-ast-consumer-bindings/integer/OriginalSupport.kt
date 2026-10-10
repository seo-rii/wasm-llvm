/* Observer support uses actual JDK stream encoding; not a production compiler host. */
package org.jetbrains.kotlin.js.astintegerprobe
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
class LiteralOutput {
    private val data = ByteArrayOutputStream()
    private val output = DataOutputStream(data)
    fun writeByte(value: Int) = output.writeByte(value)
    fun writeInt(value: Int) = output.writeInt(value)
    fun write(bytes: ByteArray) = output.write(bytes)
    fun bytes(): ByteArray = data.toByteArray()
}
fun failureCategory(error: Throwable): String = if (error is java.nio.BufferUnderflowException) "prefix-underflow" else error::class.simpleName ?: "Throwable"
