/* Copyright 2010-2017 JetBrains s.r.o. Apache-2.0.
 * Private complete-source prototype of the pinned OverridingUtil.java.
 */
package org.jetbrains.kotlin.resolve

import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.impl.FunctionDescriptorImpl
import org.jetbrains.kotlin.descriptors.impl.PropertyAccessorDescriptorImpl
import org.jetbrains.kotlin.descriptors.impl.PropertyDescriptorImpl
import org.jetbrains.kotlin.ir.ObsoleteDescriptorBasedAPI
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.resolve.descriptorUtil.isTypeRefinementEnabled
import org.jetbrains.kotlin.resolve.descriptorUtil.module
import org.jetbrains.kotlin.types.*
import org.jetbrains.kotlin.types.checker.KotlinTypeChecker
import org.jetbrains.kotlin.types.checker.KotlinTypePreparator
import org.jetbrains.kotlin.types.checker.KotlinTypeRefiner
import org.jetbrains.kotlin.types.model.KotlinTypeMarker
import org.jetbrains.kotlin.utils.SmartSet
import org.jetbrains.kotlin.portable.assertions.compilerAssert
import org.jetbrains.kotlin.portable.overriding.OverridingHostContext
import org.jetbrains.kotlin.resolve.OverridingUtil.OverrideCompatibilityInfo.Result.*

