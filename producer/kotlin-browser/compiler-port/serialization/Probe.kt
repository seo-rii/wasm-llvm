package org.jetbrains.kotlin.protobuf.probe

import org.jetbrains.kotlin.protobuf.*
import org.jetbrains.kotlin.metadata.ProtoBuf
import org.jetbrains.kotlin.metadata.SerializationPluginMetadataExtensions
import org.jetbrains.kotlin.metadata.builtins.BuiltInsProtoBuf
import org.jetbrains.kotlin.library.metadata.KlibMetadataProtoBuf

fun registry(): ExtensionRegistryLite = ExtensionRegistryLite.newInstance().also {
    BuiltInsProtoBuf.registerAllExtensions(it)
    KlibMetadataProtoBuf.registerAllExtensions(it)
    SerializationPluginMetadataExtensions.registerAllExtensions(it)
}
fun decodeForProbe(name: String, bytes: ByteArray, partial: Boolean, extensions: Boolean, recursionLimit: Int = 65535): ByteArray {
    val schema = CodecSchemas.factories[name]?.invoke() ?: error("Unknown actual schema: $name")
    val input = CodedInputStream.newInstance(bytes); input.setRecursionLimit(recursionLimit)
    val message = ProtoCodec.decode(schema, input, if (extensions) registry() else ExtensionRegistryLite.getEmptyRegistry())
    input.checkLastTagWas(0)
    if (!partial && !message.isInitialized()) throw InvalidProtocolBufferException("Protocol message is missing required fields")
    return message.toByteArray()
}
/** Uses compiler-consumed generated APIs, including missing versus explicit defaults. */
fun verifyGeneratedApi(): Boolean {
    val absent = ProtoBuf.Type.getDefaultInstance()
    check(!absent.hasNullable() && !absent.nullable)
    val present = ProtoBuf.Type.newBuilder().setNullable(false).build()
    check(present.hasNullable() && !present.getNullable())
    val id = ProtoBuf.Annotation.Argument.Value.newBuilder().setIntValue(Long.MIN_VALUE).build()
    check(id.intValue == Long.MIN_VALUE)
    val builder = ProtoBuf.Type.newBuilder().addArgument(ProtoBuf.Type.Argument.newBuilder())
    check(builder.argumentCount == 1 && builder.getArgument(0) === builder.argumentList[0])
    val bytes = ByteString.copyFromUtf8("Kotlin한글")
    val plugin = ProtoBuf.CompilerPluginData.newBuilder().setPluginId(0).setData(bytes).build()
    check(plugin.data.toStringUtf8() == "Kotlin한글")
    val output = ByteArrayProtoOutput(); present.writeDelimitedTo(output)
    val input = ByteArrayProtoInput(output.toByteArray())
    check(ProtoBuf.Type.PARSER.parseDelimitedFrom(input)!!.hasNullable())
    check(ProtoBuf.Type.PARSER.parseDelimitedFrom(input) == null)
    val source = byteArrayOf(1, 2, 3)
    val immutable = ByteString.copyFrom(source); source[0] = 99
    check(immutable.byteAt(0) == 1.toByte())
    val snapshot = builder.buildPartial(); builder.addArgument(ProtoBuf.Type.Argument.newBuilder())
    check(snapshot.argumentCount == 1 && builder.argumentCount == 2)
    val clone = builder.clone(); clone.clearArgument(); check(builder.argumentCount == 2)
    val fixed = ByteArray(1); val sink = CodedOutputStream.newInstance(fixed)
    sink.writeRawByte(0xff); sink.checkNoSpaceLeft()
    var overflow = false
    try { sink.writeRawByte(0) } catch (_: CodedOutputStream.OutOfSpaceException) { overflow = true }
    check(overflow)
    val limited = CodedInputStream.newInstance(byteArrayOf(8, 1)); limited.setSizeLimit(1)
    var sizeRejected = false
    try { limited.readTag(); limited.readInt32() } catch (_: InvalidProtocolBufferException) { sizeRejected = true }
    check(sizeRejected)
    var frozen = false
    try { registry().unmodifiable.add(KlibMetadataProtoBuf.typeAnnotation) } catch (_: IllegalStateException) { frozen = true }
    check(frozen)
    var endGroupRejected = false
    try { ProtoBuf.Type.newBuilder().mergeFrom(byteArrayOf(12)) } catch (_: InvalidProtocolBufferException) { endGroupRejected = true }
    check(endGroupRejected)
    return true
}
