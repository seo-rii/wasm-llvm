/* Typed compatibility for the genuine Java boolean getter used by SpecialTypes.kt. */
package org.jetbrains.kotlin.portable.descriptors

val org.jetbrains.kotlin.descriptors.impl.TypeParameterDescriptorImpl.isInitialized: Boolean
    get() = isInitialized()
