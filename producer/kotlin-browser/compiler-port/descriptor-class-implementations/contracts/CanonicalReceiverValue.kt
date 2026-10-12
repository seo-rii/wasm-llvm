// Generated from the selected original Java AST; do not edit.

package org.jetbrains.kotlin.resolve.scopes.receivers



interface ReceiverValue : org.jetbrains.kotlin.resolve.scopes.receivers.Receiver {
    fun getType(): org.jetbrains.kotlin.types.KotlinType
    fun replaceType(newType: org.jetbrains.kotlin.types.KotlinType): org.jetbrains.kotlin.resolve.scopes.receivers.ReceiverValue
    fun getOriginal(): org.jetbrains.kotlin.resolve.scopes.receivers.ReceiverValue
}
