package org.jetbrains.kotlin.portable.visitorvoid.probe

import java.lang.reflect.InvocationTargetException
import org.jetbrains.kotlin.builtins.DefaultBuiltIns
import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.fir.*
import org.jetbrains.kotlin.fir.descriptors.*
import org.jetbrains.kotlin.ir.declarations.*
import org.jetbrains.kotlin.ir.declarations.impl.*
import org.jetbrains.kotlin.ir.descriptors.*
import org.jetbrains.kotlin.ir.symbols.impl.*
import org.jetbrains.kotlin.ir.types.impl.IrDynamicTypeImpl
import org.jetbrains.kotlin.name.FqName
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.types.Variance
import org.jetbrains.kotlin.types.error.ErrorModuleDescriptor

private fun encode(value: String?): String = value?.map { it.code.toString(16).padStart(4, '0') }?.joinToString("") ?: "null"
private fun outcome(action: () -> Any?): String = try {
    action(); "return"
} catch (caught: Throwable) {
    val error = if (caught is InvocationTargetException) caught.targetException else caught
    (error::class.simpleName ?: "null") + "\t" + encode(error.message)
}

/** A real implementation of the complete genuine visitor interface, not a model. */
private class ObserverVisitor(val observe: (DeclarationDescriptor, Nothing?) -> Nothing?) : DeclarationDescriptorVisitor<Nothing?, Nothing?> {
    override fun visitPackageFragmentDescriptor(descriptor: PackageFragmentDescriptor, data: Nothing?): Nothing? = observe(descriptor, data)
    override fun visitPackageViewDescriptor(descriptor: PackageViewDescriptor, data: Nothing?): Nothing? = observe(descriptor, data)
    override fun visitVariableDescriptor(descriptor: VariableDescriptor, data: Nothing?): Nothing? = observe(descriptor, data)
    override fun visitFunctionDescriptor(descriptor: FunctionDescriptor, data: Nothing?): Nothing? = observe(descriptor, data)
    override fun visitTypeParameterDescriptor(descriptor: TypeParameterDescriptor, data: Nothing?): Nothing? = observe(descriptor, data)
    override fun visitClassDescriptor(descriptor: ClassDescriptor, data: Nothing?): Nothing? = observe(descriptor, data)
    override fun visitTypeAliasDescriptor(descriptor: TypeAliasDescriptor, data: Nothing?): Nothing? = observe(descriptor, data)
    override fun visitModuleDeclaration(descriptor: ModuleDescriptor, data: Nothing?): Nothing? = observe(descriptor, data)
    override fun visitConstructorDescriptor(constructorDescriptor: ConstructorDescriptor, data: Nothing?): Nothing? = observe(constructorDescriptor, data)
    override fun visitScriptDescriptor(scriptDescriptor: ScriptDescriptor, data: Nothing?): Nothing? = observe(scriptDescriptor, data)
    override fun visitPropertyDescriptor(descriptor: PropertyDescriptor, data: Nothing?): Nothing? = observe(descriptor, data)
    override fun visitValueParameterDescriptor(descriptor: ValueParameterDescriptor, data: Nothing?): Nothing? = observe(descriptor, data)
    override fun visitPropertyGetterDescriptor(descriptor: PropertyGetterDescriptor, data: Nothing?): Nothing? = observe(descriptor, data)
    override fun visitPropertySetterDescriptor(descriptor: PropertySetterDescriptor, data: Nothing?): Nothing? = observe(descriptor, data)
    override fun visitReceiverParameterDescriptor(descriptor: ReceiverParameterDescriptor, data: Nothing?): Nothing? = observe(descriptor, data)
}

@OptIn(PrivateSessionConstructor::class, SessionConfiguration::class, org.jetbrains.kotlin.K1Deprecation::class,
    org.jetbrains.kotlin.ir.ObsoleteDescriptorBasedAPI::class)
