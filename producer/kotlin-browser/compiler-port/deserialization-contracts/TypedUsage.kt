/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package contractsproof

import org.jetbrains.kotlin.descriptors.ClassDescriptor
import org.jetbrains.kotlin.serialization.deserialization.ErrorReporter

fun reportNullableElements(reporter: ErrorReporter, descriptor: ClassDescriptor, names: List<String?>) {
    reporter.reportIncompleteHierarchy(descriptor, names)
}
