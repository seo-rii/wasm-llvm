package org.jetbrains.kotlin.portable.descriptorsignatures.probe

import java.lang.reflect.InvocationTargetException
import org.jetbrains.kotlin.builtins.DefaultBuiltIns
import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.descriptors.impl.TypeAliasConstructorDescriptorImpl
import org.jetbrains.kotlin.ir.declarations.*
import org.jetbrains.kotlin.ir.declarations.impl.IrFactoryImpl
import org.jetbrains.kotlin.ir.descriptors.*
import org.jetbrains.kotlin.ir.symbols.impl.*
import org.jetbrains.kotlin.ir.types.impl.IrDynamicTypeImpl
import org.jetbrains.kotlin.metadata.ProtoBuf
import org.jetbrains.kotlin.metadata.deserialization.*
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.serialization.deserialization.descriptors.DeserializedTypeAliasDescriptor
import org.jetbrains.kotlin.storage.LockBasedStorageManager
import org.jetbrains.kotlin.types.Variance
import org.jetbrains.kotlin.types.error.*

private fun hex(value: String?): String = value?.map { it.code.toString(16).padStart(4, '0') }?.joinToString("") ?: "null"
private fun unwrap(error: Throwable): Throwable = if (error is InvocationTargetException) error.targetException else error
private fun result(action: () -> Any?): String = try {
    when (val value = action()) {
        null -> "null"
        is DeclarationDescriptor -> "descriptor:" + value::class.simpleName + ":" + value.name.asString()
        else -> "value:" + value::class.simpleName
    }
} catch (caught: Throwable) {
    val error = unwrap(caught)
    (error::class.simpleName ?: "null") + "\t" + hex(error.message)
}

