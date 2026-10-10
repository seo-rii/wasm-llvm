/* Common typed keys for actual selected DescriptorUtils parent callers. */
package org.jetbrains.kotlin.resolve

import org.jetbrains.kotlin.builtins.BuiltInsPackageFragment
import org.jetbrains.kotlin.descriptors.ClassDescriptor
import org.jetbrains.kotlin.descriptors.DeclarationDescriptor
import org.jetbrains.kotlin.descriptors.DeclarationDescriptorWithVisibility
import org.jetbrains.kotlin.descriptors.PackageFragmentDescriptor
import kotlin.jvm.JvmField

class DescriptorType<D : DeclarationDescriptor> private constructor(private val cast: (DeclarationDescriptor) -> D?) {
    internal fun castOrNull(descriptor: DeclarationDescriptor): D? = cast(descriptor)

    companion object {
        @JvmField
        val CLASS: DescriptorType<ClassDescriptor> = DescriptorType { it as? ClassDescriptor }
        @JvmField
        val WITH_VISIBILITY: DescriptorType<DeclarationDescriptorWithVisibility> = DescriptorType { it as? DeclarationDescriptorWithVisibility }
        @JvmField
        val PACKAGE_FRAGMENT: DescriptorType<PackageFragmentDescriptor> = DescriptorType { it as? PackageFragmentDescriptor }
        @JvmField
        val BUILTINS_FRAGMENT: DescriptorType<BuiltInsPackageFragment> = DescriptorType { it as? BuiltInsPackageFragment }
    }
}
