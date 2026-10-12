/* Copyright 2010-2015 JetBrains s.r.o. Apache-2.0. */
package org.jetbrains.kotlin.descriptors.impl

import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.resolve.constants.ConstantValue
import org.jetbrains.kotlin.storage.NullableLazyValue
import org.jetbrains.kotlin.types.KotlinType
import org.jetbrains.kotlin.portable.assertions.compilerAssert

abstract class VariableDescriptorWithInitializerImpl(
    containingDeclaration: DeclarationDescriptor, annotations: Annotations, name: Name,
    outType: KotlinType?, private val isVar: Boolean, source: SourceElement,
) : VariableDescriptorImpl(containingDeclaration, annotations, name, outType, source) {
    @kotlin.jvm.JvmField
    protected var compileTimeInitializer: NullableLazyValue<ConstantValue<*>>? = null
    @kotlin.jvm.JvmField
    protected var compileTimeInitializerFactory: (() -> NullableLazyValue<ConstantValue<*>>)? = null
    override fun isVar(): Boolean = isVar
    override fun getCompileTimeInitializer(): ConstantValue<*>? = compileTimeInitializer?.invoke()
    open fun setCompileTimeInitializerFactory(factory: () -> NullableLazyValue<ConstantValue<*>>) {
        compilerAssert(!isVar()) { "Constant value for variable initializer should be recorded only for final variables: ${getName()}" }
        setCompileTimeInitializer(null, factory)
    }
    open fun setCompileTimeInitializer(initializer: NullableLazyValue<ConstantValue<*>>?, factory: () -> NullableLazyValue<ConstantValue<*>>) {
        compilerAssert(!isVar()) { "Constant value for variable initializer should be recorded only for final variables: ${getName()}" }
        compileTimeInitializerFactory = factory
        compileTimeInitializer = initializer ?: factory()
    }
    override fun cleanCompileTimeInitializerCache() { compileTimeInitializer = compileTimeInitializerFactory!!() }
}