@OptIn(org.jetbrains.kotlin.K1Deprecation::class, org.jetbrains.kotlin.ir.ObsoleteDescriptorBasedAPI::class)
fun observeDescriptorSignatures(): String {
    val rows = mutableListOf<String>()
    fun emit(label: String, action: () -> Any?) { rows += label + "\t" + result(action) }
    val builtIns = DefaultBuiltIns.Instance
    val module = builtIns.builtInsModule
    val origin = IrDeclarationOrigin.DEFINED
    val factory = IrFactoryImpl
    val type = IrDynamicTypeImpl(emptyList(), Variance.INVARIANT)
    val klass = factory.createClass(-1, -1, origin, Name.identifier("Owner"), DescriptorVisibilities.PUBLIC,
        IrClassSymbolImpl(), ClassKind.CLASS, Modality.FINAL)
    val constructor = factory.createConstructor(-1, -1, origin, Name.special("<init>"), DescriptorVisibilities.PUBLIC,
        false, false, type, IrConstructorSymbolImpl(), true).apply { parent = klass }
    val function = factory.createSimpleFunction(-1, -1, origin, Name.identifier("function"), DescriptorVisibilities.PUBLIC,
        false, false, type, Modality.FINAL, IrSimpleFunctionSymbolImpl(), false, false, false, false).apply { parent = klass }
    val property = factory.createProperty(startOffset = -1, endOffset = -1, origin = origin, name = Name.identifier("property"),
        visibility = DescriptorVisibilities.PUBLIC, modality = Modality.FINAL, symbol = IrPropertySymbolImpl(),
        isVar = false, isConst = false, isLateinit = false, isDelegated = false).apply { parent = klass }
    val field = factory.createField(startOffset = -1, endOffset = -1, origin = origin, name = Name.identifier("field"),
        visibility = DescriptorVisibilities.PUBLIC, symbol = IrFieldSymbolImpl(), type = type,
        isFinal = false, isStatic = false).apply { parent = klass }
    val parameter = factory.createValueParameter(-1, -1, origin, IrParameterKind.Regular, Name.identifier("parameter"), type,
        false, IrValueParameterSymbolImpl(), null, false, false, false).apply { parent = function }
    val entry = factory.createEnumEntry(-1, -1, origin, Name.identifier("entry"), IrEnumEntrySymbolImpl()).apply { parent = klass }
    val builtin = IrSimpleBuiltinOperatorDescriptorImpl(module, Name.identifier("builtin"), builtIns.unitType)
    val error = ErrorFunctionDescriptor(ErrorClassDescriptor(Name.special("<error owner>")))
    val alias = DeserializedTypeAliasDescriptor(LockBasedStorageManager.NO_LOCKS, module, Annotations.EMPTY,
        Name.identifier("Alias"), DescriptorVisibilities.PUBLIC, ProtoBuf.TypeAlias.newBuilder().setName(0).build(),
        NameResolverImpl(ProtoBuf.StringTable.newBuilder().addString("Alias").build(), ProtoBuf.QualifiedNameTable.getDefaultInstance()),
        TypeTable(ProtoBuf.TypeTable.getDefaultInstance()), VersionRequirementTable.EMPTY, null)
    alias.initialize(emptyList(), builtIns.anyType, builtIns.anyType)
    val aliasConstructor = TypeAliasConstructorDescriptorImpl.createIfAvailable(LockBasedStorageManager.NO_LOCKS,
        alias, builtIns.any.constructors.first())!!
    val copies = listOf(IrBasedClassConstructorDescriptor(constructor), aliasConstructor, error)
    for (receiver in copies) {
        val owner = receiver::class.qualifiedName!!
        val method = receiver.javaClass.declaredMethods.single { it.name == "copy" && it.parameterCount == 5 && !it.isBridge }
        rows += "receiver\t" + owner
        for (mask in 0..15) for (copyOverrides in listOf(false, true)) {
            var evaluated = ""
            fun argument(index: Int, value: Any): Any? { evaluated += index; return if (mask and (1 shl index) == 0) value else null }
            val arguments = arrayOf(argument(0, module), argument(1, Modality.FINAL), argument(2, DescriptorVisibilities.PUBLIC),
                argument(3, CallableMemberDescriptor.Kind.DECLARATION), copyOverrides)
            emit(owner + ":copy:" + mask + ":" + copyOverrides) { method.invoke(receiver, *arguments) }
            rows += "evaluation:" + owner + ":" + mask + ":" + copyOverrides + "\t" + evaluated
        }
        val copied = runCatching { method.invoke(receiver, module, Modality.FINAL, DescriptorVisibilities.PUBLIC,
            CallableMemberDescriptor.Kind.DECLARATION, false) }.getOrNull()
        rows += "copy-identity:" + owner + "\t" + (copied === receiver)
    }
    val keys = listOf(null, object : CallableDescriptor.UserDataKey<String> {}, object : CallableDescriptor.UserDataKey<String?> {})
    val userReceivers = listOf(IrBasedValueParameterDescriptor(parameter), IrBasedSimpleFunctionDescriptor(function),
        IrBasedClassConstructorDescriptor(constructor), IrBasedPropertyDescriptor(property), IrBasedFieldDescriptor(field), builtin, error)
    for (receiver in userReceivers) {
        val owner = receiver::class.qualifiedName!!
        val method = receiver.javaClass.getMethod("getUserData", CallableDescriptor.UserDataKey::class.java)
        for ((index, key) in keys.withIndex()) emit(owner + ":userdata:" + index) { method.invoke(receiver, key) }
    }
    for (classReceiver in listOf(IrBasedClassDescriptor(klass), IrBasedEnumEntryDescriptor(entry))) {
        val memberMethod = classReceiver.javaClass.getMethod("getMemberScope", java.util.List::class.java)
        for ((index, values) in listOf(emptyList<Any>(), mutableListOf<Any>(), listOf("payload")).withIndex()) {
            val scope = memberMethod.invoke(classReceiver, values)
            rows += "readonly-member:" + classReceiver::class.simpleName + ":" + index + "\t" + (scope === org.jetbrains.kotlin.resolve.scopes.MemberScope.Empty)
        }
        emit("readonly-member:" + classReceiver::class.simpleName + ":null") { memberMethod.invoke(classReceiver, null) }
    }
    for (receiver in listOf(IrBasedSimpleFunctionDescriptor(function), IrBasedClassConstructorDescriptor(constructor),
        IrBasedPropertyDescriptor(property), IrBasedFieldDescriptor(field))) {
        val method = receiver.javaClass.getMethod("setOverriddenDescriptors", java.util.Collection::class.java)
        for ((index, values) in listOf(emptyList<Any>(), mutableListOf<Any>(), listOf("payload")).withIndex())
            emit("readonly-overridden:" + receiver::class.simpleName + ":" + index) { method.invoke(receiver, values) }
        emit("readonly-overridden:" + receiver::class.simpleName + ":null") { method.invoke(receiver, null) }
    }
    return rows.joinToString("\n", postfix = "\n")
}
