package org.jetbrains.kotlin.portable.descriptorvisitor.probe

import java.lang.invoke.MethodHandles
import java.lang.invoke.MethodType
import java.lang.reflect.InvocationTargetException
import org.jetbrains.kotlin.builtins.DefaultBuiltIns
import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.descriptors.impl.*
import org.jetbrains.kotlin.fir.descriptors.FirPackageFragmentDescriptor
import org.jetbrains.kotlin.fir.descriptors.FirPackageViewDescriptor
import org.jetbrains.kotlin.ir.declarations.IrDeclarationOrigin
import org.jetbrains.kotlin.ir.declarations.impl.IrFactoryImpl
import org.jetbrains.kotlin.ir.descriptors.*
import org.jetbrains.kotlin.ir.symbols.impl.IrTypeAliasSymbolImpl
import org.jetbrains.kotlin.ir.types.impl.IrDynamicTypeImpl
import org.jetbrains.kotlin.metadata.ProtoBuf
import org.jetbrains.kotlin.metadata.deserialization.NameResolverImpl
import org.jetbrains.kotlin.metadata.deserialization.TypeTable
import org.jetbrains.kotlin.metadata.deserialization.VersionRequirementTable
import org.jetbrains.kotlin.name.FqName
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.serialization.deserialization.descriptors.DeserializedTypeAliasDescriptor
import org.jetbrains.kotlin.storage.LockBasedStorageManager
import org.jetbrains.kotlin.types.Variance
import org.jetbrains.kotlin.types.error.ErrorModuleDescriptor

private fun encode(s: String?): String =
    s?.map { it.code.toString(16).padStart(4, '0') }?.joinToString("") ?: "null"

private fun result(action: () -> Any?): String {
    return try {
        val value = action()
        "return\t" + encode(value?.toString())
    } catch (caught: Throwable) {
        val error = if (caught is InvocationTargetException) caught.targetException else caught
        error.javaClass.name + "\t" + encode(error.message)
    }
}

private fun simpleResult(action: () -> Any?): String {
    return try { action(); "return" } catch (caught: Throwable) {
        val error = if (caught is InvocationTargetException) caught.targetException else caught
        (error::class.simpleName ?: "null") + "\t" + encode(error.message)
    }
}

