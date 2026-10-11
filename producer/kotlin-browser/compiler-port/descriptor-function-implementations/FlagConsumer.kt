/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package descriptorfunctionproof

import org.jetbrains.kotlin.descriptors.impl.FunctionDescriptorImpl
import org.jetbrains.kotlin.portable.descriptors.*

// The actual assignment expressions from MemberDeserializer and
// FunctionInvokeDescriptor, applied to a genuine complete descriptor class.
fun assignFlags(function: FunctionDescriptorImpl): String {
    function.isOperator = true
    function.isInfix = true
    function.isExternal = true
    function.isInline = true
    function.isTailrec = true
    function.isSuspend = true
    function.isExpect = true
    return listOf(function.isOperator, function.isInfix, function.isExternal,
        function.isInline, function.isTailrec, function.isSuspend, function.isExpect).joinToString(",")
}
