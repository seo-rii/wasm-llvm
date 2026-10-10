package org.jetbrains.kotlin.portable.irgetter.probe

import org.jetbrains.kotlin.builtins.DefaultBuiltIns
import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.ir.declarations.*
import org.jetbrains.kotlin.ir.declarations.impl.IrFactoryImpl
import org.jetbrains.kotlin.ir.declarations.impl.IrFileImpl
import org.jetbrains.kotlin.ir.declarations.impl.IrModuleFragmentImpl
import org.jetbrains.kotlin.ir.descriptors.IrBasedPropertyDescriptor
import org.jetbrains.kotlin.ir.symbols.impl.*
import org.jetbrains.kotlin.ir.types.impl.IrErrorTypeImpl
import org.jetbrains.kotlin.ir.util.NaiveSourceBasedFileEntryImpl
import org.jetbrains.kotlin.name.FqName
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.types.KotlinType
import org.jetbrains.kotlin.types.Variance

private class CountingProperty(owner: IrProperty, var result: KotlinType) : IrBasedPropertyDescriptor(owner) {
    var calls = 0
    override fun getReturnType(): KotlinType { calls++; return result }
}

private fun hex(value: String?): String = value?.map { it.code.toString(16).padStart(4, '0') }?.joinToString("") ?: "null"

@OptIn(org.jetbrains.kotlin.K1Deprecation::class, org.jetbrains.kotlin.ir.ObsoleteDescriptorBasedAPI::class,
    org.jetbrains.kotlin.ir.symbols.UnsafeDuringIrConstructionAPI::class)
fun main() {
    val rows = mutableListOf<String>()
    val builtIns = DefaultBuiltIns.Instance
    val factory = IrFactoryImpl
    val origin = IrDeclarationOrigin.DEFINED
    val module = IrModuleFragmentImpl(builtIns.builtInsModule)
    val file = IrFileImpl(NaiveSourceBasedFileEntryImpl("property-probe.kt"), IrFileSymbolImpl(), FqName.ROOT, module)
    module.files += file
    val klass = factory.createClass(-1, -1, origin, Name.identifier("Owner"), DescriptorVisibilities.PUBLIC,
        IrClassSymbolImpl(), ClassKind.CLASS, Modality.OPEN).apply { parent = file }
    file.declarations += klass
    val types = listOf(builtIns.intType, builtIns.stringType, builtIns.anyType, builtIns.nullableAnyType)
    fun emit(label: String, action: () -> String) {
        rows += label + '\t' + try { action() } catch (failure: Throwable) {
            failure::class.simpleName + ":" + hex(failure.message)
        }
    }
    for (index in 0..15) for (mask in 0..3) {
        val first = types[index % types.size]
        val second = types[(index + 1) % types.size]
        val property = factory.createProperty(-1, -1, origin, Name.identifier("p$index"), DescriptorVisibilities.PUBLIC,
            Modality.OPEN, IrPropertySymbolImpl(), false, false, false, false).apply { parent = klass }
        klass.declarations += property
        val getter = factory.createSimpleFunction(-1, -1, origin, Name.special("<get-p$index>"), DescriptorVisibilities.PUBLIC,
            false, false, IrErrorTypeImpl(first, emptyList(), Variance.INVARIANT), Modality.OPEN,
            IrSimpleFunctionSymbolImpl(), false, false, false, false).apply { parent = klass; correspondingPropertySymbol = property.symbol }
        val field = factory.createField(-1, -1, origin, Name.identifier("f$index"), DescriptorVisibilities.PUBLIC,
            IrFieldSymbolImpl(), IrErrorTypeImpl(second, emptyList(), Variance.INVARIANT), false, false)
            .apply { parent = klass; correspondingPropertySymbol = property.symbol }
        if (mask and 1 != 0) property.backingField = field
        if (mask and 2 != 0) property.getter = getter
        val expected = if (mask and 2 != 0) first else if (mask and 1 != 0) second else null
        val descriptor = IrBasedPropertyDescriptor(property)
        emit("return:$index:$mask") { (descriptor.getReturnType() === expected).toString() }
        emit("type:$index:$mask") { (descriptor.getType() === expected).toString() }
        emit("owner:$index:$mask") { (descriptor.owner === property && property.parent === klass && klass.parent === file).toString() }
        property.getter = getter
        property.backingField = field
        emit("live-getter:$index:$mask") { (descriptor.getType() === first).toString() }
        property.getter = null
        emit("live-field:$index:$mask") { (descriptor.getType() === second).toString() }
        val counting = CountingProperty(property, first)
        emit("virtual:$index:$mask") { (counting.getType() === first).toString() + ':' + counting.calls }
        counting.result = second
        emit("virtual-live:$index:$mask") { (counting.getType() === second).toString() + ':' + counting.calls }
    }
    print(rows.joinToString("\n", postfix = "\n"))
}
