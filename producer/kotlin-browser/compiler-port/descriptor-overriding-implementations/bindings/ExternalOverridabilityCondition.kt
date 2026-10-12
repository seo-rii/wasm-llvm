// Generated from the selected original Java AST; do not edit.

package org.jetbrains.kotlin.resolve



interface ExternalOverridabilityCondition {
    enum class Result {
        OVERRIDABLE,
        INCOMPATIBLE,
        UNKNOWN;
    }
    enum class Contract {
        CONFLICTS_ONLY,
        SUCCESS_ONLY,
        BOTH;
    }
    fun isOverridable(superDescriptor: org.jetbrains.kotlin.descriptors.CallableDescriptor, subDescriptor: org.jetbrains.kotlin.descriptors.CallableDescriptor, subClassDescriptor: org.jetbrains.kotlin.descriptors.ClassDescriptor?): org.jetbrains.kotlin.resolve.ExternalOverridabilityCondition.Result
    fun getContract(): org.jetbrains.kotlin.resolve.ExternalOverridabilityCondition.Contract
}