open class OverridingUtil private constructor(
    private val equalityAxioms: KotlinTypeChecker.TypeConstructorEquality,
    private val kotlinTypeRefiner: KotlinTypeRefiner,
    private val kotlinTypePreparator: KotlinTypePreparator,
    private val customSubtype: ((KotlinType, KotlinType) -> Boolean)?,
) {
    open fun isOverridableBy(superDescriptor: CallableDescriptor, subDescriptor: CallableDescriptor, subClassDescriptor: ClassDescriptor?): OverrideCompatibilityInfo =
        isOverridableBy(superDescriptor, subDescriptor, subClassDescriptor, false)

    open fun isOverridableBy(superDescriptor: CallableDescriptor, subDescriptor: CallableDescriptor, subClassDescriptor: ClassDescriptor?, checkReturnType: Boolean): OverrideCompatibilityInfo {
        val basicResult = isOverridableByWithoutExternalConditions(superDescriptor, subDescriptor, checkReturnType)
        var wasSuccess = basicResult.getResult() == OVERRIDABLE
        for (externalCondition in EXTERNAL_CONDITIONS) {
            if (externalCondition.getContract() == ExternalOverridabilityCondition.Contract.CONFLICTS_ONLY) continue
            if (wasSuccess && externalCondition.getContract() == ExternalOverridabilityCondition.Contract.SUCCESS_ONLY) continue
            when (externalCondition.isOverridable(superDescriptor, subDescriptor, subClassDescriptor)) {
                ExternalOverridabilityCondition.Result.OVERRIDABLE -> wasSuccess = true
                ExternalOverridabilityCondition.Result.INCOMPATIBLE -> return OverrideCompatibilityInfo.incompatible("External condition")
                ExternalOverridabilityCondition.Result.UNKNOWN -> Unit
            }
        }
        if (!wasSuccess) return basicResult
        for (externalCondition in EXTERNAL_CONDITIONS) {
            if (externalCondition.getContract() != ExternalOverridabilityCondition.Contract.CONFLICTS_ONLY) continue
            when (externalCondition.isOverridable(superDescriptor, subDescriptor, subClassDescriptor)) {
                ExternalOverridabilityCondition.Result.INCOMPATIBLE -> return OverrideCompatibilityInfo.incompatible("External condition")
                ExternalOverridabilityCondition.Result.OVERRIDABLE -> throw IllegalStateException(
                    "Contract violation in " + EXTERNAL_SNAPSHOT.className(externalCondition) + " condition. It's not supposed to end with success")
                ExternalOverridabilityCondition.Result.UNKNOWN -> Unit
            }
        }
        return OverrideCompatibilityInfo.success()
    }

    open fun isOverridableByWithoutExternalConditions(superDescriptor: CallableDescriptor, subDescriptor: CallableDescriptor, checkReturnType: Boolean): OverrideCompatibilityInfo {
        val basicOverridability = getBasicOverridabilityProblem(superDescriptor, subDescriptor)
        if (basicOverridability != null) return basicOverridability
        val superValueParameters = compiledValueParameters(superDescriptor)
        val subValueParameters = compiledValueParameters(subDescriptor)
        val superTypeParameters = superDescriptor.getTypeParameters()
        val subTypeParameters = subDescriptor.getTypeParameters()
        if (superTypeParameters.size != subTypeParameters.size) {
            var valueIndex = 0
            while (valueIndex < superValueParameters.size) {
                if (!KotlinTypeChecker.DEFAULT.equalTypes(superValueParameters[valueIndex], subValueParameters[valueIndex])) return OverrideCompatibilityInfo.incompatible("Type parameter number mismatch")
                valueIndex++
            }
            return OverrideCompatibilityInfo.conflict("Type parameter number mismatch")
        }
        val typeCheckerState = createTypeCheckerState(superTypeParameters, subTypeParameters)
        var parameterIndex = 0
        while (parameterIndex < superTypeParameters.size) {
            if (!areTypeParametersEquivalent(superTypeParameters[parameterIndex], subTypeParameters[parameterIndex], typeCheckerState)) return OverrideCompatibilityInfo.incompatible("Type parameter bounds mismatch")
            parameterIndex++
        }
        var valueIndex = 0
        while (valueIndex < superValueParameters.size) {
            if (!areTypesEquivalent(superValueParameters[valueIndex], subValueParameters[valueIndex], typeCheckerState)) return OverrideCompatibilityInfo.incompatible("Value parameter type mismatch")
            valueIndex++
        }
        if (superDescriptor is FunctionDescriptor && subDescriptor is FunctionDescriptor && superDescriptor.isSuspend() != subDescriptor.isSuspend()) return OverrideCompatibilityInfo.conflict("Incompatible suspendability")
        if (checkReturnType) {
            val superReturnType = superDescriptor.getReturnType()
            val subReturnType = subDescriptor.getReturnType()
            if (superReturnType != null && subReturnType != null) {
                val bothErrors = subReturnType.isError && superReturnType.isError
                if (!bothErrors && !AbstractTypeChecker.isSubtypeOf(typeCheckerState, subReturnType.unwrap(), superReturnType.unwrap())) return OverrideCompatibilityInfo.conflict("Return type mismatch")
            }
        }
        return OverrideCompatibilityInfo.success()
    }

    private fun createTypeCheckerState(firstParameters: List<TypeParameterDescriptor>, secondParameters: List<TypeParameterDescriptor>): TypeCheckerState {
        compilerAssert(firstParameters.size == secondParameters.size) { "Should be the same number of type parameters: $firstParameters vs $secondParameters" }
        @Suppress("UNCHECKED_CAST")
        val customSubtypingCallback = customSubtype as ((KotlinTypeMarker, KotlinTypeMarker) -> Boolean?)?
        if (firstParameters.isEmpty()) return OverridingUtilTypeSystemContext(null, equalityAxioms, kotlinTypeRefiner, kotlinTypePreparator, customSubtypingCallback).newTypeCheckerState(true, true, false)
        val matchingTypeConstructors = HashMap<TypeConstructor, TypeConstructor>()
        var parameterIndex = 0
        while (parameterIndex < firstParameters.size) {
            matchingTypeConstructors[firstParameters[parameterIndex].getTypeConstructor()] = secondParameters[parameterIndex].getTypeConstructor()
            parameterIndex++
        }
        return OverridingUtilTypeSystemContext(matchingTypeConstructors, equalityAxioms, kotlinTypeRefiner, kotlinTypePreparator, customSubtypingCallback).newTypeCheckerState(true, true, false)
    }

    open fun generateOverridesInFunctionGroup(name: Name, membersFromSupertypes: Collection<CallableMemberDescriptor>, membersFromCurrent: Collection<CallableMemberDescriptor>, current: ClassDescriptor, strategy: OverridingStrategy) {
        val notOverridden = LinkedHashSet<CallableMemberDescriptor>(membersFromSupertypes)
        for (fromCurrent in membersFromCurrent) {
            val bound = extractAndBindOverridesForMember(fromCurrent, membersFromSupertypes, current, strategy)
            notOverridden.removeAll(bound)
        }
        createAndBindFakeOverrides(current, notOverridden, strategy)
    }

    private fun extractAndBindOverridesForMember(fromCurrent: CallableMemberDescriptor, descriptorsFromSuper: Collection<CallableMemberDescriptor>, current: ClassDescriptor, strategy: OverridingStrategy): Collection<CallableMemberDescriptor> {
        val bound = ArrayList<CallableMemberDescriptor>(descriptorsFromSuper.size)
        val overridden = SmartSet.create<CallableMemberDescriptor>()
        for (fromSupertype in descriptorsFromSuper) {
            val result = isOverridableBy(fromSupertype, fromCurrent, current).getResult()
            val visible = isVisibleForOverride(fromCurrent, fromSupertype, false)
            when (result) {
                OVERRIDABLE -> { if (visible) overridden.add(fromSupertype); bound.add(fromSupertype) }
                CONFLICT -> { if (visible) strategy.overrideConflict(fromSupertype, fromCurrent); bound.add(fromSupertype) }
                INCOMPATIBLE -> Unit
            }
        }
        strategy.setOverriddenDescriptors(fromCurrent, overridden)
        return bound
    }

    companion object {
        private val EXTERNAL_SNAPSHOT = OverridingHostContext.requireSnapshot()
        private val EXTERNAL_CONDITIONS = EXTERNAL_SNAPSHOT.conditions
        private val DEFAULT_TYPE_CONSTRUCTOR_EQUALITY = object : KotlinTypeChecker.TypeConstructorEquality {
            override fun equals(a: TypeConstructor, b: TypeConstructor): Boolean = a == b
        }
        @kotlin.jvm.JvmField
        val DEFAULT = OverridingUtil(DEFAULT_TYPE_CONSTRUCTOR_EQUALITY, KotlinTypeRefiner.Default, KotlinTypePreparator.Default, null)

        @kotlin.jvm.JvmStatic
        fun createWithTypeRefiner(kotlinTypeRefiner: KotlinTypeRefiner): OverridingUtil = OverridingUtil(DEFAULT_TYPE_CONSTRUCTOR_EQUALITY, kotlinTypeRefiner, KotlinTypePreparator.Default, null)
        @kotlin.jvm.JvmStatic
        fun createWithTypePreparatorAndCustomSubtype(kotlinTypePreparator: KotlinTypePreparator, customSubtype: (KotlinType, KotlinType) -> Boolean): OverridingUtil = OverridingUtil(DEFAULT_TYPE_CONSTRUCTOR_EQUALITY, KotlinTypeRefiner.Default, kotlinTypePreparator, customSubtype)
        @kotlin.jvm.JvmStatic
        fun create(kotlinTypeRefiner: KotlinTypeRefiner, equalityAxioms: KotlinTypeChecker.TypeConstructorEquality): OverridingUtil = OverridingUtil(equalityAxioms, kotlinTypeRefiner, KotlinTypePreparator.Default, null)
        // Exact callable adapter for the generated Kotlin interface, which is not a SAM interface.
        @kotlin.jvm.JvmStatic
        fun create(kotlinTypeRefiner: KotlinTypeRefiner, equalityAxioms: (TypeConstructor, TypeConstructor) -> Boolean): OverridingUtil = create(kotlinTypeRefiner, object : KotlinTypeChecker.TypeConstructorEquality {
            override fun equals(a: TypeConstructor, b: TypeConstructor): Boolean = equalityAxioms(a, b)
        })

        @kotlin.jvm.JvmStatic
        fun <D : CallableDescriptor> filterOutOverridden(candidateSet: Set<D>): Set<D> {
            val allowDescriptorCopies = candidateSet.isNotEmpty() && candidateSet.iterator().next().module.isTypeRefinementEnabled()
            return filterOverrides(candidateSet, allowDescriptorCopies, null) { a, b -> Pair(a, b) }
        }
        @kotlin.jvm.JvmStatic
        fun <D> filterOverrides(candidateSet: Set<D>, allowDescriptorCopies: Boolean, cancellationCallback: (() -> Any?)?, transformFirst: (D, D) -> Pair<CallableDescriptor, CallableDescriptor>): Set<D> {
            if (candidateSet.size <= 1) return candidateSet
            val result = LinkedHashSet<D>()
            outerLoop@ for (meD in candidateSet) {
                cancellationCallback?.invoke()
                val iterator = result.iterator()
                while (iterator.hasNext()) {
                    val otherD = iterator.next()
                    val meAndOther = transformFirst(meD, otherD)
                    val me = meAndOther.first
                    val other = meAndOther.second
                    if (overrides(me, other, allowDescriptorCopies, true)) iterator.remove()
                    else if (overrides(other, me, allowDescriptorCopies, true)) continue@outerLoop
                }
                result.add(meD)
            }
            compilerAssert(result.isNotEmpty()) { "All candidates filtered out from $candidateSet" }
            return result
        }
        @kotlin.jvm.JvmStatic
        fun <D : CallableDescriptor> overrides(f: D, g: D, allowDeclarationCopies: Boolean, distinguishExpectsAndNonExpects: Boolean): Boolean {
            if (f != g && DescriptorEquivalenceForOverrides.areEquivalent(f.getOriginal(), g.getOriginal(), allowDeclarationCopies, distinguishExpectsAndNonExpects)) return true
            val originalG = g.getOriginal()
            for (overriddenFunction in DescriptorUtils.getAllOverriddenDescriptors(f)) {
                if (DescriptorEquivalenceForOverrides.areEquivalent(originalG, overriddenFunction, allowDeclarationCopies, distinguishExpectsAndNonExpects)) return true
            }
            return false
        }
        @kotlin.jvm.JvmStatic
        fun getOverriddenDeclarations(descriptor: CallableMemberDescriptor): Set<CallableMemberDescriptor> = LinkedHashSet<CallableMemberDescriptor>().also { collectOverriddenDeclarations(descriptor, it) }
        private fun collectOverriddenDeclarations(descriptor: CallableMemberDescriptor, result: MutableSet<CallableMemberDescriptor>) {
            if (descriptor.getKind().isReal()) result.add(descriptor)
            else {
                if (descriptor.getOverriddenDescriptors().isEmpty()) throw IllegalStateException("No overridden descriptors found for (fake override) $descriptor")
                for (overridden in descriptor.getOverriddenDescriptors()) collectOverriddenDeclarations(overridden, result)
            }
        }
        @kotlin.jvm.JvmStatic
        fun getBasicOverridabilityProblem(superDescriptor: CallableDescriptor, subDescriptor: CallableDescriptor): OverrideCompatibilityInfo? {
            if (superDescriptor is FunctionDescriptor && subDescriptor !is FunctionDescriptor || superDescriptor is PropertyDescriptor && subDescriptor !is PropertyDescriptor) return OverrideCompatibilityInfo.incompatible("Member kind mismatch")
            if (superDescriptor !is FunctionDescriptor && superDescriptor !is PropertyDescriptor) throw IllegalArgumentException("This type of CallableDescriptor cannot be checked for overridability: $superDescriptor")
            if (superDescriptor.getName() != subDescriptor.getName()) return OverrideCompatibilityInfo.incompatible("Name mismatch")
            return checkReceiverAndParameterCount(superDescriptor, subDescriptor)
        }
        private fun checkReceiverAndParameterCount(superDescriptor: CallableDescriptor, subDescriptor: CallableDescriptor): OverrideCompatibilityInfo? {
            if ((superDescriptor.getExtensionReceiverParameter() == null) != (subDescriptor.getExtensionReceiverParameter() == null)) return OverrideCompatibilityInfo.incompatible("Receiver presence mismatch")
            if (superDescriptor.getValueParameters().size != subDescriptor.getValueParameters().size) return OverrideCompatibilityInfo.incompatible("Value parameter number mismatch")
            return null
        }
        private fun areTypesEquivalent(typeInSuper: KotlinType, typeInSub: KotlinType, typeCheckerState: TypeCheckerState): Boolean =
            typeInSuper.isError && typeInSub.isError || AbstractTypeChecker.equalTypes(typeCheckerState, typeInSuper.unwrap(), typeInSub.unwrap())
        private fun areTypeParametersEquivalent(superTypeParameter: TypeParameterDescriptor, subTypeParameter: TypeParameterDescriptor, typeCheckerState: TypeCheckerState): Boolean {
            val superBounds = superTypeParameter.getUpperBounds()
            val subBounds = ArrayList<KotlinType>(subTypeParameter.getUpperBounds())
            if (superBounds.size != subBounds.size) return false
            outer@ for (superBound in superBounds) {
                val iterator = subBounds.listIterator()
                while (iterator.hasNext()) {
                    if (areTypesEquivalent(superBound, iterator.next(), typeCheckerState)) { iterator.remove(); continue@outer }
                }
                return false
            }
            return true
        }
        private fun compiledValueParameters(callableDescriptor: CallableDescriptor): List<KotlinType> {
            val receiver = callableDescriptor.getExtensionReceiverParameter()
            val parameters = ArrayList<KotlinType>()
            if (receiver != null) parameters.add(receiver.getType())
            for (parameter in callableDescriptor.getValueParameters()) parameters.add(parameter.getType())
            return parameters
        }
        @ObsoleteDescriptorBasedAPI
        @kotlin.jvm.JvmStatic
        fun isVisibleForOverride(overriding: MemberDescriptor, fromSuper: MemberDescriptor, useSpecialRulesForPrivateSealedConstructors: Boolean): Boolean =
            !DescriptorVisibilities.isPrivate(fromSuper.getVisibility()) && DescriptorVisibilities.isVisibleIgnoringReceiver(fromSuper, overriding, useSpecialRulesForPrivateSealedConstructors)
        private fun allHasSameContainingDeclaration(notOverridden: Collection<CallableMemberDescriptor>): Boolean {
            if (notOverridden.size < 2) return true
            val containingDeclaration = notOverridden.iterator().next().getContainingDeclaration()
            return notOverridden.all { it.getContainingDeclaration() === containingDeclaration }
        }
        private fun createAndBindFakeOverrides(current: ClassDescriptor, notOverridden: Collection<CallableMemberDescriptor>, strategy: OverridingStrategy) {
            if (allHasSameContainingDeclaration(notOverridden)) {
                for (descriptor in notOverridden) createAndBindFakeOverride(setOf(descriptor), current, strategy)
                return
            }
            val fromSuperQueue = notOverridden.toMutableList()
            while (fromSuperQueue.isNotEmpty()) {
                val fromSuper = findMemberWithMaxVisibility(fromSuperQueue)
                val overridables = extractMembersOverridableInBothWays(fromSuper, fromSuperQueue, strategy)
                createAndBindFakeOverride(overridables, current, strategy)
            }
        }
        @kotlin.jvm.JvmStatic
        fun isMoreSpecific(a: CallableDescriptor, b: CallableDescriptor): Boolean {
            val aReturnType = a.getReturnType()
            val bReturnType = b.getReturnType()
            compilerAssert(aReturnType != null) { "Return type of $a is null" }
            compilerAssert(bReturnType != null) { "Return type of $b is null" }
            if (!isVisibilityMoreSpecific(a, b)) return false
            val state = DEFAULT.createTypeCheckerState(a.getTypeParameters(), b.getTypeParameters())
            if (a is FunctionDescriptor) {
                compilerAssert(b is FunctionDescriptor) { "b is " + EXTERNAL_SNAPSHOT.classDescription(b) }
                return isReturnTypeMoreSpecific(a, aReturnType!!, b, bReturnType!!, state)
            }
            if (a is PropertyDescriptor) {
                compilerAssert(b is PropertyDescriptor) { "b is " + EXTERNAL_SNAPSHOT.classDescription(b) }
                val pb = b as PropertyDescriptor
                if (!isAccessorMoreSpecific(a.setter, pb.setter)) return false
                return if (a.isVar() && pb.isVar()) AbstractTypeChecker.equalTypes(state, aReturnType!!.unwrap(), bReturnType!!.unwrap())
                else !(!a.isVar() && pb.isVar()) && isReturnTypeMoreSpecific(a, aReturnType!!, b, bReturnType!!, state)
            }
            throw IllegalArgumentException("Unexpected callable: " + EXTERNAL_SNAPSHOT.classDescription(a))
        }
        private fun isVisibilityMoreSpecific(a: DeclarationDescriptorWithVisibility, b: DeclarationDescriptorWithVisibility): Boolean {
            val result = DescriptorVisibilities.compare(a.getVisibility(), b.getVisibility())
            return result == null || result >= 0
        }
        private fun isAccessorMoreSpecific(a: PropertyAccessorDescriptor?, b: PropertyAccessorDescriptor?): Boolean = a == null || b == null || isVisibilityMoreSpecific(a, b)
        private fun isMoreSpecificThenAllOf(candidate: CallableDescriptor, descriptors: Collection<CallableDescriptor>): Boolean {
            for (descriptor in descriptors) if (!isMoreSpecific(candidate, descriptor)) return false
            return true
        }
        private fun isReturnTypeMoreSpecific(a: CallableDescriptor, aReturnType: KotlinType, b: CallableDescriptor, bReturnType: KotlinType, state: TypeCheckerState): Boolean = AbstractTypeChecker.isSubtypeOf(state, aReturnType.unwrap(), bReturnType.unwrap())
        @kotlin.jvm.JvmStatic
        fun <H> selectMostSpecificMember(overridables: Collection<H>, descriptorByHandle: (H) -> CallableDescriptor): H {
            compilerAssert(overridables.isNotEmpty()) { "Should have at least one overridable descriptor" }
            if (overridables.size == 1) return overridables.first()
            val candidates = ArrayList<H>(2)
            val descriptors = overridables.map(descriptorByHandle)
            var mostSpecific = overridables.first()
            val mostSpecificDescriptor = descriptorByHandle(mostSpecific)
            for (overridable in overridables) {
                val descriptor = descriptorByHandle(overridable)
                if (isMoreSpecificThenAllOf(descriptor, descriptors)) candidates.add(overridable)
                if (isMoreSpecific(descriptor, mostSpecificDescriptor) && !isMoreSpecific(mostSpecificDescriptor, descriptor)) mostSpecific = overridable
            }
            if (candidates.isEmpty()) return mostSpecific
            if (candidates.size == 1) return candidates.first()
            var firstNonFlexible: H? = null
            for (candidate in candidates) {
                if (!descriptorByHandle(candidate).getReturnType()!!.isFlexible()) { firstNonFlexible = candidate; break }
            }
            return firstNonFlexible ?: candidates.first()
        }
        private fun createAndBindFakeOverride(overridables: Collection<CallableMemberDescriptor>, current: ClassDescriptor, strategy: OverridingStrategy) {
            val visible = filterVisibleFakeOverrides(current, overridables)
            val allInvisible = visible.isEmpty()
            val effective = if (allInvisible) overridables else visible
            val modality = determineModalityForFakeOverride(effective, current)
            val visibility = if (allInvisible) DescriptorVisibilities.INVISIBLE_FAKE else DescriptorVisibilities.INHERITED
            val mostSpecific = selectMostSpecificMember(effective) { it }
            val fake = mostSpecific.copy(current, modality, visibility, CallableMemberDescriptor.Kind.FAKE_OVERRIDE, false)
            strategy.setOverriddenDescriptors(fake, effective)
            compilerAssert(fake.getOverriddenDescriptors().isNotEmpty()) { "Overridden descriptors should be set for " + CallableMemberDescriptor.Kind.FAKE_OVERRIDE }
            strategy.addFakeOverride(fake)
        }
        private fun determineModalityForFakeOverride(descriptors: Collection<CallableMemberDescriptor>, current: ClassDescriptor): Modality {
            var hasOpen = false
            var hasAbstract = false
            for (descriptor in descriptors) when (descriptor.getModality()) {
                Modality.FINAL -> return Modality.FINAL
                Modality.SEALED -> throw IllegalStateException("Member cannot have SEALED modality: $descriptor")
                Modality.OPEN -> hasOpen = true
                Modality.ABSTRACT -> hasAbstract = true
            }
            val transformAbstract = current.isExpect() && current.getModality() != Modality.ABSTRACT && current.getModality() != Modality.SEALED
            if (hasOpen && !hasAbstract) return Modality.OPEN
            if (!hasOpen && hasAbstract) return if (transformAbstract) current.getModality() else Modality.ABSTRACT
            val all = HashSet<CallableMemberDescriptor>()
            for (descriptor in descriptors) all.addAll(getOverriddenDeclarations(descriptor))
            return getMinimalModality(filterOutOverridden(all), transformAbstract, current.getModality())
        }
        private fun getMinimalModality(descriptors: Collection<CallableMemberDescriptor>, transformAbstract: Boolean, classModality: Modality): Modality {
            var result = Modality.ABSTRACT
            for (descriptor in descriptors) {
                val effective = if (transformAbstract && descriptor.getModality() == Modality.ABSTRACT) classModality else descriptor.getModality()
                if (effective < result) result = effective
            }
            return result
        }
        @ObsoleteDescriptorBasedAPI
        @kotlin.jvm.JvmStatic
        fun filterVisibleFakeOverrides(current: ClassDescriptor, toFilter: Collection<CallableMemberDescriptor>): Collection<CallableMemberDescriptor> = toFilter.filter {
            !DescriptorVisibilities.isPrivate(it.getVisibility()) && DescriptorVisibilities.isVisibleIgnoringReceiver(it, current, false)
        }
        @kotlin.jvm.JvmStatic
        fun <H> extractMembersOverridableInBothWays(overrider: H, extractFrom: MutableCollection<H>, descriptorByHandle: (H) -> CallableDescriptor, onConflict: (H) -> Unit): Collection<H> {
            val overridable = ArrayList<H>()
            overridable.add(overrider)
            val descriptor = descriptorByHandle(overrider)
            val iterator = extractFrom.iterator()
            while (iterator.hasNext()) {
                val candidate = iterator.next()
                val candidateDescriptor = descriptorByHandle(candidate)
                if (overrider === candidate) { iterator.remove(); continue }
                val result = getBothWaysOverridability(descriptor, candidateDescriptor)
                if (result == OVERRIDABLE) { overridable.add(candidate); iterator.remove() }
                else if (result == CONFLICT) { onConflict(candidate); iterator.remove() }
            }
            return overridable
        }
        @kotlin.jvm.JvmStatic
        fun getBothWaysOverridability(overriderDescriptor: CallableDescriptor, candidateDescriptor: CallableDescriptor): OverrideCompatibilityInfo.Result? {
            val result1 = DEFAULT.isOverridableBy(candidateDescriptor, overriderDescriptor, null).getResult()
            val result2 = DEFAULT.isOverridableBy(overriderDescriptor, candidateDescriptor, null).getResult()
            return if (result1 == OVERRIDABLE && result2 == OVERRIDABLE) OVERRIDABLE else if (result1 == CONFLICT || result2 == CONFLICT) CONFLICT else INCOMPATIBLE
        }
        private fun extractMembersOverridableInBothWays(overrider: CallableMemberDescriptor, extractFrom: MutableCollection<CallableMemberDescriptor>, strategy: OverridingStrategy): Collection<CallableMemberDescriptor> =
            extractMembersOverridableInBothWays(overrider, extractFrom, { it }) { descriptor -> strategy.inheritanceConflict(overrider, descriptor) }
        @kotlin.jvm.JvmStatic
        fun resolveUnknownVisibilityForMember(memberDescriptor: CallableMemberDescriptor, cannotInferVisibility: ((CallableMemberDescriptor) -> Unit)?) {
            for (descriptor in memberDescriptor.getOverriddenDescriptors()) {
                if (descriptor.getVisibility() === DescriptorVisibilities.INHERITED) resolveUnknownVisibilityForMember(descriptor, cannotInferVisibility)
            }
            if (memberDescriptor.getVisibility() !== DescriptorVisibilities.INHERITED) return
            val maxVisibility = computeVisibilityToInherit(memberDescriptor)
            val visibility = if (maxVisibility == null) { cannotInferVisibility?.invoke(memberDescriptor); DescriptorVisibilities.PUBLIC } else maxVisibility
            when (memberDescriptor) {
                is PropertyDescriptorImpl -> {
                    memberDescriptor.setVisibility(visibility)
                    for (accessor in memberDescriptor.getAccessors()) resolveUnknownVisibilityForMember(accessor, if (maxVisibility == null) null else cannotInferVisibility)
                }
                is FunctionDescriptorImpl -> memberDescriptor.setVisibility(visibility)
                else -> {
                    compilerAssert(memberDescriptor is PropertyAccessorDescriptorImpl)
                    val accessor = memberDescriptor as PropertyAccessorDescriptorImpl
                    accessor.setVisibility(visibility)
                    if (visibility !== accessor.getCorrespondingProperty().getVisibility()) accessor.setDefault(false)
                }
            }
        }
        private fun computeVisibilityToInherit(memberDescriptor: CallableMemberDescriptor): DescriptorVisibility? {
            val overridden = memberDescriptor.getOverriddenDescriptors()
            val maxVisibility = findMaxVisibility(overridden) ?: return null
            if (memberDescriptor.getKind() == CallableMemberDescriptor.Kind.FAKE_OVERRIDE) {
                for (descriptor in overridden) if (descriptor.getModality() != Modality.ABSTRACT && descriptor.getVisibility() != maxVisibility) return null
                return maxVisibility
            }
            return maxVisibility.normalize()
        }
        @kotlin.jvm.JvmStatic
        fun findMaxVisibility(descriptors: Collection<CallableMemberDescriptor>): DescriptorVisibility? {
            if (descriptors.isEmpty()) return DescriptorVisibilities.DEFAULT_VISIBILITY
            var maxVisibility: DescriptorVisibility? = null
            for (descriptor in descriptors) {
                val visibility = descriptor.getVisibility()
                compilerAssert(visibility !== DescriptorVisibilities.INHERITED) { "Visibility should have been computed for $descriptor" }
                if (maxVisibility == null) { maxVisibility = visibility; continue }
                val result = DescriptorVisibilities.compare(visibility, maxVisibility)
                if (result == null) maxVisibility = null else if (result > 0) maxVisibility = visibility
            }
            if (maxVisibility == null) return null
            for (descriptor in descriptors) {
                val result = DescriptorVisibilities.compare(maxVisibility, descriptor.getVisibility())
                if (result == null || result < 0) return null
            }
            return maxVisibility
        }
    }

    open class OverrideCompatibilityInfo(success: Result, private val debugMessage: String) {
        enum class Result { OVERRIDABLE, INCOMPATIBLE, CONFLICT }
        private val overridable = success
        open fun getResult(): Result = overridable
        open fun getDebugMessage(): String = debugMessage
        override fun toString(): String = "$overridable: $debugMessage"
        companion object {
            private val SUCCESS = OverrideCompatibilityInfo(Result.OVERRIDABLE, "SUCCESS")
            @kotlin.jvm.JvmStatic fun success(): OverrideCompatibilityInfo = SUCCESS
            @kotlin.jvm.JvmStatic fun incompatible(debugMessage: String): OverrideCompatibilityInfo = OverrideCompatibilityInfo(Result.INCOMPATIBLE, debugMessage)
            @kotlin.jvm.JvmStatic fun conflict(debugMessage: String): OverrideCompatibilityInfo = OverrideCompatibilityInfo(Result.CONFLICT, debugMessage)
        }
    }
}
