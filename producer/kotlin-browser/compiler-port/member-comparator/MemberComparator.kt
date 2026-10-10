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

package org.jetbrains.kotlin.resolve

import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.renderer.AnnotationArgumentsRenderingPolicy
import org.jetbrains.kotlin.renderer.DescriptorRenderer
import org.jetbrains.kotlin.renderer.DescriptorRendererModifier

/** The selected Java ordering algorithm with its original renderer options. */
class MemberComparator private constructor() : Comparator<DeclarationDescriptor> {
    companion object {
        val INSTANCE = MemberComparator()
        private val RENDERER = DescriptorRenderer.withOptions {
            withDefinedIn = false
            verbose = true
            annotationArgumentsRenderingPolicy = AnnotationArgumentsRenderingPolicy.UNLESS_EMPTY
            modifiers = DescriptorRendererModifier.ALL
        }
    }

    class NameAndTypeMemberComparator private constructor() : Comparator<DeclarationDescriptor> {
        companion object { val INSTANCE = NameAndTypeMemberComparator() }
        override fun compare(o1: DeclarationDescriptor, o2: DeclarationDescriptor): Int = compareNameAndType(o1, o2) ?: 0
    }

    override fun compare(o1: DeclarationDescriptor, o2: DeclarationDescriptor): Int {
        val typeAndNameCompareResult = compareNameAndType(o1, o2)
        if (typeAndNameCompareResult != null) return typeAndNameCompareResult
        if (o1 is TypeAliasDescriptor && o2 is TypeAliasDescriptor) {
            val r1 = RENDERER.renderType(o1.underlyingType)
            val r2 = RENDERER.renderType(o2.underlyingType)
            val underlyingTypesCompareTo = r1.compareTo(r2)
            if (underlyingTypesCompareTo != 0) return underlyingTypesCompareTo
        } else if (o1 is CallableDescriptor && o2 is CallableDescriptor) {
            val c1ReceiverParameter = o1.getExtensionReceiverParameter()
            val c2ReceiverParameter = o2.getExtensionReceiverParameter()
            if ((c1ReceiverParameter != null) != (c2ReceiverParameter != null)) throw AssertionError()
            if (c1ReceiverParameter != null) {
                val r1 = RENDERER.renderType(c1ReceiverParameter.getType())
                val r2 = RENDERER.renderType(c2ReceiverParameter!!.getType())
                val receiversCompareTo = r1.compareTo(r2)
                if (receiversCompareTo != 0) return receiversCompareTo
            }
            val c1ValueParameters = o1.getValueParameters()
            val c2ValueParameters = o2.getValueParameters()
            for (i in 0 until minOf(c1ValueParameters.size, c2ValueParameters.size)) {
                val p1 = RENDERER.renderType(c1ValueParameters[i].getType())
                val p2 = RENDERER.renderType(c2ValueParameters[i].getType())
                val parametersCompareTo = p1.compareTo(p2)
                if (parametersCompareTo != 0) return parametersCompareTo
            }
            val valueParametersNumberCompareTo = c1ValueParameters.size - c2ValueParameters.size
            if (valueParametersNumberCompareTo != 0) return valueParametersNumberCompareTo
            val c1TypeParameters = o1.getTypeParameters()
            val c2TypeParameters = o2.getTypeParameters()
            for (i in 0 until minOf(c1TypeParameters.size, c2TypeParameters.size)) {
                val c1Bounds = c1TypeParameters[i].getUpperBounds()
                val c2Bounds = c2TypeParameters[i].getUpperBounds()
                val boundsCountCompareTo = c1Bounds.size - c2Bounds.size
                if (boundsCountCompareTo != 0) return boundsCountCompareTo
                for (j in c1Bounds.indices) {
                    val b1 = RENDERER.renderType(c1Bounds[j])
                    val b2 = RENDERER.renderType(c2Bounds[j])
                    val boundCompareTo = b1.compareTo(b2)
                    if (boundCompareTo != 0) return boundCompareTo
                }
            }
            val typeParametersCompareTo = c1TypeParameters.size - c2TypeParameters.size
            if (typeParametersCompareTo != 0) return typeParametersCompareTo
            if (o1 is CallableMemberDescriptor && o2 is CallableMemberDescriptor) {
                val kindsCompareTo = o1.getKind().ordinal - o2.getKind().ordinal
                if (kindsCompareTo != 0) return kindsCompareTo
            }
        } else if (o1 is ClassDescriptor && o2 is ClassDescriptor) {
            if (o1.getKind().ordinal != o2.getKind().ordinal) return o1.getKind().ordinal - o2.getKind().ordinal
            if (o1.isCompanionObject() != o2.isCompanionObject()) return if (o1.isCompanionObject()) 1 else -1
        } else {
            throw AssertionError("Unsupported pair of descriptors:\n'" + o1 + "' Class: " + o1::class +
                "\n" + o2 + "' Class: " + o2::class)
        }
        val renderDiff = RENDERER.render(o1).compareTo(RENDERER.render(o2))
        if (renderDiff != 0) return renderDiff
        val firstModuleName = DescriptorUtils.getContainingModule(o1).getName()
        val secondModuleName = DescriptorUtils.getContainingModule(o2).getName()
        return firstModuleName.compareTo(secondModuleName)
    }
}

private fun declarationPriority(descriptor: DeclarationDescriptor): Int = when {
    DescriptorUtils.isEnumEntry(descriptor) -> 8
    descriptor is ConstructorDescriptor -> 7
    descriptor is PropertyDescriptor -> if (descriptor.getExtensionReceiverParameter() == null) 6 else 5
    descriptor is FunctionDescriptor -> if (descriptor.getExtensionReceiverParameter() == null) 4 else 3
    descriptor is ClassDescriptor -> 2
    descriptor is TypeAliasDescriptor -> 1
    else -> 0
}

private fun compareNameAndType(o1: DeclarationDescriptor, o2: DeclarationDescriptor): Int? {
    val prioritiesCompareTo = declarationPriority(o2) - declarationPriority(o1)
    if (prioritiesCompareTo != 0) return prioritiesCompareTo
    // Never reorder enum entries.
    if (DescriptorUtils.isEnumEntry(o1) && DescriptorUtils.isEnumEntry(o2)) return 0
    val namesCompareTo = o1.getName().compareTo(o2.getName())
    if (namesCompareTo != 0) return namesCompareTo
    return null
}
