package org.jetbrains.kotlin.portable.descriptorutils.probe

import org.jetbrains.kotlin.builtins.BuiltInsPackageFragment
import org.jetbrains.kotlin.builtins.DefaultBuiltIns
import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.resolve.DescriptorType
import org.jetbrains.kotlin.resolve.DescriptorUtils

fun main() {
    val builtIns = DefaultBuiltIns()
    val objects = listOf(builtIns.builtInsModule, builtIns.any, builtIns.mapEntry, builtIns.mapEntry.declaredTypeParameters.first(),
        builtIns.string, *DescriptorUtils.getAllDescriptors(builtIns.string.defaultType.memberScope).toTypedArray())
    var checks = 0
    for (descriptor in objects) for (strict in listOf(false, true)) {
        check(DescriptorUtils.getParentOfType(descriptor, DescriptorType.CLASS, strict) ===
            DescriptorUtils.getParentOfType(descriptor, ClassDescriptor::class.java, strict)); checks++
        check(DescriptorUtils.getParentOfType(descriptor, DescriptorType.WITH_VISIBILITY, strict) ===
            DescriptorUtils.getParentOfType(descriptor, DeclarationDescriptorWithVisibility::class.java, strict)); checks++
        check(DescriptorUtils.getParentOfType(descriptor, DescriptorType.PACKAGE_FRAGMENT, strict) ===
            DescriptorUtils.getParentOfType(descriptor, PackageFragmentDescriptor::class.java, strict)); checks++
        check(DescriptorUtils.getParentOfType(descriptor, DescriptorType.BUILTINS_FRAGMENT, strict) ===
            DescriptorUtils.getParentOfType(descriptor, BuiltInsPackageFragment::class.java, strict)); checks++
    }
    check(DescriptorUtils.getParentOfType(null, DescriptorType.CLASS) == null); checks++
    check(DescriptorUtils.getParentOfType(builtIns.string, DescriptorType.CLASS) ===
        DescriptorUtils.getParentOfType(builtIns.string, ClassDescriptor::class.java)); checks++
    println("typed parent identity checks: $checks")
}
