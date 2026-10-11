/*
 * Copyright 2010-2019 JetBrains s.r.o. and Kotlin Programming Language contributors.
 * Use of this source code is governed by the Apache 2.0 license that can be found in the license/LICENSE.txt file.
 */
package org.jetbrains.kotlin.descriptors.impl

import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.CallableDescriptor.UserDataKey
import org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.Kind
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.descriptors.annotations.composeAnnotations
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.resolve.DescriptorFactory
import org.jetbrains.kotlin.resolve.scopes.receivers.ExtensionReceiver
import org.jetbrains.kotlin.resolve.scopes.receivers.ImplicitContextReceiver
import org.jetbrains.kotlin.types.*
import org.jetbrains.kotlin.utils.SmartList

abstract class FunctionDescriptorImpl protected constructor(
    containingDeclaration: DeclarationDescriptor,
    original: FunctionDescriptor?,
    annotations: Annotations,
    name: Name,
    private val kind: Kind,
    source: SourceElement,
) : DeclarationDescriptorNonRootImpl(containingDeclaration, annotations, name, source), FunctionDescriptor {
    private var typeParameters: List<TypeParameterDescriptor>? = null
    private var unsubstitutedValueParameters: List<ValueParameterDescriptor>? = null
    private var unsubstitutedReturnType: KotlinType? = null
    private var contextReceiverParameters: List<ReceiverParameterDescriptor>? = null
    private var extensionReceiverParameter: ReceiverParameterDescriptor? = null
    private var dispatchReceiverParameter: ReceiverParameterDescriptor? = null
    private var modality: Modality? = null
    private var visibility: DescriptorVisibility = DescriptorVisibilities.UNKNOWN
    private var isOperator = false
    private var isInfix = false
    private var isExternal = false
    private var isInline = false
    private var isTailrec = false
    private var isExpect = false
    private var isActual = false
    // Clash hiding also prohibits super calls; resolution hiding propagates to overrides.
    private var isHiddenToOvercomeSignatureClash = false
    private var isHiddenForResolutionEverywhereBesideSupercalls = false
    private var isSuspend = false
    private var hasStableParameterNames = true
    private var hasSynthesizedParameterNames = false
    private var overriddenFunctions: Collection<FunctionDescriptor>? = null
    // The compiler Worker is serial. Publication order is preserved; cross-thread JVM
    // volatile semantics are outside this common-source execution contract.
    private var lazyOverriddenFunctionsTask: (() -> Collection<FunctionDescriptor>)? = null
    private val original: FunctionDescriptor = original ?: this
    private var initialSignatureDescriptor: FunctionDescriptor? = null
    @kotlin.jvm.JvmField
    protected var userDataMap: MutableMap<UserDataKey<*>?, Any?>? = null

    open fun initialize(
        extensionReceiverParameter: ReceiverParameterDescriptor?,
        dispatchReceiverParameter: ReceiverParameterDescriptor?,
        contextReceiverParameters: List<ReceiverParameterDescriptor>,
        typeParameters: List<TypeParameterDescriptor>,
        unsubstitutedValueParameters: List<ValueParameterDescriptor>,
        unsubstitutedReturnType: KotlinType?,
        modality: Modality?,
        visibility: DescriptorVisibility,
    ): FunctionDescriptorImpl {
        this.typeParameters = typeParameters.toList()
        this.unsubstitutedValueParameters = unsubstitutedValueParameters.toList()
        this.unsubstitutedReturnType = unsubstitutedReturnType
        this.modality = modality
        this.visibility = visibility
        this.extensionReceiverParameter = extensionReceiverParameter
        this.dispatchReceiverParameter = dispatchReceiverParameter
        this.contextReceiverParameters = contextReceiverParameters
        for (i in typeParameters.indices) {
            val parameter = typeParameters[i]
            if (parameter.getIndex() != i) {
                throw IllegalStateException("$parameter index is ${parameter.getIndex()} but position is $i")
            }
        }
        for (i in unsubstitutedValueParameters.indices) {
            val firstValueParameterOffset = 0 // receiverParameter.exists() ? 1 : 0;
            val parameter = unsubstitutedValueParameters[i]
            if (parameter.index != i + firstValueParameterOffset) {
                throw IllegalStateException("${parameter}index is ${parameter.index} but position is $i")
            }
        }
        return this
    }

    open fun setVisibility(visibility: DescriptorVisibility) { this.visibility = visibility }
    open fun setOperator(isOperator: Boolean) { this.isOperator = isOperator }
    open fun setInfix(isInfix: Boolean) { this.isInfix = isInfix }
    open fun setExternal(isExternal: Boolean) { this.isExternal = isExternal }
    open fun setInline(isInline: Boolean) { this.isInline = isInline }
    open fun setTailrec(isTailrec: Boolean) { this.isTailrec = isTailrec }
    open fun setExpect(isExpect: Boolean) { this.isExpect = isExpect }
    open fun setActual(isActual: Boolean) { this.isActual = isActual }
    private fun setHiddenToOvercomeSignatureClash(value: Boolean) { isHiddenToOvercomeSignatureClash = value }
    private fun setHiddenForResolutionEverywhereBesideSupercalls(value: Boolean) { isHiddenForResolutionEverywhereBesideSupercalls = value }
    open fun setSuspend(suspend: Boolean) { isSuspend = suspend }
    open fun setReturnType(unsubstitutedReturnType: KotlinType) {
        // The upstream "already set" check deliberately has no active action.
        this.unsubstitutedReturnType = unsubstitutedReturnType
    }
    open fun setHasStableParameterNames(value: Boolean) { hasStableParameterNames = value }
    open fun setHasSynthesizedParameterNames(value: Boolean) { hasSynthesizedParameterNames = value }
    open fun setExtensionReceiverParameter(value: ReceiverParameterDescriptor) { extensionReceiverParameter = value }
    override fun getContextReceiverParameters(): List<ReceiverParameterDescriptor> = contextReceiverParameters!!
    override fun getExtensionReceiverParameter(): ReceiverParameterDescriptor? = extensionReceiverParameter
    override fun getDispatchReceiverParameter(): ReceiverParameterDescriptor? = dispatchReceiverParameter
    override fun getOverriddenDescriptors(): Collection<FunctionDescriptor> {
        performOverriddenLazyCalculationIfNeeded()
        return overriddenFunctions ?: emptyList()
    }
    private fun performOverriddenLazyCalculationIfNeeded() {
        val task = lazyOverriddenFunctionsTask
        if (task != null) {
            overriddenFunctions = task()
            // Preserve upstream's publication-before-clearing order.
            lazyOverriddenFunctionsTask = null
        }
    }
    override fun getModality(): Modality = modality!!
    override fun getVisibility(): DescriptorVisibility = visibility
    override fun isOperator(): Boolean {
        if (isOperator) return true
        for (descriptor in getOriginal().getOverriddenDescriptors()) if (descriptor.isOperator()) return true
        return false
    }
    override fun isInfix(): Boolean {
        if (isInfix) return true
        for (descriptor in getOriginal().getOverriddenDescriptors()) if (descriptor.isInfix()) return true
        return false
    }
    override fun isExternal(): Boolean = isExternal
    override fun isInline(): Boolean = isInline
    override fun isTailrec(): Boolean = isTailrec
    override fun isSuspend(): Boolean = isSuspend
    override fun isExpect(): Boolean = isExpect
    override fun isActual(): Boolean = isActual
    @Suppress("UNCHECKED_CAST")
    override fun <V> getUserData(key: UserDataKey<V>?): V? {
        if (userDataMap == null) return null
        return userDataMap!![key] as V?
    }
    override fun isHiddenToOvercomeSignatureClash(): Boolean = isHiddenToOvercomeSignatureClash
    @Suppress("UNCHECKED_CAST")
    override fun setOverriddenDescriptors(overriddenDescriptors: Collection<CallableMemberDescriptor>) {
        overriddenFunctions = overriddenDescriptors as Collection<FunctionDescriptor>
        for (function in overriddenFunctions!!) {
            if (function.isHiddenForResolutionEverywhereBesideSupercalls()) {
                isHiddenForResolutionEverywhereBesideSupercalls = true
                break
            }
        }
    }
    override fun getTypeParameters(): List<TypeParameterDescriptor> {
        val parameters = typeParameters
        if (parameters == null) throw IllegalStateException("typeParameters == null for $this")
        return parameters
    }
    override fun validate() { getTypeParameters() }
    override fun getValueParameters(): List<ValueParameterDescriptor> = unsubstitutedValueParameters!!
    override fun hasStableParameterNames(): Boolean = hasStableParameterNames
    override fun hasSynthesizedParameterNames(): Boolean = hasSynthesizedParameterNames
    override fun getReturnType(): KotlinType? = unsubstitutedReturnType
    override fun getOriginal(): FunctionDescriptor = if (original === this) this else original.getOriginal()
    override fun getKind(): Kind = kind
    override fun substitute(substitutor: TypeSubstitutor): FunctionDescriptor? {
        if (substitutor.isEmpty()) return this
        return newCopyBuilder(substitutor).setOriginal(getOriginal()).setPreserveSourceElement()
            .setJustForTypeSubstitution(true).build()
    }
    private fun getExtensionReceiverParameterType(): KotlinType? {
        if (extensionReceiverParameter == null) return null
        return extensionReceiverParameter!!.getType()
    }
    override fun isHiddenForResolutionEverywhereBesideSupercalls(): Boolean = isHiddenForResolutionEverywhereBesideSupercalls

    open inner class CopyConfiguration(
        @kotlin.jvm.JvmField var substitution: TypeSubstitution,
        @kotlin.jvm.JvmField var newOwner: DeclarationDescriptor,
        @kotlin.jvm.JvmField var newModality: Modality,
        @kotlin.jvm.JvmField var newVisibility: DescriptorVisibility,
        @kotlin.jvm.JvmField var kind: Kind,
        @kotlin.jvm.JvmField var newValueParameterDescriptors: List<ValueParameterDescriptor>,
        @kotlin.jvm.JvmField var newContextReceiverParameters: List<ReceiverParameterDescriptor>,
        @kotlin.jvm.JvmField var newExtensionReceiverParameter: ReceiverParameterDescriptor?,
        @kotlin.jvm.JvmField var newReturnType: KotlinType?,
        @kotlin.jvm.JvmField var name: Name?,
    ) : FunctionDescriptor.CopyBuilder<FunctionDescriptor> {
        // Java permits the enclosing class to read protected/private inner fields.
        // These storage fields are visible here to preserve the same enclosing
        // algorithm without accessor-name collisions; binary visibility is not claimed.
        @kotlin.jvm.JvmField var original: FunctionDescriptor? = null
        @kotlin.jvm.JvmField var dispatchReceiverParameter = this@FunctionDescriptorImpl.dispatchReceiverParameter
        @kotlin.jvm.JvmField var copyOverrides = true
        @kotlin.jvm.JvmField var signatureChange = false
        @kotlin.jvm.JvmField var preserveSourceElement = false
        @kotlin.jvm.JvmField var dropOriginalInContainingParts = false
        @kotlin.jvm.JvmField internal var isHiddenToOvercomeSignatureClash = this@FunctionDescriptorImpl.isHiddenToOvercomeSignatureClash()
        @kotlin.jvm.JvmField internal var newTypeParameters: List<TypeParameterDescriptor>? = null
        @kotlin.jvm.JvmField internal var additionalAnnotations: Annotations? = null
        @kotlin.jvm.JvmField internal var isHiddenForResolutionEverywhereBesideSupercalls = this@FunctionDescriptorImpl.isHiddenForResolutionEverywhereBesideSupercalls()
        @kotlin.jvm.JvmField internal var userDataMap: MutableMap<UserDataKey<*>?, Any?> = LinkedHashMap()
        @kotlin.jvm.JvmField internal var newHasSynthesizedParameterNames: Boolean? = null
        @kotlin.jvm.JvmField var justForTypeSubstitution = false
        override fun setOwner(owner: DeclarationDescriptor): CopyConfiguration { newOwner = owner; return this }
        override fun setModality(modality: Modality): CopyConfiguration { newModality = modality; return this }
        override fun setVisibility(visibility: DescriptorVisibility): CopyConfiguration { newVisibility = visibility; return this }
        override fun setKind(kind: Kind): CopyConfiguration { this.kind = kind; return this }
        override fun setCopyOverrides(copyOverrides: Boolean): CopyConfiguration { this.copyOverrides = copyOverrides; return this }
        override fun setName(name: Name): CopyConfiguration { this.name = name; return this }
        override fun setValueParameters(parameters: List<ValueParameterDescriptor>): CopyConfiguration { newValueParameterDescriptors = parameters; return this }
        override fun setTypeParameters(parameters: List<TypeParameterDescriptor>): CopyConfiguration { newTypeParameters = parameters; return this }
        override fun setReturnType(type: KotlinType): CopyConfiguration { newReturnType = type; return this }
        override fun setContextReceiverParameters(contextReceiverParameters: List<ReceiverParameterDescriptor>): FunctionDescriptor.CopyBuilder<FunctionDescriptor> {
            newContextReceiverParameters = contextReceiverParameters; return this
        }
        override fun setExtensionReceiverParameter(extensionReceiverParameter: ReceiverParameterDescriptor?): CopyConfiguration {
            newExtensionReceiverParameter = extensionReceiverParameter; return this
        }
        override fun setDispatchReceiverParameter(dispatchReceiverParameter: ReceiverParameterDescriptor?): CopyConfiguration {
            this.dispatchReceiverParameter = dispatchReceiverParameter; return this
        }
        override fun setOriginal(original: CallableMemberDescriptor?): CopyConfiguration { this.original = original as FunctionDescriptor?; return this }
        override fun setSignatureChange(): CopyConfiguration { signatureChange = true; return this }
        override fun setPreserveSourceElement(): CopyConfiguration { preserveSourceElement = true; return this }
        override fun setDropOriginalInContainingParts(): CopyConfiguration { dropOriginalInContainingParts = true; return this }
        override fun setHiddenToOvercomeSignatureClash(): CopyConfiguration { isHiddenToOvercomeSignatureClash = true; return this }
        override fun setHiddenForResolutionEverywhereBesideSupercalls(): CopyConfiguration { isHiddenForResolutionEverywhereBesideSupercalls = true; return this }
        override fun setAdditionalAnnotations(additionalAnnotations: Annotations): CopyConfiguration { this.additionalAnnotations = additionalAnnotations; return this }
        open fun setHasSynthesizedParameterNames(value: Boolean): CopyConfiguration { newHasSynthesizedParameterNames = value; return this }
        override fun setSubstitution(substitution: TypeSubstitution): CopyConfiguration { this.substitution = substitution; return this }
        override fun <V> putUserData(userDataKey: UserDataKey<V>, value: V): FunctionDescriptor.CopyBuilder<FunctionDescriptor> { userDataMap[userDataKey] = value; return this }
        override fun build(): FunctionDescriptor? = doSubstitute(this)
        open fun getOriginal(): FunctionDescriptor? = original
        open fun getSubstitution(): TypeSubstitution = substitution
        open fun setJustForTypeSubstitution(value: Boolean): CopyConfiguration { justForTypeSubstitution = value; return this }
    }
    override fun newCopyBuilder(): FunctionDescriptor.CopyBuilder<out FunctionDescriptor?> = newCopyBuilder(TypeSubstitutor.EMPTY)
    protected open fun newCopyBuilder(substitutor: TypeSubstitutor): CopyConfiguration = CopyConfiguration(
        substitutor.getSubstitution(), getContainingDeclaration(), getModality(), getVisibility(), getKind(), getValueParameters(),
        getContextReceiverParameters(), getExtensionReceiverParameter(), getReturnType(), null,
    )
    protected open fun doSubstitute(configuration: CopyConfiguration): FunctionDescriptor? {
        val wereChanges = BooleanArray(1)
        val resultAnnotations = if (configuration.additionalAnnotations != null)
            composeAnnotations(annotations, configuration.additionalAnnotations!!) else annotations
        val substitutedDescriptor = createSubstitutedCopy(configuration.newOwner, configuration.original, configuration.kind,
            configuration.name, resultAnnotations, getSourceToUseForCopy(configuration.preserveSourceElement, configuration.original))
        val unsubstitutedTypeParameters = configuration.newTypeParameters ?: getTypeParameters()
        wereChanges[0] = wereChanges[0] or unsubstitutedTypeParameters.isNotEmpty()
        val substitutedTypeParameters = ArrayList<TypeParameterDescriptor>(unsubstitutedTypeParameters.size)
        val substitutor = DescriptorSubstitutor.substituteTypeParameters(unsubstitutedTypeParameters, configuration.substitution,
            substitutedDescriptor, substitutedTypeParameters, wereChanges) ?: return null
        val substitutedContextReceiverParameters = ArrayList<ReceiverParameterDescriptor>()
        if (configuration.newContextReceiverParameters.isNotEmpty()) {
            var index = 0
            for (newContextReceiverParameter in configuration.newContextReceiverParameters) {
                val type = substitutor.substitute(newContextReceiverParameter.getType(), Variance.IN_VARIANCE) ?: return null
                val parameter = DescriptorFactory.createContextReceiverParameterForCallable(substitutedDescriptor, type,
                    (newContextReceiverParameter.getValue() as ImplicitContextReceiver).customLabelName,
                    newContextReceiverParameter.annotations, index++)
                substitutedContextReceiverParameters.add(parameter!!)
                wereChanges[0] = wereChanges[0] or (type !== newContextReceiverParameter.getType())
            }
        }
        var substitutedReceiverParameter: ReceiverParameterDescriptor? = null
        if (configuration.newExtensionReceiverParameter != null) {
            val type = substitutor.substitute(configuration.newExtensionReceiverParameter!!.getType(), Variance.IN_VARIANCE) ?: return null
            substitutedReceiverParameter = ReceiverParameterDescriptorImpl(substitutedDescriptor,
                ExtensionReceiver(substitutedDescriptor, type, configuration.newExtensionReceiverParameter!!.getValue()),
                configuration.newExtensionReceiverParameter!!.annotations)
            wereChanges[0] = wereChanges[0] or (type !== configuration.newExtensionReceiverParameter!!.getType())
        }
        var substitutedExpectedThis: ReceiverParameterDescriptor? = null
        if (configuration.dispatchReceiverParameter != null) {
            // Keep the Base dispatch-receiver type in a Derived fake override;
            // replacing it with Derived would incorrectly require a smart cast.
            substitutedExpectedThis = configuration.dispatchReceiverParameter!!.substitute(substitutor) ?: return null
            wereChanges[0] = wereChanges[0] or (substitutedExpectedThis !== configuration.dispatchReceiverParameter)
        }
        val substitutedValueParameters = getSubstitutedValueParameters(substitutedDescriptor, configuration.newValueParameterDescriptors,
            substitutor, configuration.dropOriginalInContainingParts, configuration.preserveSourceElement, wereChanges) ?: return null
        val substitutedReturnType = substitutor.substitute(configuration.newReturnType!!, Variance.OUT_VARIANCE) ?: return null
        wereChanges[0] = wereChanges[0] or (substitutedReturnType !== configuration.newReturnType)
        if (!wereChanges[0] && configuration.justForTypeSubstitution) return this
        substitutedDescriptor.initialize(substitutedReceiverParameter, substitutedExpectedThis, substitutedContextReceiverParameters,
            substitutedTypeParameters, substitutedValueParameters, substitutedReturnType, configuration.newModality, configuration.newVisibility)
        substitutedDescriptor.setOperator(isOperator)
        substitutedDescriptor.setInfix(isInfix)
        substitutedDescriptor.setExternal(isExternal)
        substitutedDescriptor.setInline(isInline)
        substitutedDescriptor.setTailrec(isTailrec)
        substitutedDescriptor.setSuspend(isSuspend)
        substitutedDescriptor.setExpect(isExpect)
        substitutedDescriptor.setActual(isActual)
        substitutedDescriptor.setHasStableParameterNames(hasStableParameterNames)
        substitutedDescriptor.setHiddenToOvercomeSignatureClash(configuration.isHiddenToOvercomeSignatureClash)
        substitutedDescriptor.setHiddenForResolutionEverywhereBesideSupercalls(configuration.isHiddenForResolutionEverywhereBesideSupercalls)
        substitutedDescriptor.setHasSynthesizedParameterNames(configuration.newHasSynthesizedParameterNames ?: hasSynthesizedParameterNames)
        if (configuration.userDataMap.isNotEmpty() || userDataMap != null) {
            val newMap = configuration.userDataMap
            if (userDataMap != null) {
                for (entry in userDataMap!!.entries) if (!newMap.containsKey(entry.key)) newMap[entry.key] = entry.value
            }
            substitutedDescriptor.userDataMap = if (newMap.size == 1)
                FunctionSingletonMap(newMap.keys.iterator().next(), newMap.values.iterator().next()) else newMap
        }
        if (configuration.signatureChange || getInitialSignatureDescriptor() != null) {
            val initialSignature = if (getInitialSignatureDescriptor() != null) getInitialSignatureDescriptor()!! else this
            substitutedDescriptor.setInitialSignatureDescriptor(initialSignature.substitute(substitutor))
        }
        if (configuration.copyOverrides && getOriginal().getOverriddenDescriptors().isNotEmpty()) {
            if (configuration.substitution.isEmpty()) {
                val task = lazyOverriddenFunctionsTask
                if (task != null) substitutedDescriptor.lazyOverriddenFunctionsTask = task
                else substitutedDescriptor.setOverriddenDescriptors(getOverriddenDescriptors())
            } else {
                substitutedDescriptor.lazyOverriddenFunctionsTask = {
                    // Java's collection accepts nullable substitution results. Preserve
                    // those elements without adding an eager assertion at insertion.
                    val result = SmartList<FunctionDescriptor?>()
                    for (function in getOverriddenDescriptors()) result.add(function.substitute(substitutor))
                    @Suppress("UNCHECKED_CAST")
                    (result as Collection<FunctionDescriptor>)
                }
            }
        }
        return substitutedDescriptor
    }
    override fun copy(newOwner: DeclarationDescriptor?, modality: Modality?, visibility: DescriptorVisibility?, kind: Kind?, copyOverrides: Boolean): FunctionDescriptor =
        newCopyBuilder().setOwner(newOwner!!).setModality(modality!!).setVisibility(visibility!!).setKind(kind!!).setCopyOverrides(copyOverrides).build()!!
    protected abstract fun createSubstitutedCopy(newOwner: DeclarationDescriptor, original: FunctionDescriptor?, kind: Kind,
        newName: Name?, annotations: Annotations, source: SourceElement): FunctionDescriptorImpl
    private fun getSourceToUseForCopy(preserveSource: Boolean, original: FunctionDescriptor?): SourceElement =
        if (preserveSource) (original ?: getOriginal()).getSource() else SourceElement.NO_SOURCE
    override fun <R, D> accept(visitor: DeclarationDescriptorVisitor<R, D>?, data: D): R = visitor!!.visitFunctionDescriptor(this, data)
    override fun getInitialSignatureDescriptor(): FunctionDescriptor? = initialSignatureDescriptor
    private fun setInitialSignatureDescriptor(value: FunctionDescriptor?) { initialSignatureDescriptor = value }
    // Don't use on published descriptors.
    open fun <V> putInUserDataMap(key: UserDataKey<V>?, value: Any?) {
        if (userDataMap == null) userDataMap = LinkedHashMap()
        userDataMap!![key] = value
    }
    companion object {
        @kotlin.jvm.JvmStatic
        fun getSubstitutedValueParameters(substitutedDescriptor: FunctionDescriptor, unsubstitutedValueParameters: List<ValueParameterDescriptor>,
            substitutor: TypeSubstitutor): List<ValueParameterDescriptor>? =
            getSubstitutedValueParameters(substitutedDescriptor, unsubstitutedValueParameters, substitutor, false, false, null)
        @kotlin.jvm.JvmStatic
        fun getSubstitutedValueParameters(substitutedDescriptor: FunctionDescriptor, unsubstitutedValueParameters: List<ValueParameterDescriptor>,
            substitutor: TypeSubstitutor, dropOriginal: Boolean, preserveSourceElement: Boolean, wereChanges: BooleanArray?): List<ValueParameterDescriptor>? {
            val result = ArrayList<ValueParameterDescriptor>(unsubstitutedValueParameters.size)
            for (parameter in unsubstitutedValueParameters) {
                val substitutedType = substitutor.substitute(parameter.getType(), Variance.IN_VARIANCE)
                val varargElementType = parameter.varargElementType
                val substituteVarargElementType = if (varargElementType == null) null else substitutor.substitute(varargElementType, Variance.IN_VARIANCE)
                if (substitutedType == null) return null
                if (substitutedType !== parameter.getType() || varargElementType !== substituteVarargElementType) {
                    if (wereChanges != null) wereChanges[0] = true
                }
                var destructuringVariablesAction: (() -> List<VariableDescriptor>)? = null
                if (parameter is ValueParameterDescriptorImpl.WithDestructuringDeclaration) {
                    val destructuringVariables = parameter.destructuringVariables
                    destructuringVariablesAction = { destructuringVariables }
                }
                result.add(ValueParameterDescriptorImpl.createWithDestructuringDeclarations(substitutedDescriptor,
                    if (dropOriginal) null else parameter, parameter.index, parameter.annotations, parameter.getName(), substitutedType,
                    parameter.declaresDefaultValue(), parameter.isCrossinline, parameter.isNoinline, substituteVarargElementType,
                    if (preserveSourceElement) parameter.getSource() else SourceElement.NO_SOURCE, destructuringVariablesAction))
            }
            return result
        }
    }
}

