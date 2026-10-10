package org.jetbrains.kotlin.protobuf

/** Byte-array input keeps host filesystem and java.io outside the compiler core. */
class CodedInputStream private constructor(private val buffer: ByteArray, private val start: Int, length: Int) {
    private var position = start
    private val end = start + length
    private var limit = end
    private var recursionDepth = 0
    private var recursionLimit = 64
    private var sizeLimit = 64 * 1024 * 1024
    private var lastTag = 0
    val totalBytesRead: Int get() = position - start
    val bytesUntilLimit: Int get() = limit - position
    fun isAtEnd(): Boolean = position == limit
    fun setRecursionLimit(value: Int): Int { require(value >= 0); val previous = recursionLimit; recursionLimit = value; return previous }
    fun setSizeLimit(value: Int): Int { require(value >= 0); val previous = sizeLimit; sizeLimit = value; return previous }
    fun readTag(): Int {
        if (isAtEnd()) { lastTag = 0; return 0 }
        val tag = readRawVarint32()
        if (tag ushr 3 == 0) invalid("Protocol message contained an invalid tag")
        lastTag = tag
        return tag
    }
    fun checkLastTagWas(value: Int) { if (lastTag != value) invalid("Protocol message end-group tag did not match expected tag") }
    fun readRawByte(): Byte {
        if (position == limit) invalid("Truncated protocol message")
        if (totalBytesRead >= sizeLimit) invalid("Protocol message exceeded size limit")
        return buffer[position++]
    }
    fun readRawBytes(length: Int): ByteArray {
        if (length < 0) invalid("Negative protocol length")
        if (length > limit - position) invalid("Truncated protocol message")
        if (length > sizeLimit - totalBytesRead) invalid("Protocol message exceeded size limit")
        return buffer.copyOfRange(position, position + length).also { position += length }
    }
    fun skipRawBytes(length: Int) { readRawBytes(length) }
    fun readRawVarint64(): Long {
        var result = 0L
        for (shift in 0..63 step 7) {
            val byte = readRawByte().toInt() and 255
            result = result or ((byte and 127).toLong() shl shift)
            if (byte and 128 == 0) return result
        }
        invalid("Malformed protocol varint")
    }
    fun readRawVarint32(): Int = readRawVarint64().toInt()
    fun readRawLittleEndian32(): Int {
        var result = 0
        for (shift in 0..24 step 8) result = result or ((readRawByte().toInt() and 255) shl shift)
        return result
    }
    fun readRawLittleEndian64(): Long {
        var result = 0L
        for (shift in 0..56 step 8) result = result or ((readRawByte().toLong() and 255L) shl shift)
        return result
    }
    fun readDouble(): Double = Double.fromBits(readRawLittleEndian64())
    fun readFloat(): Float = Float.fromBits(readRawLittleEndian32())
    fun readUInt64(): Long = readRawVarint64()
    fun readInt64(): Long = readRawVarint64()
    fun readInt32(): Int = readRawVarint32()
    fun readFixed64(): Long = readRawLittleEndian64()
    fun readFixed32(): Int = readRawLittleEndian32()
    fun readBool(): Boolean = readRawVarint64() != 0L
    fun readString(): String = readBytes().toStringUtf8()
    fun readBytes(): ByteString = ByteString.copyFrom(readRawBytes(readRawVarint32()))
    fun readByteArray(): ByteArray = readBytes().toByteArray()
    fun readUInt32(): Int = readRawVarint32()
    fun readEnum(): Int = readRawVarint32()
    fun readSFixed32(): Int = readRawLittleEndian32()
    fun readSFixed64(): Long = readRawLittleEndian64()
    fun readSInt32(): Int = decodeZigZag32(readRawVarint32())
    fun readSInt64(): Long = decodeZigZag64(readRawVarint64())
    fun pushLimit(byteLimit: Int): Int {
        if (byteLimit < 0) invalid("Negative protocol length")
        if (byteLimit > limit - position) invalid("Truncated protocol message")
        val old = limit
        limit = position + byteLimit
        return old
    }
    fun popLimit(oldLimit: Int) { require(oldLimit in limit..end); limit = oldLimit }
    internal fun enterRecursion() { if (recursionDepth >= recursionLimit) invalid("Protocol message exceeded recursion limit"); recursionDepth++ }
    internal fun leaveRecursion() { recursionDepth-- }
    fun <T : MessageLite> readMessage(parser: Parser<T>, registry: ExtensionRegistryLite): T {
        val old = pushLimit(readRawVarint32())
        enterRecursion()
        try {
            val value = parser.parsePartialFrom(this, registry)
            checkLastTagWas(0)
            if (!isAtEnd()) invalid("Protocol submessage was not fully consumed")
            return value
        } finally { leaveRecursion(); popLimit(old) }
    }
    fun skipField(tag: Int, output: CodedOutputStream): Boolean {
        val number = tag ushr 3
        when (tag and 7) {
            0 -> { val value = readRawVarint64(); output.writeRawVarint32(tag); output.writeRawVarint64(value) }
            1 -> { val value = readRawLittleEndian64(); output.writeRawVarint32(tag); output.writeRawLittleEndian64(value) }
            2 -> { val value = readBytes(); output.writeRawVarint32(tag); output.writeBytesNoTag(value) }
            3 -> {
                output.writeRawVarint32(tag)
                enterRecursion()
                try { skipMessage(output); checkLastTagWas((number shl 3) or 4) } finally { leaveRecursion() }
                output.writeRawVarint32((number shl 3) or 4)
            }
            4 -> return false
            5 -> { val value = readRawLittleEndian32(); output.writeRawVarint32(tag); output.writeRawLittleEndian32(value) }
            else -> invalid("Invalid protocol wire type")
        }
        return true
    }
    fun skipField(tag: Int): Boolean = skipField(tag, CodedOutputStream())
    fun skipMessage(output: CodedOutputStream = CodedOutputStream()) {
        while (true) { val tag = readTag(); if (tag == 0 || !skipField(tag, output)) return }
    }
    companion object {
        fun newInstance(bytes: ByteArray): CodedInputStream = newInstance(bytes, 0, bytes.size)
        fun newInstance(bytes: ByteArray, offset: Int, length: Int): CodedInputStream {
            require(offset >= 0 && length >= 0 && offset <= bytes.size - length)
            return CodedInputStream(bytes, offset, length)
        }
        fun decodeZigZag32(value: Int): Int = (value ushr 1) xor -(value and 1)
        fun decodeZigZag64(value: Long): Long = (value ushr 1) xor -(value and 1L)
    }
}

