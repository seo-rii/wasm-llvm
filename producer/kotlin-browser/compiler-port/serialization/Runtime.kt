@file:OptIn(ExperimentalUnsignedTypes::class)
package org.jetbrains.kotlin.protobuf

import kotlin.jvm.JvmName

class ByteString private constructor(private val bytes: ByteArray) : Iterable<Byte> {
    val size: Int get() = bytes.size
    fun size(): Int = size
    fun isEmpty(): Boolean = bytes.isEmpty()
    fun toByteArray(): ByteArray = bytes.copyOf()
    fun toStringUtf8(): String = bytes.decodeToString()
    fun isValidUtf8(): Boolean = try { bytes.decodeToString(throwOnInvalidSequence = true); true } catch (_: CharacterCodingException) { false }
    fun concat(other: ByteString): ByteString = copyFrom(bytes + other.bytes)
    fun byteAt(index: Int): Byte = bytes[index]
    override fun iterator(): Iterator<Byte> = bytes.iterator()
    override fun equals(other: Any?): Boolean = other is ByteString && bytes.contentEquals(other.bytes)
    override fun hashCode(): Int {
        var hash = bytes.size
        for (byte in bytes) hash = hash * 31 + byte
        return if (hash == 0) 1 else hash
    }
    class Output {
        private val sink = CodedOutputStream()
        fun write(value: Int) { sink.writeRawByte(value) }
        fun write(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size - offset) { sink.writeRawBytes(bytes, offset, length) }
        fun toByteString(): ByteString = copyFrom(sink.toByteArray())
    }
    companion object {
        val EMPTY = ByteString(ByteArray(0))
        fun copyFrom(bytes: ByteArray): ByteString = ByteString(bytes.copyOf())
        fun copyFrom(bytes: ByteArray, offset: Int, length: Int): ByteString {
            require(offset >= 0 && length >= 0 && offset <= bytes.size - length)
            return ByteString(bytes.copyOfRange(offset, offset + length))
        }
        fun copyFromUtf8(value: String): ByteString = copyFrom(value.encodeToByteArray())
        fun newOutput(): Output = Output()
    }
}

class InvalidProtocolBufferException(message: String) : Exception(message) {
    var unfinishedMessage: MessageLite? = null
        private set
    fun setUnfinishedMessage(message: MessageLite): InvalidProtocolBufferException { unfinishedMessage = message; return this }
}
class UninitializedMessageException : IllegalStateException("Protocol message is missing required fields")

object Internal {
    interface EnumLite { fun getNumber(): Int }
    fun interface EnumLiteMap<T : EnumLite> { fun findValueByNumber(number: Int): T? }
}

interface MessageLiteOrBuilder {
    fun isInitialized(): Boolean
    fun getDefaultInstanceForType(): MessageLite
}

interface MessageLite : MessageLiteOrBuilder {
    val serializedSize: Int
    fun toByteArray(): ByteArray
    fun toByteString(): ByteString
    fun writeTo(output: CodedOutputStream)
    fun getParserForType(): Parser<out MessageLite>
    fun toBuilder(): GeneratedMessageLite.Builder<*, *>
    fun newBuilderForType(): GeneratedMessageLite.Builder<*, *>
}

interface Parser<T : MessageLite> {
    fun parseFrom(input: ProtoInput, registry: ExtensionRegistryLite = ExtensionRegistryLite.getEmptyRegistry()): T = parseFrom(input.readAllProtocolBytes(), registry)
    fun parseDelimitedFrom(input: ProtoInput, registry: ExtensionRegistryLite = ExtensionRegistryLite.getEmptyRegistry()): T? {
        val first = input.read()
        if (first == -1) return null
        return parseFrom(input.readProtocolBytes(input.readProtocolLength(first)), registry)
    }
    fun parsePartialFrom(input: CodedInputStream, registry: ExtensionRegistryLite = ExtensionRegistryLite.getEmptyRegistry()): T
    fun parseFrom(bytes: ByteArray, registry: ExtensionRegistryLite = ExtensionRegistryLite.getEmptyRegistry()): T {
        val input = CodedInputStream.newInstance(bytes)
        val message = parsePartialFrom(input, registry)
        input.checkLastTagWas(0)
        if (!message.isInitialized()) throw InvalidProtocolBufferException("Protocol message is missing required fields").setUnfinishedMessage(message)
        return message
    }
    fun parseFrom(bytes: ByteString, registry: ExtensionRegistryLite = ExtensionRegistryLite.getEmptyRegistry()): T = parseFrom(bytes.toByteArray(), registry)
    fun parseFrom(input: CodedInputStream, registry: ExtensionRegistryLite = ExtensionRegistryLite.getEmptyRegistry()): T {
        val message = parsePartialFrom(input, registry)
        input.checkLastTagWas(0)
        if (!message.isInitialized()) throw InvalidProtocolBufferException("Protocol message is missing required fields").setUnfinishedMessage(message)
        return message
    }
}

