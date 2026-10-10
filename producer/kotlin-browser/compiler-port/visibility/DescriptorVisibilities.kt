/* Copyright 2010-2017 JetBrains s.r.o. Apache-2.0; pinned original algorithms. */
package org.jetbrains.kotlin.descriptors

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic
import org.jetbrains.kotlin.descriptors.impl.TypeAliasConstructorDescriptor
import org.jetbrains.kotlin.portable.config.unmodifiableConfigurationValue
import org.jetbrains.kotlin.resolve.DescriptorUtils
import org.jetbrains.kotlin.resolve.scopes.receivers.ReceiverValue
import org.jetbrains.kotlin.resolve.scopes.receivers.SuperCallReceiverValue
import org.jetbrains.kotlin.resolve.scopes.receivers.ThisClassReceiver
import org.jetbrains.kotlin.types.KotlinType
import org.jetbrains.kotlin.types.isDynamic
import org.jetbrains.kotlin.util.ModuleVisibilityHelper

/** Actual Java visibility algorithms, with explicit browser-profile services. */
class DescriptorVisibilities private constructor() {
    companion object {
        // The original reflective parent traversal only needs instanceof. This
        // typed common form keeps its strict/non-strict traversal order.
        private inline fun <reified D : DeclarationDescriptor> parentOf(
            descriptor: DeclarationDescriptor?, strict: Boolean = true,
        ): D? {
            var current = descriptor ?: return null
            if (strict) current = current.getContainingDeclaration() ?: return null
            while (true) {
                if (current is D) return current
                current = current.getContainingDeclaration() ?: return null
            }
        }

        @JvmField
        val PRIVATE: DescriptorVisibility = object : DelegatedDescriptorVisibility(Visibilities.Private) {
            private fun hasContainingSourceFile(descriptor: DeclarationDescriptor): Boolean =
                DescriptorUtils.getContainingSourceFile(descriptor) !== SourceFile.NO_SOURCE_FILE

            override fun isVisible(receiver: ReceiverValue?, what: DeclarationDescriptorWithVisibility,
                from: DeclarationDescriptor, useSpecialRulesForPrivateSealedConstructors: Boolean): Boolean {
                if (DescriptorUtils.isTopLevelDeclaration(what) && hasContainingSourceFile(from)) return inSameFile(what, from)
                if (what is ConstructorDescriptor) {
                    val classDescriptor = what.getContainingDeclaration()
                    if (useSpecialRulesForPrivateSealedConstructors && DescriptorUtils.isSealedClass(classDescriptor) &&
                        DescriptorUtils.isTopLevelDeclaration(classDescriptor) && from is ConstructorDescriptor &&
                        DescriptorUtils.isTopLevelDeclaration(from.getContainingDeclaration()) && inSameFile(what, from)) return true
                }
                var parent: DeclarationDescriptor? = what
                while (parent != null) {
                    parent = parent.getContainingDeclaration()
                    if ((parent is ClassDescriptor && !DescriptorUtils.isCompanionObject(parent)) || parent is PackageFragmentDescriptor) break
                }
                if (parent == null) return false
                var fromParent: DeclarationDescriptor? = from
                while (fromParent != null) {
                    if (parent === fromParent) return true
                    if (fromParent is PackageFragmentDescriptor) {
                        return parent is PackageFragmentDescriptor && parent.fqName == fromParent.fqName &&
                            DescriptorUtils.areInSameModule(fromParent, parent)
                    }
                    fromParent = fromParent.getContainingDeclaration()
                }
                return false
            }
        }

        @JvmField
        val PRIVATE_TO_THIS: DescriptorVisibility = object : DelegatedDescriptorVisibility(Visibilities.PrivateToThis) {
            override fun isVisible(receiver: ReceiverValue?, what: DeclarationDescriptorWithVisibility,
                from: DeclarationDescriptor, useSpecialRulesForPrivateSealedConstructors: Boolean): Boolean {
                if (PRIVATE.isVisible(receiver, what, from, useSpecialRulesForPrivateSealedConstructors)) {
                    if (receiver === ALWAYS_SUITABLE_RECEIVER) return true
                    if (receiver === IRRELEVANT_RECEIVER) return false
                    val classDescriptor = parentOf<ClassDescriptor>(what)
                    if (classDescriptor != null && receiver is ThisClassReceiver) {
                        return receiver.classDescriptor.getOriginal() == classDescriptor.getOriginal()
                    }
                }
                return false
            }
        }

        @JvmField
        val PROTECTED: DescriptorVisibility = object : DelegatedDescriptorVisibility(Visibilities.Protected) {
            override fun isVisible(receiver: ReceiverValue?, what: DeclarationDescriptorWithVisibility,
                from: DeclarationDescriptor, useSpecialRulesForPrivateSealedConstructors: Boolean): Boolean {
                val givenDescriptorContainingClass = parentOf<ClassDescriptor>(what)
                val fromClass = parentOf<ClassDescriptor>(from, false) ?: return false
                if (givenDescriptorContainingClass != null && DescriptorUtils.isCompanionObject(givenDescriptorContainingClass)) {
                    val companionOwner = parentOf<ClassDescriptor>(givenDescriptorContainingClass)
                    if (companionOwner != null && DescriptorUtils.isSubclass(fromClass, companionOwner)) return true
                }
                val whatDeclaration = DescriptorUtils.unwrapFakeOverrideToAnyDeclaration(what)
                val classDescriptor = parentOf<ClassDescriptor>(whatDeclaration) ?: return false
                if (DescriptorUtils.isSubclass(fromClass, classDescriptor) &&
                    doesReceiverFitForProtectedVisibility(receiver, whatDeclaration, fromClass)) return true
                return isVisible(receiver, what, fromClass.getContainingDeclaration(), useSpecialRulesForPrivateSealedConstructors)
            }

            private fun doesReceiverFitForProtectedVisibility(receiver: ReceiverValue?,
                whatDeclaration: DeclarationDescriptorWithVisibility, fromClass: ClassDescriptor): Boolean {
                if (receiver === FALSE_IF_PROTECTED) return false
                if (whatDeclaration !is CallableMemberDescriptor) return true
                if (whatDeclaration is ConstructorDescriptor) return true
                if (receiver === ALWAYS_SUITABLE_RECEIVER) return true
                if (receiver === IRRELEVANT_RECEIVER || receiver == null) return false
                val actualReceiverType = if (receiver is SuperCallReceiverValue) receiver.thisType else receiver.getType()
                return DescriptorUtils.isSubtypeOfClass(actualReceiverType, fromClass) || actualReceiverType.isDynamic()
            }
        }

        @JvmField
        val INTERNAL: DescriptorVisibility = object : DelegatedDescriptorVisibility(Visibilities.Internal) {
            override fun isVisible(receiver: ReceiverValue?, what: DeclarationDescriptorWithVisibility,
                from: DeclarationDescriptor, useSpecialRulesForPrivateSealedConstructors: Boolean): Boolean {
                val whatModule = DescriptorUtils.getContainingModule(what)
                val fromModule = DescriptorUtils.getContainingModule(from)
                if (!fromModule.shouldSeeInternalsOf(whatModule)) return false
                return MODULE_VISIBILITY_HELPER.isInFriendModule(what, from)
            }
        }

        @JvmField
        val PUBLIC: DescriptorVisibility = object : DelegatedDescriptorVisibility(Visibilities.Public) {
            override fun isVisible(receiver: ReceiverValue?, what: DeclarationDescriptorWithVisibility,
                from: DeclarationDescriptor, useSpecialRulesForPrivateSealedConstructors: Boolean) = true
        }

        @JvmField
        val LOCAL: DescriptorVisibility = object : DelegatedDescriptorVisibility(Visibilities.Local) {
            override fun isVisible(receiver: ReceiverValue?, what: DeclarationDescriptorWithVisibility,
                from: DeclarationDescriptor, useSpecialRulesForPrivateSealedConstructors: Boolean): Boolean =
                throw IllegalStateException("This method shouldn't be invoked for LOCAL visibility")
        }

        @JvmField
        val INHERITED: DescriptorVisibility = object : DelegatedDescriptorVisibility(Visibilities.Inherited) {
            override fun isVisible(receiver: ReceiverValue?, what: DeclarationDescriptorWithVisibility,
                from: DeclarationDescriptor, useSpecialRulesForPrivateSealedConstructors: Boolean): Boolean =
                throw IllegalStateException("Visibility is unknown yet")
        }

        @JvmField
        val INVISIBLE_FAKE: DescriptorVisibility = object : DelegatedDescriptorVisibility(Visibilities.InvisibleFake) {
            override fun isVisible(receiver: ReceiverValue?, what: DeclarationDescriptorWithVisibility,
                from: DeclarationDescriptor, useSpecialRulesForPrivateSealedConstructors: Boolean) = false
        }

        @JvmField
        val UNKNOWN: DescriptorVisibility = object : DelegatedDescriptorVisibility(Visibilities.Unknown) {
            override fun isVisible(receiver: ReceiverValue?, what: DeclarationDescriptorWithVisibility,
                from: DeclarationDescriptor, useSpecialRulesForPrivateSealedConstructors: Boolean) = false
        }

        @JvmField
        val INVISIBLE_FROM_OTHER_MODULES: Set<DescriptorVisibility> =
            linkedSetOf(PRIVATE, PRIVATE_TO_THIS, INTERNAL, LOCAL).unmodifiableConfigurationValue()

        @JvmStatic
        @org.jetbrains.kotlin.ir.ObsoleteDescriptorBasedAPI
        fun isVisible(receiver: ReceiverValue?, what: DeclarationDescriptorWithVisibility,
            from: DeclarationDescriptor, useSpecialRulesForPrivateSealedConstructors: Boolean): Boolean =
            findInvisibleMember(receiver, what, from, useSpecialRulesForPrivateSealedConstructors) == null

        @JvmStatic
        @org.jetbrains.kotlin.ir.ObsoleteDescriptorBasedAPI
        fun isVisibleIgnoringReceiver(what: DeclarationDescriptorWithVisibility,
            from: DeclarationDescriptor, useSpecialRulesForPrivateSealedConstructors: Boolean): Boolean =
            findInvisibleMember(ALWAYS_SUITABLE_RECEIVER, what, from, useSpecialRulesForPrivateSealedConstructors) == null

        @JvmStatic
        @org.jetbrains.kotlin.ir.ObsoleteDescriptorBasedAPI
        fun isVisibleWithAnyReceiver(what: DeclarationDescriptorWithVisibility,
            from: DeclarationDescriptor, useSpecialRulesForPrivateSealedConstructors: Boolean): Boolean =
            findInvisibleMember(IRRELEVANT_RECEIVER, what, from, useSpecialRulesForPrivateSealedConstructors) == null

        @JvmStatic
        fun inSameFile(what: DeclarationDescriptor, from: DeclarationDescriptor): Boolean {
            val fromContainingFile = DescriptorUtils.getContainingSourceFile(from)
            if (fromContainingFile !== SourceFile.NO_SOURCE_FILE) return fromContainingFile == DescriptorUtils.getContainingSourceFile(what)
            return false
        }

        @JvmStatic
        @org.jetbrains.kotlin.ir.ObsoleteDescriptorBasedAPI
        fun findInvisibleMember(receiver: ReceiverValue?, what: DeclarationDescriptorWithVisibility,
            from: DeclarationDescriptor, useSpecialRulesForPrivateSealedConstructors: Boolean): DeclarationDescriptorWithVisibility? {
            var parent: DeclarationDescriptorWithVisibility? = what.getOriginal() as DeclarationDescriptorWithVisibility
            while (parent != null && parent.getVisibility() !== LOCAL) {
                if (!parent.getVisibility().isVisible(receiver, parent, from, useSpecialRulesForPrivateSealedConstructors)) return parent
                parent = parentOf<DeclarationDescriptorWithVisibility>(parent)
            }
            if (what is TypeAliasConstructorDescriptor) {
                val invisibleUnderlying = findInvisibleMember(receiver, what.underlyingConstructorDescriptor, from,
                    useSpecialRulesForPrivateSealedConstructors)
                if (invisibleUnderlying != null) return invisibleUnderlying
            }
            return null
        }

        private val ORDERED_VISIBILITIES: Map<DescriptorVisibility, Int> = hashMapOf(
            PRIVATE_TO_THIS to 0, PRIVATE to 0, INTERNAL to 1, PROTECTED to 1, PUBLIC to 2,
        ).unmodifiableConfigurationValue()

        @JvmStatic
        fun compareLocal(first: DescriptorVisibility, second: DescriptorVisibility): Int? {
            if (first === second) return 0
            val firstIndex = ORDERED_VISIBILITIES[first]
            val secondIndex = ORDERED_VISIBILITIES[second]
            if (firstIndex == null || secondIndex == null || firstIndex == secondIndex) return null
            return firstIndex - secondIndex
        }

        @JvmStatic
        fun compare(first: DescriptorVisibility, second: DescriptorVisibility): Int? {
            val result = first.compareTo(second)
            if (result != null) return result
            val oppositeResult = second.compareTo(first)
            if (oppositeResult != null) return -oppositeResult
            return null
        }

        @JvmField val DEFAULT_VISIBILITY = PUBLIC

        private val IRRELEVANT_RECEIVER: ReceiverValue = object : ReceiverValue {
            override fun getType(): KotlinType = throw IllegalStateException("This method should not be called")
            override fun replaceType(newType: KotlinType): ReceiverValue = throw IllegalStateException("This method should not be called")
            override fun getOriginal(): ReceiverValue = this
        }

        @JvmField
        val ALWAYS_SUITABLE_RECEIVER: ReceiverValue = object : ReceiverValue {
            override fun getType(): KotlinType = throw IllegalStateException("This method should not be called")
            override fun replaceType(newType: KotlinType): ReceiverValue = throw IllegalStateException("This method should not be called")
            override fun getOriginal(): ReceiverValue = this
        }

        @JvmField
        @Deprecated("Only intended for protected visibility checks")
        val FALSE_IF_PROTECTED: ReceiverValue = object : ReceiverValue {
            override fun getType(): KotlinType = throw IllegalStateException("This method should not be called")
            override fun replaceType(newType: KotlinType): ReceiverValue = throw IllegalStateException("This method should not be called")
            override fun getOriginal(): ReceiverValue = this
        }

        @JvmStatic
        fun isPrivate(visibility: DescriptorVisibility): Boolean = visibility === PRIVATE || visibility === PRIVATE_TO_THIS

        // The no-plugin browser profile explicitly chooses the original default
        // factory. The module's actual shouldSeeInternalsOf check remains above.
        private val MODULE_VISIBILITY_HELPER: ModuleVisibilityHelper = ModuleVisibilityHelper.EMPTY
        private val visibilitiesMapping = hashMapOf<Visibility, DescriptorVisibility>()

        private fun recordVisibilityMapping(visibility: DescriptorVisibility) { visibilitiesMapping[visibility.delegate] = visibility }

        init {
            recordVisibilityMapping(PRIVATE)
            recordVisibilityMapping(PRIVATE_TO_THIS)
            recordVisibilityMapping(PROTECTED)
            recordVisibilityMapping(INTERNAL)
            recordVisibilityMapping(PUBLIC)
            recordVisibilityMapping(LOCAL)
            recordVisibilityMapping(INHERITED)
            recordVisibilityMapping(INVISIBLE_FAKE)
            recordVisibilityMapping(UNKNOWN)
        }

        @JvmStatic
        fun toDescriptorVisibility(visibility: Visibility): DescriptorVisibility =
            visibilitiesMapping[visibility] ?: throw IllegalArgumentException("Inapplicable visibility: $visibility")
    }
}
