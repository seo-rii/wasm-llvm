/* Copyright 2000-2018 JetBrains s.r.o. and Kotlin Programming Language contributors. Apache-2.0. */
package org.jetbrains.kotlin.descriptors.impl

import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.resolve.DescriptorUtils
import org.jetbrains.kotlin.resolve.descriptorUtil.getKotlinTypeRefiner
import org.jetbrains.kotlin.resolve.scopes.MemberScope
import org.jetbrains.kotlin.resolve.scopes.SubstitutingScope
import org.jetbrains.kotlin.storage.LockBasedStorageManager
import org.jetbrains.kotlin.types.*
import org.jetbrains.kotlin.types.checker.KotlinTypeRefiner
import org.jetbrains.kotlin.portable.assertions.compilerAssert

@OptIn(TypeRefinement::class)
open class LazySubstitutingClassDescriptor(private val original: ModuleAwareClassDescriptor, private val originalSubstitutor: TypeSubstitutor) : ModuleAwareClassDescriptor() {
    private var newSubstitutor: TypeSubstitutor? = null
    private var typeConstructorParameters: MutableList<TypeParameterDescriptor>? = null
    private var declaredTypeParameters: List<TypeParameterDescriptor>? = null
    private var typeConstructor: TypeConstructor? = null
    private fun getSubstitutor(): TypeSubstitutor {
        if (newSubstitutor == null) {
            if (originalSubstitutor.isEmpty()) newSubstitutor = originalSubstitutor
            else {
                val originalParameters = original.getTypeConstructor().getParameters()
                val parameters = ArrayList<TypeParameterDescriptor>(originalParameters.size)
                typeConstructorParameters = parameters
                newSubstitutor = DescriptorSubstitutor.substituteTypeParameters(originalParameters, originalSubstitutor.getSubstitution(), this, parameters)
                declaredTypeParameters = parameters.filter { !it.isCapturedFromOuterDeclaration() }
            }
        }
        return newSubstitutor!!
    }
    override fun getTypeConstructor(): TypeConstructor {
        val originalConstructor = original.getTypeConstructor()
        if (originalSubstitutor.isEmpty()) return originalConstructor
        if (typeConstructor == null) {
            val substitutor = getSubstitutor()
            val originalSupertypes = originalConstructor.getSupertypes()
            val supertypes = ArrayList<KotlinType?>(originalSupertypes.size)
            for (supertype in originalSupertypes) supertypes.add(substitutor.substitute(supertype, Variance.INVARIANT))
            @Suppress("UNCHECKED_CAST")
            val carrier = supertypes as Collection<KotlinType>
            typeConstructor = ClassTypeConstructorImpl(this, typeConstructorParameters!!, carrier, LockBasedStorageManager.NO_LOCKS)
        }
        return typeConstructor!!
    }
    public override fun getMemberScope(typeArguments: List<TypeProjection>, kotlinTypeRefiner: KotlinTypeRefiner): MemberScope {
        val scope = original.getClassPortRefinedMemberScope(typeArguments, kotlinTypeRefiner)
        return if (originalSubstitutor.isEmpty()) scope else SubstitutingScope(scope, getSubstitutor())
    }
    public override fun getMemberScope(typeSubstitution: TypeSubstitution, kotlinTypeRefiner: KotlinTypeRefiner): MemberScope {
        val scope = original.getRefinedMemberScopeIfPossible(typeSubstitution, kotlinTypeRefiner)
        return if (originalSubstitutor.isEmpty()) scope else SubstitutingScope(scope, getSubstitutor())
    }
    override fun getMemberScope(typeArguments: List<TypeProjection>): MemberScope = getMemberScope(typeArguments, DescriptorUtils.getContainingModule(this).getKotlinTypeRefiner())
    override fun getMemberScope(typeSubstitution: TypeSubstitution): MemberScope = getMemberScope(typeSubstitution, DescriptorUtils.getContainingModule(this).getKotlinTypeRefiner())
    override fun getUnsubstitutedMemberScope(): MemberScope = getUnsubstitutedMemberScope(DescriptorUtils.getContainingModule(original).getKotlinTypeRefiner())
    public override fun getUnsubstitutedMemberScope(kotlinTypeRefiner: KotlinTypeRefiner): MemberScope {
        val scope = original.getRefinedUnsubstitutedMemberScopeIfPossible(kotlinTypeRefiner)
        return if (originalSubstitutor.isEmpty()) scope else SubstitutingScope(scope, getSubstitutor())
    }
    override fun getStaticScope(): MemberScope = original.getStaticScope()
    override fun getDefaultType(): SimpleType {
        val projections = TypeUtils.getDefaultTypeProjections(getTypeConstructor().getParameters())
        return KotlinTypeFactory.simpleTypeWithNonTrivialMemberScope(
            DefaultTypeAttributeTranslator.toAttributes(annotations, null, null), getTypeConstructor(),
            projections, false, getUnsubstitutedMemberScope())
    }
    override fun getThisAsReceiverParameter(): ReceiverParameterDescriptor = throw UnsupportedOperationException()
    override fun getContextReceivers(): List<ReceiverParameterDescriptor> = emptyList()
    override fun getConstructors(): Collection<ClassConstructorDescriptor> {
        val constructors = original.getConstructors()
        val result = ArrayList<ClassConstructorDescriptor?>(constructors.size)
        for (constructor in constructors) {
            val copy = constructor.newCopyBuilder().setOriginal(constructor.getOriginal()).setModality(constructor.getModality())
                .setVisibility(constructor.getVisibility()).setKind(constructor.getKind()).setCopyOverrides(false).build() as ClassConstructorDescriptor?
            result.add(copy!!.substitute(getSubstitutor()))
        }
        @Suppress("UNCHECKED_CAST")
        return result as Collection<ClassConstructorDescriptor>
    }
    override val annotations: Annotations get() = original.annotations
    override fun getName(): Name = original.getName()
    override fun getOriginal(): ClassDescriptor = original.getOriginal()
    override fun getContainingDeclaration(): DeclarationDescriptor = original.getContainingDeclaration()
    override fun substitute(substitutor: TypeSubstitutor): ClassDescriptor =
        if (substitutor.isEmpty()) this else LazySubstitutingClassDescriptor(this,
            TypeSubstitutor.createChainedSubstitutor(substitutor.getSubstitution(), getSubstitutor().getSubstitution()))
    override fun getCompanionObjectDescriptor(): ClassDescriptor? = original.getCompanionObjectDescriptor()
    override fun getKind(): ClassKind = original.getKind()
    override fun getModality(): Modality = original.getModality()
    override fun getVisibility(): DescriptorVisibility = original.getVisibility()
    override fun isInner(): Boolean = original.isInner()
    override fun isData(): Boolean = original.isData()
    override fun isInline(): Boolean = original.isInline()
    override fun isFun(): Boolean = original.isFun()
    override fun isValue(): Boolean = original.isValue()
    override fun isExternal(): Boolean = original.isExternal()
    override fun isCompanionObject(): Boolean = original.isCompanionObject()
    override fun isExpect(): Boolean = original.isExpect()
    override fun isActual(): Boolean = original.isActual()
    override fun <R, D> accept(visitor: DeclarationDescriptorVisitor<R, D>?, data: D): R = visitor!!.visitClassDescriptor(this, data)
    override fun acceptVoid(visitor: DeclarationDescriptorVisitor<Nothing?, Nothing?>?): Unit = throw UnsupportedOperationException()
    override fun getUnsubstitutedInnerClassesScope(): MemberScope = original.getUnsubstitutedInnerClassesScope()
    override fun getUnsubstitutedPrimaryConstructor(): ClassConstructorDescriptor? = original.getUnsubstitutedPrimaryConstructor()
    override fun getSource(): SourceElement = SourceElement.NO_SOURCE
    override fun getDeclaredTypeParameters(): List<TypeParameterDescriptor> { getSubstitutor(); return declaredTypeParameters!! }
    override fun getSealedSubclasses(): Collection<ClassDescriptor> = original.getSealedSubclasses()
    override fun getValueClassRepresentation(): ValueClassRepresentation<SimpleType>? =
        original.getValueClassRepresentation()?.mapUnderlyingType { substituteSimpleType(it)!! }
    override fun getDefaultFunctionTypeForSamInterface(): SimpleType? = substituteSimpleType(original.getDefaultFunctionTypeForSamInterface())
    private fun substituteSimpleType(type: SimpleType?): SimpleType? {
        if (type == null || originalSubstitutor.isEmpty()) return type
        val substituted = getSubstitutor().substitute(type, Variance.INVARIANT)
        compilerAssert(substituted is SimpleType) { "Substitution for SimpleType should also be a SimpleType, but it is $substituted\nUnsubstituted: $type" }
        return substituted as SimpleType
    }
    override fun isDefinitelyNotSamInterface(): Boolean = original.isDefinitelyNotSamInterface()
}