enum class ProtoKind { DOUBLE, FLOAT, INT64, UINT64, INT32, FIXED64, FIXED32, BOOL, STRING, GROUP, MESSAGE, BYTES, UINT32, ENUM, SFIXED32, SFIXED64, SINT32, SINT64 }

class ProtoField(
    val number: Int, val kind: ProtoKind, val repeated: Boolean = false, val required: Boolean = false,
    val packed: Boolean = false, val oneof: String? = null, val default: () -> Any,
    val message: (() -> ProtoSchema)? = null, val enumValue: ((Int) -> Internal.EnumLite?)? = null
) {
    val wireType: Int get() = when (kind) {
        ProtoKind.DOUBLE, ProtoKind.FIXED64, ProtoKind.SFIXED64 -> 1
        ProtoKind.STRING, ProtoKind.MESSAGE, ProtoKind.BYTES -> 2
        ProtoKind.GROUP -> 3
        ProtoKind.FLOAT, ProtoKind.FIXED32, ProtoKind.SFIXED32 -> 5
        else -> 0
    }
    val packable: Boolean get() = wireType == 0 || wireType == 1 || wireType == 5
}

class ProtoSchema(val name: String, val fields: List<ProtoField>, val extensions: List<IntRange>, val factory: (ProtoState) -> GeneratedMessageLite) {
    val byNumber: Map<Int, ProtoField> = fields.associateBy { it.number }
    val defaultInstance: GeneratedMessageLite by lazy(LazyThreadSafetyMode.NONE) { factory(ProtoState()) }
}

class ProtoState(
    val values: Map<Int, Any> = emptyMap(), val extensionFields: Map<Int, ProtoField> = emptyMap(), val unknown: ByteString = ByteString.EMPTY
)

class MutableProtoState(state: ProtoState = ProtoState()) {
    val values: MutableMap<Int, Any> = state.values.mapValues { (_, value) -> if (value is List<*>) value.toMutableList() else value }.toMutableMap()
    val extensionFields: MutableMap<Int, ProtoField> = state.extensionFields.toMutableMap()
    var unknown: ByteString = state.unknown
    fun freeze(): ProtoState = ProtoState(values.mapValues { (_, value) -> if (value is List<*>) value.toList() else value }, extensionFields.toMap(), unknown)
}

class ExtensionRegistryLite private constructor(private val mutable: Boolean) {
    private val fields = mutableMapOf<Pair<String, Int>, GeneratedMessageLite.GeneratedExtension<*, *>>()
    fun add(extension: GeneratedMessageLite.GeneratedExtension<*, *>) {
        check(mutable) { "Empty extension registry is immutable" }
        val key = extension.containingType to extension.field.number
        val old = fields[key]
        require(old == null || old === extension) { "Conflicting protocol extension" }
        fields[key] = extension
    }
    fun findLiteExtensionByNumber(instance: MessageLite, number: Int): GeneratedMessageLite.GeneratedExtension<*, *>? =
        fields[(instance as GeneratedMessageLite).schema.name to number]
    internal fun field(schema: ProtoSchema, number: Int): ProtoField? = fields[schema.name to number]?.field
    val unmodifiable: ExtensionRegistryLite get() = ExtensionRegistryLite(false).also { it.fields.putAll(fields) }
    @JvmName("getUnmodifiableMethod") fun getUnmodifiable(): ExtensionRegistryLite = unmodifiable
    companion object {
        private val empty = ExtensionRegistryLite(false)
        fun getEmptyRegistry(): ExtensionRegistryLite = empty
        fun newInstance(): ExtensionRegistryLite = ExtensionRegistryLite(true)
    }
}