/** The mutable Map surface exposed by Java Collections.singletonMap rejects writes.
 * A read-only Kotlin map plus a MutableMap cast would throw ClassCastException on
 * Wasm instead. This adapter retains the one-entry map and mutation semantics used
 * by published function descriptor user data, including its entry view. */
private class FunctionSingletonMap<K, V>(private val key: K, private val value: V) : AbstractMutableMap<K, V>() {
    override val size: Int get() = 1
    override fun containsKey(key: K): Boolean = this.key == key
    override fun containsValue(value: V): Boolean = this.value == value
    override fun get(key: K): V? = if (this.key == key) value else null
    override fun put(key: K, value: V): V? = throw UnsupportedOperationException()
    override fun clear(): Unit = throw UnsupportedOperationException()
    override val entries: MutableSet<MutableMap.MutableEntry<K, V>> = object : AbstractMutableSet<MutableMap.MutableEntry<K, V>>() {
        override val size: Int get() = 1
        override fun add(element: MutableMap.MutableEntry<K, V>): Boolean = throw UnsupportedOperationException()
        override fun iterator(): MutableIterator<MutableMap.MutableEntry<K, V>> = object : MutableIterator<MutableMap.MutableEntry<K, V>> {
            private var available = true
            override fun hasNext(): Boolean = available
            override fun next(): MutableMap.MutableEntry<K, V> {
                if (!available) throw NoSuchElementException()
                available = false
                return object : MutableMap.MutableEntry<K, V> {
                    override val key: K get() = this@FunctionSingletonMap.key
                    override val value: V get() = this@FunctionSingletonMap.value
                    override fun setValue(newValue: V): V = throw UnsupportedOperationException()
                    override fun equals(other: Any?): Boolean = other is Map.Entry<*, *> && key == other.key && value == other.value
                    override fun hashCode(): Int = (key?.hashCode() ?: 0) xor (value?.hashCode() ?: 0)
                    override fun toString(): String = "$key=$value"
                }
            }
            override fun remove(): Unit = throw UnsupportedOperationException()
        }
    }
}
