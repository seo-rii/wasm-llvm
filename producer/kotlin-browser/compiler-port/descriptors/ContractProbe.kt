package org.jetbrains.kotlin.portable.descriptors.probe

import org.jetbrains.kotlin.descriptors.CallableMemberDescriptor
import org.jetbrains.kotlin.descriptors.Named
import org.jetbrains.kotlin.descriptors.ValidateableDescriptor
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.portable.descriptors.*

// This exercises genuine contract bodies and typed aliases; it is not a compiler entry.
fun main() {
    val originalName = Name.identifier("실제DescriptorName")
    val named = object : Named {
        override fun getName(): Name = originalName
    }
    check(named.name === named.getName())
    check(named.name.asString() == "실제DescriptorName")
    val validateable = object : ValidateableDescriptor {}
    validateable.validate()
    check(CallableMemberDescriptor.Kind.DECLARATION.isReal)
    check(CallableMemberDescriptor.Kind.DELEGATION.isReal)
    check(CallableMemberDescriptor.Kind.SYNTHESIZED.isReal)
    check(!CallableMemberDescriptor.Kind.FAKE_OVERRIDE.isReal)
    println("typed getter alias; original default validation; four original enum branches: pass")
}