abstract class GeneratedMessageLite(val schema: ProtoSchema, val state: ProtoState) : AbstractMessageLite() {
    fun hasField(number: Int): Boolean = state.values.containsKey(number)
    fun field(number: Int): Any = convert(schema.byNumber.getValue(number), state.values[number] ?: schema.byNumber.getValue(number).default())
    fun list(number: Int): List<Any> = (state.values[number] as? List<*>)?.map { convert(schema.byNumber.getValue(number), it!!) } ?: emptyList()
    private fun convert(field: ProtoField, value: Any): Any = if (field.kind == ProtoKind.STRING && value is ByteString) value.toStringUtf8() else value
    fun bytes(number: Int): ByteString = when (val value = state.values[number] ?: schema.byNumber.getValue(number).default()) {
        is ByteString -> value
        is String -> ByteString.copyFromUtf8(value)
        else -> error("Not a string or bytes field")
    }
    fun listBytes(number: Int, index: Int): ByteString = when (val value = (state.values[number] as List<*>)[index]) {
        is ByteString -> value
        is String -> ByteString.copyFromUtf8(value)
        else -> error("Not a string field")
    }
    fun oneofCase(name: String): Int = schema.fields.firstOrNull { it.oneof == name && state.values.containsKey(it.number) }?.number ?: 0
    override val serializedSize: Int get() = toByteArray().size
    @JvmName("getSerializedSizeMethod") fun getSerializedSize(): Int = serializedSize
    fun getUnknownFields(): ByteString = state.unknown
    override fun toByteArray(): ByteArray = ProtoCodec.encode(this)
    override fun toByteString(): ByteString = ByteString.copyFrom(toByteArray())
    override fun writeTo(output: CodedOutputStream) { output.writeRawBytes(toByteArray()) }
    override fun getDefaultInstanceForType(): GeneratedMessageLite = schema.defaultInstance
    override fun isInitialized(): Boolean {
        if (schema.fields.any { it.required && !state.values.containsKey(it.number) }) return false
        return state.values.values.all { value -> when (value) {
            is MessageLite -> value.isInitialized()
            is List<*> -> value.all { it !is MessageLite || it.isInitialized() }
            else -> true
        } }
    }
    abstract class ExtendableMessage<T : ExtendableMessage<T>>(schema: ProtoSchema, state: ProtoState) : GeneratedMessageLite(schema, state) {
        private fun check(extension: GeneratedExtension<*, *>) { require(extension.containingType == schema.name) }
        fun <V> hasExtension(extension: GeneratedExtension<*, V>): Boolean { check(extension); require(!extension.field.repeated); return hasField(extension.field.number) }
        @Suppress("UNCHECKED_CAST")
        fun <V> getExtension(extension: GeneratedExtension<*, V>): V {
            check(extension)
            val field = extension.field
            val value = state.values[field.number] ?: if (field.repeated) emptyList<Any>() else field.default()
            return (if (field.repeated) (value as List<*>).map { convertExtension(field, it!!) } else convertExtension(field, value)) as V
        }
        fun <V> getExtensionCount(extension: GeneratedExtension<*, List<V>>): Int = getExtension(extension).size
        fun <V> getExtension(extension: GeneratedExtension<*, List<V>>, index: Int): V = getExtension(extension)[index]
        private fun convertExtension(field: ProtoField, value: Any): Any = if (field.kind == ProtoKind.STRING && value is ByteString) value.toStringUtf8() else value
    }
    class GeneratedExtension<C : MessageLite, V>(val containingType: String, val field: ProtoField)

