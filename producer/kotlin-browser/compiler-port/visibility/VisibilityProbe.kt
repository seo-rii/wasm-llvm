package org.jetbrains.kotlin.portable.visibilitycheck

import org.jetbrains.kotlin.builtins.DefaultBuiltIns
import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.descriptors.impl.ClassDescriptorImpl
import org.jetbrains.kotlin.descriptors.impl.EmptyPackageFragmentDescriptor
import org.jetbrains.kotlin.descriptors.impl.ModuleDescriptorImpl
import org.jetbrains.kotlin.descriptors.impl.SimpleFunctionDescriptorImpl
import org.jetbrains.kotlin.name.FqName
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.resolve.scopes.MemberScope
import org.jetbrains.kotlin.resolve.scopes.receivers.ImplicitClassReceiver
import org.jetbrains.kotlin.storage.LockBasedStorageManager

fun observeVisibilities(): String {
    val observations = mutableListOf<String>()
    fun failure(operation: () -> Any?): String = try { operation().toString() }
    catch (error: IllegalStateException) { "IllegalStateException:" + error.message }
    catch (error: IllegalArgumentException) { "IllegalArgumentException:" + error.message }
    catch (error: UnsupportedOperationException) { "UnsupportedOperationException" }
    val visibilities = listOf(DescriptorVisibilities.PRIVATE, DescriptorVisibilities.PRIVATE_TO_THIS,
        DescriptorVisibilities.PROTECTED, DescriptorVisibilities.INTERNAL, DescriptorVisibilities.PUBLIC,
        DescriptorVisibilities.LOCAL, DescriptorVisibilities.INHERITED, DescriptorVisibilities.INVISIBLE_FAKE,
        DescriptorVisibilities.UNKNOWN)
    for (visibility in visibilities) {
        observations += "metadata:${visibility.name}:${visibility.isPublicAPI}:" + failure { visibility.mustCheckInImports() } + ":" +
            visibility.internalDisplayName + ":" + visibility.externalDisplayName + ":" +
            (DescriptorVisibilities.toDescriptorVisibility(visibility.delegate) === visibility) + ":" +
            DescriptorVisibilities.isPrivate(visibility) + ":" + visibility.normalize().name
        for (other in visibilities) {
            observations += "compare:${visibility.name}:${other.name}:" + DescriptorVisibilities.compare(visibility, other)
        }
    }
    observations += "default:" + (DescriptorVisibilities.DEFAULT_VISIBILITY === DescriptorVisibilities.PUBLIC)
    observations += "invisible-order:" + DescriptorVisibilities.INVISIBLE_FROM_OTHER_MODULES.joinToString(",") { it.name }
    observations += "immutable-add:" + failure {
        (DescriptorVisibilities.INVISIBLE_FROM_OTHER_MODULES as MutableSet).add(DescriptorVisibilities.PUBLIC)
    }
    observations += "immutable-remove:" + failure {
        (DescriptorVisibilities.INVISIBLE_FROM_OTHER_MODULES as MutableSet).remove(DescriptorVisibilities.PRIVATE)
    }
    observations += "immutable-iterator:" + failure {
        val iterator = DescriptorVisibilities.INVISIBLE_FROM_OTHER_MODULES.iterator() as MutableIterator
        iterator.next(); iterator.remove()
    }
    val unknown = object : Visibility("fixture-custom", false) {
        override fun mustCheckInImports(): Boolean = false
    }
    observations += "unknown-mapping:" + failure { DescriptorVisibilities.toDescriptorVisibility(unknown) }
    val builtins = DefaultBuiltIns.Instance
    val storage = LockBasedStorageManager.NO_LOCKS
    fun module(name: String) = ModuleDescriptorImpl(Name.special("<$name>"), storage, builtins).also { it.setDependencies(it) }
    val first = module("first")
    val second = module("second")
    val friend = ModuleDescriptorImpl(Name.special("<friend>"), storage, builtins).also {
        it.setDependencies(listOf(it, first), setOf(first))
    }
    val packageA = EmptyPackageFragmentDescriptor(first, FqName("fixture"))
    val packageB = EmptyPackageFragmentDescriptor(second, FqName("fixture"))
    val packageFriend = EmptyPackageFragmentDescriptor(friend, FqName("fixture"))
    fun source(name: String): SourceElement {
        val file = object : SourceFile { override fun getName(): String = name }
        return object : SourceElement { override fun getContainingFile(): SourceFile = file }
    }
    val sourceA = source("a.kt")
    val sourceB = source("b.kt")
    fun function(owner: DeclarationDescriptor, name: String, visibility: DescriptorVisibility,
        source: SourceElement = SourceElement.NO_SOURCE): SimpleFunctionDescriptorImpl =
        SimpleFunctionDescriptorImpl.create(owner, Annotations.EMPTY, Name.identifier(name), CallableMemberDescriptor.Kind.DECLARATION, source)
            .initialize(null, null, emptyList(), emptyList(), emptyList(), builtins.unitType, Modality.FINAL, visibility)
    fun clazz(owner: DeclarationDescriptor, name: String, supertype: org.jetbrains.kotlin.types.KotlinType = builtins.anyType): ClassDescriptorImpl =
        ClassDescriptorImpl(owner, Name.identifier(name), Modality.OPEN, ClassKind.CLASS, listOf(supertype), SourceElement.NO_SOURCE,
            false, storage).also { it.initialize(MemberScope.Empty, emptySet(), null) }
    val fromA = function(packageA, "fromA", DescriptorVisibilities.PUBLIC, sourceA)
    val fromSameFile = function(packageA, "fromSameFile", DescriptorVisibilities.PUBLIC, sourceA)
    val fromB = function(packageA, "fromB", DescriptorVisibilities.PUBLIC, sourceB)
    val otherModule = function(packageB, "otherModule", DescriptorVisibilities.PUBLIC, sourceA)
    val friendFrom = function(packageFriend, "friendFrom", DescriptorVisibilities.PUBLIC, sourceA)
    for (visibility in visibilities) {
        val target = function(packageA, "target", visibility, sourceA)
        observations += "top-level:${visibility.name}:" + failure {
            DescriptorVisibilities.isVisibleIgnoringReceiver(target, fromSameFile, false)
        } + ":" + failure { DescriptorVisibilities.isVisibleIgnoringReceiver(target, fromB, false) } + ":" +
            failure { DescriptorVisibilities.isVisibleIgnoringReceiver(target, otherModule, false) }
    }
    val internal = function(packageA, "internal", DescriptorVisibilities.INTERNAL)
    observations += "internal-friend:" + DescriptorVisibilities.isVisibleIgnoringReceiver(internal, friendFrom, false)
    observations += "same-file:" + DescriptorVisibilities.inSameFile(fromA, fromSameFile) + ":" +
        DescriptorVisibilities.inSameFile(fromA, fromB) + ":" + DescriptorVisibilities.inSameFile(fromA, otherModule)
    observations += "no-file:" + DescriptorVisibilities.inSameFile(internal, internal)
    val base = clazz(packageA, "Base")
    val derived = clazz(packageA, "Derived", base.defaultType)
    val unrelated = clazz(packageA, "Unrelated")
    val own = function(base, "own", DescriptorVisibilities.PUBLIC)
    val privateMember = function(base, "private", DescriptorVisibilities.PRIVATE)
    val privateThis = function(base, "privateThis", DescriptorVisibilities.PRIVATE_TO_THIS)
    val protectedMember = function(base, "protected", DescriptorVisibilities.PROTECTED)
    val derivedFrom = function(derived, "derivedFrom", DescriptorVisibilities.PUBLIC)
    val unrelatedFrom = function(unrelated, "unrelatedFrom", DescriptorVisibilities.PUBLIC)
    observations += "private-member:" + DescriptorVisibilities.isVisibleIgnoringReceiver(privateMember, own, false) + ":" +
        DescriptorVisibilities.isVisibleIgnoringReceiver(privateMember, derivedFrom, false)
    observations += "private-this:" + DescriptorVisibilities.isVisible(ImplicitClassReceiver(base), privateThis, own, false) + ":" +
        DescriptorVisibilities.isVisible(ImplicitClassReceiver(derived), privateThis, own, false) + ":" +
        DescriptorVisibilities.isVisibleWithAnyReceiver(privateThis, own, false)
    observations += "protected-member:" + DescriptorVisibilities.isVisible(ImplicitClassReceiver(derived), protectedMember, derivedFrom, false) + ":" +
        DescriptorVisibilities.isVisible(ImplicitClassReceiver(base), protectedMember, derivedFrom, false) + ":" +
        DescriptorVisibilities.isVisibleIgnoringReceiver(protectedMember, unrelatedFrom, false)
    observations += "protected-null:" + DescriptorVisibilities.isVisible(null, protectedMember, derivedFrom, false)
    for (receiver in listOf(DescriptorVisibilities.ALWAYS_SUITABLE_RECEIVER, DescriptorVisibilities.FALSE_IF_PROTECTED)) {
        observations += "sentinel-original:" + (receiver.getOriginal() === receiver)
        observations += "sentinel-type:" + failure { receiver.getType() }
        observations += "sentinel-replace:" + failure { receiver.replaceType(builtins.intType) }
    }
    return observations.joinToString("\n")
}
