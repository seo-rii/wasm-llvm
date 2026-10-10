package org.jetbrains.kotlin.portable.copybuilder.probe

import org.jetbrains.kotlin.builtins.DefaultBuiltIns
import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.descriptors.impl.FunctionDescriptorImpl
import org.jetbrains.kotlin.incremental.components.NoLookupLocation
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.types.TypeSubstitution
import org.jetbrains.kotlin.types.error.*

private fun nullableFunction(builder: FunctionDescriptor.CopyBuilder<SimpleFunctionDescriptor?>): SimpleFunctionDescriptor? = builder.build()
private fun nullableCallable(builder: CallableMemberDescriptor.CopyBuilder<SimpleFunctionDescriptor?>): SimpleFunctionDescriptor? = builder.build()
private fun nonnullFunction(builder: FunctionDescriptor.CopyBuilder<FunctionDescriptor>): FunctionDescriptor? = builder.build()
private fun propertyBuilder(property: PropertyDescriptor): CallableMemberDescriptor.CopyBuilder<out PropertyDescriptor?> = property.newCopyBuilder()
private fun hex(text: String?): String = text?.map { it.code.toString(16).padStart(4, '0') }?.joinToString("") ?: "null"

@OptIn(org.jetbrains.kotlin.K1Deprecation::class)
fun main() {
    val rows = mutableListOf<String>()
    fun emit(key: String, action: () -> String) { rows += key + "\t" + try { action() } catch (failure: Throwable) { failure::class.simpleName + ":" + hex(failure.message) } }
    val builtIns = DefaultBuiltIns.Instance
    val module = builtIns.builtInsModule
    val error = ErrorFunctionDescriptor(ErrorClassDescriptor(Name.special("<builder-owner>")))
    val originalName = error.name
    val originalReturnType = error.returnType
    for (index in 0..63) {
        val builder: FunctionDescriptor.CopyBuilder<SimpleFunctionDescriptor?> = error.newCopyBuilder()
        emit("nullable-function:$index") { (nullableFunction(builder) === error).toString() }
        emit("nullable-callable:$index") { (nullableCallable(builder) === error).toString() }
        emit("fresh-builder:$index") { (builder !== error.newCopyBuilder()).toString() }
        val steps = listOf<Pair<String, () -> Any?>>(
            "owner" to { builder.setOwner(module) }, "modality" to { builder.setModality(Modality.FINAL) },
            "visibility" to { builder.setVisibility(DescriptorVisibilities.PUBLIC) },
            "kind" to { builder.setKind(CallableMemberDescriptor.Kind.SYNTHESIZED) },
            "copyOverrides" to { builder.setCopyOverrides(index % 2 == 0) },
            "name" to { builder.setName(Name.identifier("name$index")) },
            "substitution" to { builder.setSubstitution(TypeSubstitution.EMPTY) },
            "values" to { builder.setValueParameters(emptyList()) }, "types" to { builder.setTypeParameters(emptyList()) },
            "return" to { builder.setReturnType(builtIns.anyType) },
            "contexts" to { builder.setContextReceiverParameters(emptyList()) },
            "extension-null" to { builder.setExtensionReceiverParameter(null) },
            "dispatch-null" to { builder.setDispatchReceiverParameter(null) },
            "original-null" to { builder.setOriginal(null) },
            "signature" to { builder.setSignatureChange() }, "source" to { builder.setPreserveSourceElement() },
            "drop-original" to { builder.setDropOriginalInContainingParts() },
            "hidden-clash" to { builder.setHiddenToOvercomeSignatureClash() },
            "hidden-resolution" to { builder.setHiddenForResolutionEverywhereBesideSupercalls() },
            "annotations" to { builder.setAdditionalAnnotations(Annotations.EMPTY) },
            "userdata-null" to { builder.putUserData(object : CallableDescriptor.UserDataKey<String?> {}, null) },
            "userdata-value" to { builder.putUserData(object : CallableDescriptor.UserDataKey<String> {}, "value$index") },
        )
        for (step in steps) emit("identity:$index:${step.first}") { (step.second() === builder).toString() }
        emit("build:$index") { (builder.build() === error).toString() }
        emit("no-mutation:$index") { (error.name === originalName).toString() + ':' + (error.returnType === originalReturnType) }
    }
    val native = builtIns.any.unsubstitutedMemberScope.getContributedFunctions(Name.identifier("toString"), NoLookupLocation.FROM_TEST).single()
    val configuration = native.newCopyBuilder() as FunctionDescriptorImpl.CopyConfiguration
    val nonnull: FunctionDescriptor.CopyBuilder<FunctionDescriptor> = configuration
    emit("actual-nonnull-configuration") { (nonnull === configuration).toString() }
    emit("actual-nonnull-build") { nonnullFunction(nonnull)?.name?.asString() ?: "null" }
    val property = builtIns.string.unsubstitutedMemberScope.getContributedVariables(Name.identifier("length"), NoLookupLocation.FROM_TEST).single()
    emit("actual-property-build") { propertyBuilder(property).build()?.name?.asString() ?: "null" }
    print(rows.joinToString("\n", postfix = "\n"))
}