    abstract class Builder<M : GeneratedMessageLite, B : Builder<M, B>>(val schema: ProtoSchema, state: ProtoState = ProtoState()) : MessageLiteOrBuilder {
        protected var _protoState = MutableProtoState(state)
        @Suppress("UNCHECKED_CAST") protected fun self(): B = this as B
        fun hasField(number: Int): Boolean = _protoState.values.containsKey(number)
        fun field(number: Int): Any = buildPartial().field(number)
        fun list(number: Int): List<Any> = buildPartial().list(number)
        fun bytes(number: Int): ByteString = buildPartial().bytes(number)
        fun listBytes(number: Int, index: Int): ByteString = buildPartial().listBytes(number, index)
        fun oneofCase(name: String): Int = buildPartial().oneofCase(name)
        fun put(number: Int, value: Any): B {
            val field = schema.byNumber.getValue(number)
            if (field.oneof != null) schema.fields.filter { it.oneof == field.oneof && it.number != number }.forEach { _protoState.values.remove(it.number) }
            _protoState.values[number] = value
            return self()
        }
        fun remove(number: Int): B { _protoState.values.remove(number); return self() }
        fun append(number: Int, value: Any): B {
            require(schema.byNumber.getValue(number).repeated)
            @Suppress("UNCHECKED_CAST")
            val values = _protoState.values.getOrPut(number) { mutableListOf<Any>() } as MutableList<Any>
            values.add(value)
            return self()
        }
        fun replace(number: Int, index: Int, value: Any): B {
            val list = (_protoState.values[number] as? List<*>)?.toMutableList() ?: throw IndexOutOfBoundsException()
            list[index] = value; _protoState.values[number] = list; return self()
        }
        fun mergeMessage(number: Int, message: GeneratedMessageLite): B {
            val current = _protoState.values[number] as? GeneratedMessageLite
            return put(number, if (current == null) message else current.toBuilder().mergeFrom(message).buildPartial())
        }
        fun mergeFrom(message: GeneratedMessageLite): B {
            require(message.schema.name == schema.name)
            for ((number, value) in message.state.values) {
                val field = schema.byNumber[number] ?: message.state.extensionFields.getValue(number)
                if (field.repeated) {
                    @Suppress("UNCHECKED_CAST") val values = _protoState.values.getOrPut(number) { mutableListOf<Any>() } as MutableList<Any>
                    values.addAll(value as List<Any>)
                }
                else if (field.kind == ProtoKind.MESSAGE && _protoState.values[number] is GeneratedMessageLite &&
                    (field.oneof == null || oneofCase(field.oneof) == number)) {
                    _protoState.values[number] = (_protoState.values[number] as GeneratedMessageLite).toBuilder().mergeFrom(value as GeneratedMessageLite).buildPartial()
                } else {
                    if (field.oneof != null) schema.fields.filter { it.oneof == field.oneof }.forEach { _protoState.values.remove(it.number) }
                    _protoState.values[number] = value
                }
            }
            _protoState.extensionFields.putAll(message.state.extensionFields)
            _protoState.unknown = _protoState.unknown.concat(message.state.unknown)
            return self()
        }
        fun mergeFrom(input: CodedInputStream, registry: ExtensionRegistryLite = ExtensionRegistryLite.getEmptyRegistry()): B =
            mergeFrom(ProtoCodec.decode(schema, input, registry))
        fun mergeFrom(bytes: ByteArray, registry: ExtensionRegistryLite = ExtensionRegistryLite.getEmptyRegistry()): B {
            val input = CodedInputStream.newInstance(bytes)
            mergeFrom(input, registry)
            input.checkLastTagWas(0)
            return self()
        }
        fun mergeFrom(bytes: ByteString, registry: ExtensionRegistryLite = ExtensionRegistryLite.getEmptyRegistry()): B = mergeFrom(bytes.toByteArray(), registry)
        fun clear(): B { _protoState = MutableProtoState(); return self() }
        fun getUnknownFields(): ByteString = _protoState.unknown
        fun setUnknownFields(value: ByteString): B { _protoState.unknown = value; return self() }
        fun mergeUnknownFields(value: ByteString): B { _protoState.unknown = _protoState.unknown.concat(value); return self() }
        override fun getDefaultInstanceForType(): M = buildPartial().getDefaultInstanceForType() as M
        override fun isInitialized(): Boolean = buildPartial().isInitialized()
        fun build(): M { val message = buildPartial(); if (!message.isInitialized()) throw UninitializedMessageException(); return message }
        abstract fun buildPartial(): M
        abstract fun clone(): B
    }
    abstract class ExtendableBuilder<M : ExtendableMessage<M>, B : ExtendableBuilder<M, B>>(schema: ProtoSchema, state: ProtoState = ProtoState()) : Builder<M, B>(schema, state) {
        private fun check(extension: GeneratedExtension<*, *>) { require(extension.containingType == schema.name) }
        fun <V> setExtension(extension: GeneratedExtension<*, V>, value: V): B {
            check(extension); require(value != null)
            _protoState.extensionFields[extension.field.number] = extension.field; _protoState.values[extension.field.number] = if (extension.field.repeated) (value as List<*>).toMutableList() else value
            return self()
        }
        fun <V> addExtension(extension: GeneratedExtension<*, List<V>>, value: V): B {
            check(extension); require(value != null)
            _protoState.extensionFields[extension.field.number] = extension.field
            @Suppress("UNCHECKED_CAST") val values = _protoState.values.getOrPut(extension.field.number) { mutableListOf<Any>() } as MutableList<Any>
            values.add(value)
            return self()
        }
        fun <V> setExtension(extension: GeneratedExtension<*, List<V>>, index: Int, value: V): B {
            check(extension); require(value != null)
            val values = (_protoState.values[extension.field.number] as List<*>).toMutableList(); values[index] = value
            _protoState.values[extension.field.number] = values; return self()
        }
        fun <V> clearExtension(extension: GeneratedExtension<*, V>): B {
            check(extension); _protoState.values.remove(extension.field.number); _protoState.extensionFields.remove(extension.field.number); return self()
        }
        fun <V> hasExtension(extension: GeneratedExtension<*, V>): Boolean = buildPartial().hasExtension(extension)
        fun <V> getExtension(extension: GeneratedExtension<*, V>): V = buildPartial().getExtension(extension)
        fun <V> getExtensionCount(extension: GeneratedExtension<*, List<V>>): Int = buildPartial().getExtensionCount(extension)
        fun <V> getExtension(extension: GeneratedExtension<*, List<V>>, index: Int): V = buildPartial().getExtension(extension, index)
    }
}