/** Dynamic byte sink, or an explicitly bounded slice supplied by a caller. */
class CodedOutputStream internal constructor(private val target: ByteArray? = null, private val offset: Int = 0, private val capacity: Int = target?.size?.minus(offset) ?: 0) {
    private var buffer = target ?: ByteArray(128)
    private var used = 0
    private fun ensure(length: Int) {
        require(length >= 0)
        if (length > Int.MAX_VALUE - used) throw IllegalStateException("Protocol output overflow")
        val needed = used + length
        if (target != null) { if (needed > capacity) throw OutOfSpaceException(); return }
        if (needed > buffer.size) buffer = buffer.copyOf(maxOf(needed, minOf(Int.MAX_VALUE.toLong(), buffer.size.toLong() * 2).toInt()))
    }
    class OutOfSpaceException : IllegalStateException("CodedOutputStream ran out of space")
    val totalBytesWritten: Int get() = used
    val spaceLeft: Int get() = if (target == null) Int.MAX_VALUE - used else capacity - used
    fun checkNoSpaceLeft() { check(spaceLeft == 0) { "Protocol output size did not match allocation" } }
    fun flush() = flushToOutput()
    fun toByteArray(): ByteArray = buffer.copyOfRange(offset, offset + used)
    fun writeRawByte(value: Int) { ensure(1); buffer[offset + used++] = value.toByte() }
    fun writeRawByte(value: Byte) = writeRawByte(value.toInt())
    fun writeRawBytes(value: ByteArray, offset: Int = 0, length: Int = value.size - offset) {
        require(offset >= 0 && length >= 0 && offset <= value.size - length)
        ensure(length); value.copyInto(buffer, this.offset + used, offset, offset + length); used += length
    }
    fun writeRawBytes(value: ByteString) = writeRawBytes(value.toByteArray())
    fun writeRawVarint64(value: Long) {
        var remaining = value
        while (remaining and -128L != 0L) { writeRawByte((remaining.toInt() and 127) or 128); remaining = remaining ushr 7 }
        writeRawByte(remaining.toInt())
    }
    fun writeRawVarint32(value: Int) {
        var remaining = value
        while (remaining and -128 != 0) { writeRawByte((remaining and 127) or 128); remaining = remaining ushr 7 }
        writeRawByte(remaining)
    }
    fun writeRawLittleEndian32(value: Int) { for (shift in 0..24 step 8) writeRawByte(value ushr shift) }
    fun writeRawLittleEndian64(value: Long) { for (shift in 0..56 step 8) writeRawByte((value ushr shift).toInt()) }
    fun writeTag(number: Int, wireType: Int) { require(number in 1..536870911 && wireType in 0..5); writeRawVarint32((number shl 3) or wireType) }
    fun writeDoubleNoTag(value: Double) = writeRawLittleEndian64(value.toRawBits())
    fun writeFloatNoTag(value: Float) = writeRawLittleEndian32(value.toRawBits())
    fun writeUInt64NoTag(value: Long) = writeRawVarint64(value)
    fun writeInt64NoTag(value: Long) = writeRawVarint64(value)
    fun writeInt32NoTag(value: Int) { if (value >= 0) writeRawVarint32(value) else writeRawVarint64(value.toLong()) }
    fun writeFixed64NoTag(value: Long) = writeRawLittleEndian64(value)
    fun writeFixed32NoTag(value: Int) = writeRawLittleEndian32(value)
    fun writeBoolNoTag(value: Boolean) = writeRawByte(if (value) 1 else 0)
    fun writeBytesNoTag(value: ByteString) { writeRawVarint32(value.size); writeRawBytes(value) }
    fun writeStringNoTag(value: String) = writeBytesNoTag(ByteString.copyFromUtf8(value))
    fun writeByteArrayNoTag(value: ByteArray) { writeRawVarint32(value.size); writeRawBytes(value) }
    fun writeUInt32NoTag(value: Int) = writeRawVarint32(value)
    fun writeEnumNoTag(value: Int) = writeInt32NoTag(value)
    fun writeSFixed32NoTag(value: Int) = writeRawLittleEndian32(value)
    fun writeSFixed64NoTag(value: Long) = writeRawLittleEndian64(value)
    fun writeSInt32NoTag(value: Int) = writeRawVarint32(encodeZigZag32(value))
    fun writeSInt64NoTag(value: Long) = writeRawVarint64(encodeZigZag64(value))
    fun writeMessageNoTag(value: MessageLite) { val bytes = value.toByteArray(); writeRawVarint32(bytes.size); writeRawBytes(bytes) }
    fun writeBytes(number: Int, value: ByteString) { writeTag(number, 2); writeBytesNoTag(value) }
    fun writeString(number: Int, value: String) { writeTag(number, 2); writeStringNoTag(value) }
    fun writeMessage(number: Int, value: MessageLite) { writeTag(number, 2); writeMessageNoTag(value) }
    fun writeInt32(number: Int, value: Int) { writeTag(number, 0); writeInt32NoTag(value) }
    fun writeUInt32(number: Int, value: Int) { writeTag(number, 0); writeUInt32NoTag(value) }
    fun writeInt64(number: Int, value: Long) { writeTag(number, 0); writeInt64NoTag(value) }
    fun writeUInt64(number: Int, value: Long) { writeTag(number, 0); writeUInt64NoTag(value) }
    fun writeBool(number: Int, value: Boolean) { writeTag(number, 0); writeBoolNoTag(value) }
    fun writeEnum(number: Int, value: Int) { writeTag(number, 0); writeEnumNoTag(value) }
    fun writeDouble(number: Int, value: Double) { writeTag(number, 1); writeDoubleNoTag(value) }
    fun writeFloat(number: Int, value: Float) { writeTag(number, 5); writeFloatNoTag(value) }
    fun writeFixed32(number: Int, value: Int) { writeTag(number, 5); writeFixed32NoTag(value) }
    fun writeFixed64(number: Int, value: Long) { writeTag(number, 1); writeFixed64NoTag(value) }
    fun writeSFixed32(number: Int, value: Int) { writeTag(number, 5); writeSFixed32NoTag(value) }
    fun writeSFixed64(number: Int, value: Long) { writeTag(number, 1); writeSFixed64NoTag(value) }
    fun writeSInt32(number: Int, value: Int) { writeTag(number, 0); writeSInt32NoTag(value) }
    fun writeSInt64(number: Int, value: Long) { writeTag(number, 0); writeSInt64NoTag(value) }
    companion object {
        fun newInstance(bytes: ByteArray): CodedOutputStream = newInstance(bytes, 0, bytes.size)
        fun newInstance(bytes: ByteArray, offset: Int, length: Int): CodedOutputStream {
            require(offset >= 0 && length >= 0 && offset <= bytes.size - length)
            return CodedOutputStream(bytes, offset, length)
        }
        fun newInstance(output: ByteString.Output, bufferSize: Int = 4096): CodedOutputStream = CodedOutputStream().also { require(bufferSize > 0); it.external = output }
        fun encodeZigZag32(value: Int): Int = (value shl 1) xor (value shr 31)
        fun encodeZigZag64(value: Long): Long = (value shl 1) xor (value shr 63)
        fun computeRawVarint32Size(value: Int): Int { var v = value; var count = 1; while (v and -128 != 0) { count++; v = v ushr 7 }; return count }
        fun computeRawVarint64Size(value: Long): Int { var v = value; var count = 1; while (v and -128L != 0L) { count++; v = v ushr 7 }; return count }
        fun computeInt32SizeNoTag(value: Int): Int = if (value < 0) 10 else computeRawVarint32Size(value)
        fun computeTagSize(number: Int): Int = computeRawVarint32Size(number shl 3)
        fun computeBytesSizeNoTag(value: ByteString): Int = computeRawVarint32Size(value.size) + value.size
        fun computeMessageSizeNoTag(value: MessageLite): Int = computeRawVarint32Size(value.serializedSize) + value.serializedSize
    }
    private var external: ByteString.Output? = null
    private var flushed = 0
    fun flushToOutput() { external?.let { it.write(buffer, offset + flushed, used - flushed); flushed = used } }
}

