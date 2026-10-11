/*
 * Copyright 2010-2015 JetBrains s.r.o.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package org.jetbrains.kotlin.descriptors.impl

import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.annotations.AnnotatedImpl
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.renderer.DescriptorRenderer
import org.jetbrains.kotlin.types.KotlinType
import org.jetbrains.kotlin.types.typeUtil.shouldBeUpdated
import org.jetbrains.kotlin.portable.descriptorbases.DescriptorDebugHostContext

abstract class DeclarationDescriptorImpl(
    annotations: Annotations,
    private val storedName: Name,
) : AnnotatedImpl(annotations), DeclarationDescriptor {
    override fun getName(): Name = storedName
    override fun getOriginal(): DeclarationDescriptor = this
    override fun acceptVoid(visitor: DeclarationDescriptorVisitor<Nothing?, Nothing?>?) {
        accept(visitor, null)
    }
    override fun toString(): String = toString(this)

    companion object {
        fun toString(descriptor: DeclarationDescriptor): String {
            try {
                return DescriptorRenderer.DEBUG_TEXT.render(descriptor) +
                    "[" + DescriptorDebugHostContext.current().classSimpleName(descriptor) + "@" +
                    DescriptorDebugHostContext.current().identityHashCode(descriptor).toUInt().toString(16) + "]"
            } catch (e: Throwable) {
                // DescriptionRenderer may throw if this is not yet completely initialized
                // It is very inconvenient while debugging
                return DescriptorDebugHostContext.current().classSimpleName(descriptor) + " " + descriptor.getName()
            }
        }
    }
}

abstract class DeclarationDescriptorNonRootImpl protected constructor(
    private val containingDeclaration: DeclarationDescriptor,
    annotations: Annotations,
    name: Name,
    private val source: SourceElement,
) : DeclarationDescriptorImpl(annotations, name), DeclarationDescriptorNonRoot {
    override fun getOriginal(): DeclarationDescriptorWithSource = super.getOriginal() as DeclarationDescriptorWithSource
    override fun getContainingDeclaration(): DeclarationDescriptor = containingDeclaration
    override fun getSource(): SourceElement = source
    override fun validate() { containingDeclaration.validate() }
}

abstract class VariableDescriptorImpl(
    containingDeclaration: DeclarationDescriptor,
    annotations: Annotations,
    name: Name,
    outType: KotlinType?,
    source: SourceElement,
) : DeclarationDescriptorNonRootImpl(containingDeclaration, annotations, name, source), VariableDescriptor {
    @kotlin.jvm.JvmField
    protected var outType: KotlinType? = outType

    override fun getType(): KotlinType = outType!!
    open fun setOutType(outType: KotlinType?) {
        if (!(this.outType == null || this.outType.shouldBeUpdated())) throw AssertionError()
        this.outType = outType
    }
    override fun getOriginal(): VariableDescriptor = super.getOriginal() as VariableDescriptor
    override fun getValueParameters(): List<ValueParameterDescriptor> = emptyList()
    override fun hasStableParameterNames(): Boolean = false
    override fun hasSynthesizedParameterNames(): Boolean = false
    override fun getOverriddenDescriptors(): Collection<CallableDescriptor> = emptySet()
    override fun getTypeParameters(): List<TypeParameterDescriptor> = emptyList()
    override fun getContextReceiverParameters(): List<ReceiverParameterDescriptor> = emptyList()
    override fun getExtensionReceiverParameter(): ReceiverParameterDescriptor? = null
    override fun getDispatchReceiverParameter(): ReceiverParameterDescriptor? = null
    override fun getReturnType(): KotlinType = getType()
    override fun isConst(): Boolean = false
    override fun <V> getUserData(key: CallableDescriptor.UserDataKey<V>?): V? = null
}