/** All receivers are real compiler implementations, built via their actual constructors/factory. */
@OptIn(org.jetbrains.kotlin.K1Deprecation::class, org.jetbrains.kotlin.ir.ObsoleteDescriptorBasedAPI::class)
fun main(args: Array<String>) {
    val projectedClass = if (args.singleOrNull() == "--generic-projection")
        Class.forName("org.jetbrains.kotlin.portable.descriptorvisitor.generic.GenericEntriesKt") else null
    @Suppress("UNCHECKED_CAST")
    val projectedOwners = projectedClass?.getMethod("getGenericOwners")?.invoke(null) as? List<String>
    val storage = LockBasedStorageManager.NO_LOCKS
    val builtIns = DefaultBuiltIns.Instance
    val module = ModuleDescriptorImpl(Name.special("<visitor-probe>"), storage, builtIns)
    val type = builtIns.stringType
    val function = IrSimpleBuiltinOperatorDescriptorImpl(module, Name.identifier("function"), type)
    val builtinParameter = IrBuiltinValueParameterDescriptorImpl(function, Name.identifier("builtinParameter"), 0, type)
    val valueParameter = ValueParameterDescriptorImpl(
        function, null, 0, Annotations.EMPTY, Name.identifier("valueParameter"), type,
        false, false, false, null, SourceElement.NO_SOURCE
    )
    val strings = ProtoBuf.StringTable.newBuilder().addString("Alias").build()
    val metadataAlias = DeserializedTypeAliasDescriptor(
        storage, module, Annotations.EMPTY, Name.identifier("Alias"), DescriptorVisibilities.PUBLIC,
        ProtoBuf.TypeAlias.newBuilder().setName(0).build(), NameResolverImpl(strings, ProtoBuf.QualifiedNameTable.getDefaultInstance()),
        TypeTable(ProtoBuf.TypeTable.getDefaultInstance()), VersionRequirementTable.EMPTY, null
    ).apply { initialize(emptyList(), type, type) }
    val irType = IrDynamicTypeImpl(emptyList(), Variance.INVARIANT)
    val irAlias = IrFactoryImpl.createTypeAlias(
        -1, -1, IrDeclarationOrigin.DEFINED, Name.identifier("IrAlias"), DescriptorVisibilities.PUBLIC,
        IrTypeAliasSymbolImpl(), false, irType
    )
    val implementing = IrImplementingDelegateDescriptorImpl(builtIns.string, type, type, 0)
    val local = LocalVariableDescriptor(module, Annotations.EMPTY, Name.identifier("local"), type, false, true, false, SourceElement.NO_SOURCE)
    val localDelegate = IrLocalDelegatedPropertyDelegateDescriptorImpl(local, type, type)
    val receivers: List<Pair<String, DeclarationDescriptor>> = listOf(
        "module" to module,
        "metadataAlias" to metadataAlias,
        "packageView" to LazyPackageViewDescriptorImpl(module, FqName("view"), storage),
        "packageFragment" to EmptyPackageFragmentDescriptor(module, FqName("fragment")),
        "valueParameter" to valueParameter,
        "errorModule" to ErrorModuleDescriptor,
        "irAlias" to IrBasedTypeAliasDescriptor(irAlias),
        "builtinFunction" to function,
        "builtinParameter" to builtinParameter,
        "irPackage" to IrBuiltinsPackageFragmentDescriptorImpl(module, FqName("irpackage")),
        "implementingDelegate" to implementing,
        "localDelegate" to localDelegate
    )
    val nullable: List<Pair<String, DeclarationDescriptor>> = listOf(
        "nullableFirFragment" to FirPackageFragmentDescriptor(FqName("firfragment"), module),
        "nullableFirView" to FirPackageViewDescriptor(FqName("firview"), module)
    )
    val data = listOf<String?>(null, "", "plain", "한글", "\u0000", "\r\n", "\uD800", "\uDC00", "😀", "null", "visitor", "{ }", "\u2028")
    val visitorType = DeclarationDescriptorVisitor::class.java
    val objectType = Any::class.java
    val owners = mutableSetOf<String>()
    for ((label, receiver) in receivers + nullable) {
        val method = receiver.javaClass.getMethod("accept", visitorType, objectType)
        val owner = method.declaringClass.name
        val bodyOwner = if (label == "module") ModuleDescriptor::class.java.name else owner
        val projected = if (projectedClass != null && receivers.any { it.second === receiver }) {
            val index = projectedOwners!!.indexOf(bodyOwner)
            check(index >= 0)
            projectedClass.getMethod("entry$index", Class.forName(bodyOwner), visitorType, objectType)
        } else null
        fun invoke(visitor: Any?, data: Any?): Any? = if (projected == null)
            method.invoke(receiver, visitor, data) else projected.invoke(null, receiver, visitor, data)
        if (receivers.any { it.second === receiver }) {
            check(owners.add(owner))
            println("entry-check:$bodyOwner\t" + simpleResult { invoke(null, null) })
        }
        for ((index, input) in data.withIndex()) {
            println("$label:$owner:null:$index\t" + encode(input) + "\t" + result { invoke(null, input) })
            for (mode in 0..2) {
                var calls = 0
                val visitor = object : DeclarationDescriptorVisitorEmptyBodies<String?, String?>() {
                    override fun visitDeclarationDescriptor(descriptor: DeclarationDescriptor, data: String?): String? {
                        check(descriptor === receiver && data === input)
                        calls++
                        if (mode == 2) throw IllegalArgumentException("visitor:" + encode(data))
                        return if (mode == 1) null else data
                    }
                }
                val outcome = result { invoke(visitor, input) }
                if (label == "errorModule" || label == "nullableFirView") check(calls == 0) else check(calls == 1)
                println("$label:$owner:$mode:$index\t" + encode(input) + "\t$outcome\t$calls")
            }
        }
        // Boxed generic return/data use a separate actual visitor type specialization.
        val boxed = object : DeclarationDescriptorVisitorEmptyBodies<Long?, Int?>() {
            override fun visitDeclarationDescriptor(descriptor: DeclarationDescriptor, data: Int?): Long? {
                check(descriptor === receiver)
                return data?.toLong()?.times(1_000_000_001L)
            }
        }
        for (input in listOf<Int?>(null, 0, -1, Int.MIN_VALUE, Int.MAX_VALUE))
            println("$label:boxed:$input\t" + result { invoke(boxed, input) })
    }
    check(owners.size == 12)
    val default = MethodHandles.privateLookupIn(ModuleDescriptor::class.java, MethodHandles.lookup())
        .findSpecial(ModuleDescriptor::class.java, "accept",
            MethodType.methodType(objectType, visitorType, objectType), ModuleDescriptor::class.java).bindTo(module)
    println("actual-interface-default-null\t" + result { default.invokeWithArguments(null, null) })
    // Genuine nullable Void overrides are observed unchanged on JVM; their common mapping is unclosed.
    for ((label, receiver) in nullable) {
        val method = receiver.javaClass.getMethod("acceptVoid", visitorType)
        println("$label:originalNullableVoidNull\t" + result { method.invoke(receiver, null) })
    }
}