internal fun invalid(message: String): Nothing = throw InvalidProtocolBufferException(message)

object ProtoCodec {
    fun encode(message: GeneratedMessageLite): ByteArray {
        val output = CodedOutputStream()
        val fields = message.schema.byNumber + message.state.extensionFields
        for (number in message.state.values.keys.sorted()) {
            val value = message.state.values.getValue(number)
            val field = fields.getValue(number)
            if (field.repeated) {
                val list = value as List<*>
                if (field.packed && field.packable && list.isNotEmpty()) {
                    val packed = CodedOutputStream()
                    list.forEach { writeValue(packed, field, it!!) }
                    output.writeTag(number, 2); output.writeByteArrayNoTag(packed.toByteArray())
                } else list.forEach { output.writeTag(number, field.wireType); writeValue(output, field, it!!) }
            } else { output.writeTag(number, field.wireType); writeValue(output, field, value) }
        }
        output.writeRawBytes(message.state.unknown)
        return output.toByteArray()
    }
    private fun writeValue(output: CodedOutputStream, field: ProtoField, value: Any) {
        when (field.kind) {
            ProtoKind.DOUBLE -> output.writeDoubleNoTag(value as Double)
            ProtoKind.FLOAT -> output.writeFloatNoTag(value as Float)
            ProtoKind.INT64, ProtoKind.UINT64 -> output.writeRawVarint64(value as Long)
            ProtoKind.INT32, ProtoKind.ENUM -> output.writeInt32NoTag(if (value is Internal.EnumLite) value.getNumber() else value as Int)
            ProtoKind.FIXED64, ProtoKind.SFIXED64 -> output.writeRawLittleEndian64(value as Long)
            ProtoKind.FIXED32, ProtoKind.SFIXED32 -> output.writeRawLittleEndian32(value as Int)
            ProtoKind.BOOL -> output.writeBoolNoTag(value as Boolean)
            ProtoKind.STRING -> if (value is ByteString) output.writeBytesNoTag(value) else output.writeStringNoTag(value as String)
            ProtoKind.MESSAGE -> output.writeMessageNoTag(value as MessageLite)
            ProtoKind.BYTES -> output.writeBytesNoTag(value as ByteString)
            ProtoKind.UINT32 -> output.writeRawVarint32(value as Int)
            ProtoKind.SINT32 -> output.writeSInt32NoTag(value as Int)
            ProtoKind.SINT64 -> output.writeSInt64NoTag(value as Long)
            ProtoKind.GROUP -> { output.writeRawBytes((value as MessageLite).toByteArray()); output.writeTag(field.number, 4) }
        }
    }
    fun decode(schema: ProtoSchema, input: CodedInputStream, registry: ExtensionRegistryLite): GeneratedMessageLite {
        val state = MutableProtoState()
        val unknown = CodedOutputStream()
        try {
            while (true) {
                val tag = input.readTag()
                if (tag == 0) break
                val number = tag ushr 3
                val field = schema.byNumber[number] ?: if (schema.extensions.any { number in it }) registry.field(schema, number) else null
                val wire = tag and 7
                val packed = field != null && field.repeated && field.packable && wire == 2
                if (field == null || wire != field.wireType && !packed) {
                    if (!input.skipField(tag, unknown)) break
                    continue
                }
                if (packed) {
                    val old = input.pushLimit(input.readRawVarint32())
                    try { while (!input.isAtEnd()) readInto(schema, state, field!!, input, registry, unknown) } finally { input.popLimit(old) }
                } else readInto(schema, state, field, input, registry, unknown)
                if (schema.byNumber[number] == null && state.values.containsKey(number)) state.extensionFields[number] = field
            }
        } catch (error: InvalidProtocolBufferException) {
            state.unknown = ByteString.copyFrom(unknown.toByteArray())
            throw error.setUnfinishedMessage(schema.factory(state.freeze()))
        }
        state.unknown = ByteString.copyFrom(unknown.toByteArray())
        return schema.factory(state.freeze())
    }
    private fun readInto(schema: ProtoSchema, state: MutableProtoState, field: ProtoField, input: CodedInputStream, registry: ExtensionRegistryLite, unknown: CodedOutputStream) {
        val value: Any = when (field.kind) {
            ProtoKind.DOUBLE -> input.readDouble()
            ProtoKind.FLOAT -> input.readFloat()
            ProtoKind.INT64, ProtoKind.UINT64 -> input.readRawVarint64()
            ProtoKind.INT32, ProtoKind.UINT32 -> input.readRawVarint32()
            ProtoKind.FIXED64, ProtoKind.SFIXED64 -> input.readRawLittleEndian64()
            ProtoKind.FIXED32, ProtoKind.SFIXED32 -> input.readRawLittleEndian32()
            ProtoKind.BOOL -> input.readBool()
            ProtoKind.STRING, ProtoKind.BYTES -> input.readBytes()
            ProtoKind.ENUM -> {
                val number = input.readEnum()
                field.enumValue!!(number) ?: run { unknown.writeTag(field.number, 0); unknown.writeRawVarint32(number); return }
            }
            ProtoKind.MESSAGE -> {
                val old = input.pushLimit(input.readRawVarint32())
                input.enterRecursion()
                try { decode(field.message!!(), input, registry).also { input.checkLastTagWas(0); if (!input.isAtEnd()) invalid("Unconsumed submessage bytes") } }
                finally { input.leaveRecursion(); input.popLimit(old) }
            }
            ProtoKind.GROUP -> {
                input.enterRecursion()
                try { decode(field.message!!(), input, registry).also { input.checkLastTagWas((field.number shl 3) or 4) } }
                finally { input.leaveRecursion() }
            }
            ProtoKind.SINT32 -> input.readSInt32()
            ProtoKind.SINT64 -> input.readSInt64()
        }
        if (field.oneof != null) schema.fields.filter { it.oneof == field.oneof && it.number != field.number }.forEach { state.values.remove(it.number) }
        val messageExtension = schema.byNumber[field.number] == null && value is GeneratedMessageLite
        if (field.repeated) {
            if (messageExtension && !(value as GeneratedMessageLite).isInitialized()) throw UninitializedMessageException()
            @Suppress("UNCHECKED_CAST") val values = state.values.getOrPut(field.number) { mutableListOf<Any>() } as MutableList<Any>
            values.add(value)
        } else {
            val previous = state.values[field.number]
            val merged = if (value is GeneratedMessageLite && previous is GeneratedMessageLite) previous.toBuilder().mergeFrom(value).buildPartial() else value
            if (messageExtension && !(merged as GeneratedMessageLite).isInitialized()) throw UninitializedMessageException()
            state.values[field.number] = merged
        }
    }
}