fun main() {
    val builtIns = DefaultBuiltIns.Instance
    val module = builtIns.builtInsModule
    val name = { value: String -> Name.identifier(value) }
    val origin = IrDeclarationOrigin.DEFINED
    val type = IrDynamicTypeImpl(emptyList(), Variance.INVARIANT)
    val factory = IrFactoryImpl
    val klass = factory.createClass(-1, -1, origin, name("Owner"), DescriptorVisibilities.PUBLIC, IrClassSymbolImpl(), ClassKind.CLASS, Modality.FINAL)
    val function = factory.createSimpleFunction(-1, -1, origin, name("function"), DescriptorVisibilities.PUBLIC,
        false, false, type, Modality.FINAL, IrSimpleFunctionSymbolImpl(), false, false, false, false).apply { parent = klass }
    val constructor = factory.createConstructor(-1, -1, origin, Name.special("<init>"), DescriptorVisibilities.PUBLIC,
        false, false, type, IrConstructorSymbolImpl(), true).apply { parent = klass }
    val parameter = factory.createValueParameter(-1, -1, origin, IrParameterKind.Regular, name("parameter"), type,
        false, IrValueParameterSymbolImpl(), null, false, false, false).apply { parent = function }
    val receiver = factory.createValueParameter(-1, -1, origin, IrParameterKind.ExtensionReceiver, name("receiver"), type,
        false, IrValueParameterSymbolImpl(), null, false, false, false).apply { parent = function }
    val typeParameter = factory.createTypeParameter(-1, -1, origin, name("T"), IrTypeParameterSymbolImpl(), Variance.INVARIANT, 0, false).apply { parent = klass }
    val variable = IrVariableImpl(null, -1, -1, origin, name("variable"), type, IrVariableSymbolImpl(), true, false, false).apply { parent = function }
    val local = factory.createLocalDelegatedProperty(-1, -1, origin, name("local"), IrLocalDelegatedPropertySymbolImpl(), type, false).apply {
        parent = function; delegate = variable; getter = function
    }
    val entry = factory.createEnumEntry(-1, -1, origin, name("ENTRY"), IrEnumEntrySymbolImpl()).apply { parent = klass }
    val property = factory.createProperty(-1, -1, origin, name("property"), DescriptorVisibilities.PUBLIC, Modality.FINAL,
        IrPropertySymbolImpl(), false, false, false, false).apply { parent = klass }
    val alias = factory.createTypeAlias(-1, -1, origin, name("Alias"), DescriptorVisibilities.PUBLIC, IrTypeAliasSymbolImpl(), false, type).apply { parent = klass }
    val field = factory.createField(-1, -1, origin, name("field"), DescriptorVisibilities.PUBLIC, IrFieldSymbolImpl(), type, true, false).apply { parent = klass }
    // Genuine FirSession inherited implementation; no methods are stubbed.
    val session = object : FirSession(FirSession.Kind.Library) {}
    val data = FirBinaryDependenciesModuleData(Name.special("<void-probe>"))
    data.bindSession(session)
    val firModule = FirModuleDescriptor.createDependencyModuleDescriptor(data, builtIns)
    val receivers: List<Pair<String, DeclarationDescriptor>> = listOf(
        "firModule" to firModule,
        "firFragment" to FirPackageFragmentDescriptor(FqName("fragment"), module),
        "firView" to FirPackageViewDescriptor(FqName("view"), module),
        "irCallable" to IrBasedVariableDescriptorWithAccessor(local),
        "irValueParameter" to IrBasedValueParameterDescriptor(parameter),
        "irReceiverParameter" to IrBasedReceiverParameterDescriptor(receiver),
        "irTypeParameter" to IrBasedTypeParameterDescriptor(typeParameter),
        "irVariable" to IrBasedVariableDescriptor(variable),
        "irFunction" to IrBasedSimpleFunctionDescriptor(function),
        "irConstructor" to IrBasedClassConstructorDescriptor(constructor),
        "irClass" to IrBasedClassDescriptor(klass),
        "irEnumEntry" to IrBasedEnumEntryDescriptor(entry),
        "irProperty" to IrBasedPropertyDescriptor(property),
        "irAlias" to IrBasedTypeAliasDescriptor(alias),
        "irField" to IrBasedFieldDescriptor(field),
        "irPackage" to IrBuiltinsPackageFragmentDescriptorImpl(module, FqName("irpackage")),
        "errorModule" to ErrorModuleDescriptor
    )
    val messages = listOf("", "plain", "한글", "\u0000", "\r\n", "\uD800", "\uDC00", "😀", "null", "visitor", "{ }", "\u2028", "java.lang.Void")
    val owners = mutableSetOf<String>()
    for ((label, descriptor) in receivers) {
        val method = descriptor.javaClass.getMethod("acceptVoid", DeclarationDescriptorVisitor::class.java)
        val owner = method.declaringClass.name; check(owners.add(owner))
        println("$owner:null\t" + outcome { method.invoke(descriptor, null) })
        val noDispatch = label in setOf("firModule", "firView", "irCallable", "errorModule")
        for ((index, message) in messages.withIndex()) for (throws in listOf(false, true)) {
            var calls = 0
            val visitor = ObserverVisitor { receiverDescriptor, nullableData ->
                check(receiverDescriptor === descriptor && nullableData == null)
                calls++
                if (throws) throw IllegalArgumentException(message)
                null
            }
            val result = outcome { method.invoke(descriptor, visitor) }
            check(calls == if (noDispatch) 0 else 1)
            println("$owner:$index:$throws\t$result\t$calls")
        }
    }
    check(owners.size == 17)
}
