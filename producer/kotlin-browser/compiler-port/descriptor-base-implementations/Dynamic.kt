/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package descriptorbaseproof

import org.jetbrains.kotlin.descriptors.CallableDescriptor
import org.jetbrains.kotlin.descriptors.SourceElement
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.descriptors.impl.ValueParameterDescriptorImpl
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.types.KotlinType

/** Observer subclass of the complete genuine value-parameter implementation. */
class Dynamic(owner: CallableDescriptor, type: KotlinType, name: Name) :
    ValueParameterDescriptorImpl(owner, null, 0, Annotations.EMPTY, name, type, false, false, false, null, SourceElement.NO_SOURCE) {
    @JvmField var current: KotlinType = type
    @JvmField var typeCalls = 0
    @JvmField var names = 0
    @JvmField var failFirstName = false
    @JvmField var failAllNames = false
    override fun getType(): KotlinType { typeCalls++; return current }
    override fun getName(): Name {
        names++
        if (failAllNames || failFirstName && names == 1) throw IllegalStateException("name Ω\n\u0000")
        return super.getName()
    }
    override fun hashCode(): Int = throw AssertionError("descriptor.hashCode invoked")
    override fun equals(other: Any?): Boolean = throw AssertionError("descriptor.equals invoked")
    fun stored(): KotlinType? = outType
}
