package org.jetbrains.kotlin.portable.identityprobe

import org.jetbrains.kotlin.builtins.DefaultBuiltIns
import org.jetbrains.kotlin.fir.diagnostics.ConeSimpleDiagnostic
import org.jetbrains.kotlin.fir.types.ConeErrorType
import org.jetbrains.kotlin.ir.IrElement
import org.jetbrains.kotlin.ir.IrElementBase
import org.jetbrains.kotlin.ir.irAttribute
import org.jetbrains.kotlin.ir.declarations.IrDeclarationOrigin
import org.jetbrains.kotlin.ir.declarations.impl.IrFactoryImpl
import org.jetbrains.kotlin.ir.symbols.impl.IrTypeParameterSymbolImpl
import org.jetbrains.kotlin.ir.types.SimpleTypeNullability
import org.jetbrains.kotlin.ir.types.impl.*
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.storage.LockBasedStorageManager
import org.jetbrains.kotlin.types.ClassTypeConstructorImpl
import org.jetbrains.kotlin.types.Variance
import org.jetbrains.kotlin.types.error.ErrorUtils
import org.jetbrains.kotlin.types.model.CaptureStatus

/** Genuine bootstrap dependency objects; the four algorithm source files are selected-pin originals/ports. */
fun main() = with(DefaultBuiltIns.Instance) {
    fun record(id: String, value: Any?) { println("$id\t$value") }
    fun observe(id: String, values: List<Any>) {
        for ([index, value] in values.withIndex()) {
            val first = value.hashCode()
            record("$id-hash-stable-$index", (0 until 128).all { first == value.hashCode() })
            record("$id-self-equal-$index", value == value)
            for ([otherIndex, other] in values.withIndex()) {
                record("$id-equals-$index-$otherIndex", value == other)
                record("$id-equal-hash-$index-$otherIndex", value != other || value.hashCode() == other.hashCode())
            }
        }
    }
    val coneA = ConeErrorType(ConeSimpleDiagnostic("selected error A"))
    val coneB = ConeErrorType(ConeSimpleDiagnostic("selected error B"))
    observe("cone-error", listOf(coneA, coneA, coneB))
    val parameter = IrFactoryImpl.createTypeParameter(
        -1, -1, IrDeclarationOrigin.DEFINED, Name.identifier("T"),
        IrTypeParameterSymbolImpl(), Variance.INVARIANT, 0, false,
    )
    fun captured() = IrCapturedType(
        CaptureStatus.FOR_SUBTYPING, null, IrStarProjectionImpl, parameter,
        SimpleTypeNullability.DEFINITELY_NOT_NULL, emptyList(),
    )
    val capturedA = captured()
    observe("ir-captured", listOf(capturedA, capturedA, captured()))
    observe("ir-error", listOf(
        IrErrorTypeImpl(null, emptyList(), Variance.INVARIANT),
        IrErrorTypeImpl(stringType, emptyList(), Variance.OUT_VARIANCE),
    ))
    observe("ir-dynamic", listOf(
        IrDynamicTypeImpl(emptyList(), Variance.INVARIANT),
        IrDynamicTypeWithOriginalKotlinTypeImpl(stringType, emptyList(), Variance.OUT_VARIANCE),
    ))
    fun constructor(descriptor: org.jetbrains.kotlin.descriptors.ClassDescriptor) = ClassTypeConstructorImpl(
        descriptor, descriptor.declaredTypeParameters, descriptor.typeConstructor.supertypes,
        LockBasedStorageManager.NO_LOCKS,
    )
    val errorConstructor = constructor(ErrorUtils.errorClass)
    observe("classifier-error", listOf(errorConstructor, errorConstructor, constructor(ErrorUtils.errorClass)))
    observe("classifier-meaningful", listOf(constructor(any), constructor(any), constructor(string)))
    record("classifier-meaningful-numeric-hash", constructor(string).hashCode())

    // Real factory-produced IR elements and genuine IrAttribute keys; no fake descriptor/IR implementations.
    fun element(): IrElementBase = IrFactoryImpl.createBlockBody(-1, -1) as IrElementBase
    val attributes = (0 until 32).map { index ->
        irAttribute<IrElement, String>(copyByDefault = index % 3 != 0).create(null, "same-name")
    }
    fun attributeLabel(key: Any): Int = attributes.indexOfFirst { it === key }
    fun snapshot(value: IrElementBase): String = value.attributes.entries
        .map { attributeLabel(it.key).toString() + "=" + it.value }.sorted().joinToString(";")
    val source = element(); val destination = element()
    record("attributes-empty-copy", run { destination.copyAttributesFrom(source, false); snapshot(destination) })
    for ([index, key] in attributes.withIndex()) {
        source.setAttributeInternal(key, "source-$index")
        if (index % 2 == 0) destination.setAttributeInternal(key, "destination-$index")
    }
    record("attributes-destination-before-copy", snapshot(destination))
    destination.copyAttributesFrom(source, false)
    record("attributes-default-copy", snapshot(destination))
    destination.copyAttributesFrom(source, true)
    record("attributes-include-all-copy", snapshot(destination))
    destination.copyAttributesFrom(destination, false)
    record("attributes-self-copy", snapshot(destination))
    for ([index, key] in attributes.withIndex()) {
        record("attributes-remove-old-$index", destination.setAttributeInternal(key, null))
        record("attributes-removed-get-$index", destination.getAttributeInternal(key))
        record("attributes-after-remove-$index", snapshot(destination))
    }
    record("attributes-final-empty", snapshot(destination))
}
