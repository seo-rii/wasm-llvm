/* Copyright 2000-2018 JetBrains s.r.o. and Kotlin contributors. Apache-2.0.
 * Source-body port of the selected official TypeUtils.java; see sources.lock.json. */
package org.jetbrains.kotlin.types

import kotlin.jvm.JvmField
import kotlin.jvm.JvmStatic
import org.jetbrains.kotlin.builtins.KotlinBuiltIns
import org.jetbrains.kotlin.builtins.StandardNames
import org.jetbrains.kotlin.descriptors.ClassDescriptor
import org.jetbrains.kotlin.descriptors.ClassifierDescriptor
import org.jetbrains.kotlin.descriptors.TypeParameterDescriptor
import org.jetbrains.kotlin.name.FqName
import org.jetbrains.kotlin.portable.assertions.compilerAssert as assert
import org.jetbrains.kotlin.portable.descriptors.*
import org.jetbrains.kotlin.resolve.DescriptorUtils
import org.jetbrains.kotlin.resolve.constants.IntegerLiteralTypeConstructor
import org.jetbrains.kotlin.resolve.constants.IntegerValueTypeConstructor
import org.jetbrains.kotlin.resolve.scopes.MemberScope
import org.jetbrains.kotlin.types.checker.KotlinTypeChecker
import org.jetbrains.kotlin.types.checker.KotlinTypeRefiner
import org.jetbrains.kotlin.types.checker.NewTypeVariableConstructor
import org.jetbrains.kotlin.types.error.ErrorTypeKind
import org.jetbrains.kotlin.types.error.ErrorUtils
import org.jetbrains.kotlin.utils.SmartSet
import org.jetbrains.kotlin.utils.newHashMapWithExpectedSize

open class TypeUtils {
    open class SpecialType(private val nameValue: String) : DelegatingSimpleType() {
        protected override val delegate: SimpleType get() = throw IllegalStateException(nameValue)
        override fun replaceAttributes(newAttributes: TypeAttributes): SimpleType = throw IllegalStateException(nameValue)
        override fun makeNullableAsSpecified(newNullability: Boolean): SimpleType = throw IllegalStateException(nameValue)
        override fun toString(): String = nameValue
        @TypeRefinement
        override fun replaceDelegate(delegate: SimpleType): DelegatingSimpleType = throw IllegalStateException(nameValue)
        @TypeRefinement
        override fun refine(kotlinTypeRefiner: KotlinTypeRefiner): SpecialType = this
    }

    companion object {
        @JvmField val DONT_CARE: SimpleType = ErrorUtils.createErrorType(ErrorTypeKind.DONT_CARE)
        @JvmField val CANNOT_INFER_FUNCTION_PARAM_TYPE: SimpleType = ErrorUtils.createErrorType(ErrorTypeKind.UNINFERRED_LAMBDA_PARAMETER_TYPE)
        @JvmField val NO_EXPECTED_TYPE: SimpleType = SpecialType("NO_EXPECTED_TYPE")
        @JvmField val UNIT_EXPECTED_TYPE: SimpleType = SpecialType("UNIT_EXPECTED_TYPE")

        @JvmStatic fun noExpectedType(type: KotlinType): Boolean = type === NO_EXPECTED_TYPE || type === UNIT_EXPECTED_TYPE
        @JvmStatic fun isDontCarePlaceholder(type: KotlinType?): Boolean = type != null && type.constructor === DONT_CARE.constructor
        @JvmStatic fun makeNullable(type: KotlinType): KotlinType = makeNullableAsSpecified(type, true)
        @JvmStatic fun makeNotNullable(type: KotlinType): KotlinType = makeNullableAsSpecified(type, false)
        @JvmStatic fun makeNullableAsSpecified(type: KotlinType, nullable: Boolean): KotlinType = type.unwrap().makeNullableAsSpecified(nullable)
        @JvmStatic fun makeNullableIfNeeded(type: SimpleType, nullable: Boolean): SimpleType = if (nullable) type.makeNullableAsSpecified(true) else type
        @JvmStatic fun makeNullableIfNeeded(type: KotlinType, nullable: Boolean): KotlinType = if (nullable) makeNullable(type) else type

        @JvmStatic fun canHaveSubtypes(typeChecker: KotlinTypeChecker, type: KotlinType): Boolean {
            if (type.isMarkedNullable) return true
            if (!type.constructor.isFinal) return true
            val parameters = type.constructor.parameters
            val arguments = type.arguments
            for (i in parameters.indices) {
                val parameterDescriptor = parameters[i]
                val typeProjection = arguments[i]
                if (typeProjection.isStarProjection()) return true
                val projectionKind = typeProjection.getProjectionKind()
                val argument = typeProjection.getType()
                when (parameterDescriptor.variance) {
                    Variance.INVARIANT -> when (projectionKind) {
                        Variance.INVARIANT -> if (lowerThanBound(typeChecker, argument, parameterDescriptor) || canHaveSubtypes(typeChecker, argument)) return true
                        Variance.IN_VARIANCE -> if (lowerThanBound(typeChecker, argument, parameterDescriptor)) return true
                        Variance.OUT_VARIANCE -> if (canHaveSubtypes(typeChecker, argument)) return true
                    }
                    Variance.IN_VARIANCE -> if (projectionKind != Variance.OUT_VARIANCE) {
                        if (lowerThanBound(typeChecker, argument, parameterDescriptor)) return true
                    } else if (canHaveSubtypes(typeChecker, argument)) return true
                    Variance.OUT_VARIANCE -> if (projectionKind != Variance.IN_VARIANCE) {
                        if (canHaveSubtypes(typeChecker, argument)) return true
                    } else if (lowerThanBound(typeChecker, argument, parameterDescriptor)) return true
                }
            }
            return false
        }

        private fun lowerThanBound(typeChecker: KotlinTypeChecker, argument: KotlinType, parameterDescriptor: TypeParameterDescriptor): Boolean {
            for (bound in parameterDescriptor.upperBounds) {
                if (typeChecker.isSubtypeOf(argument, bound) && argument.constructor != bound.constructor) return true
            }
            return false
        }

        @JvmStatic fun makeUnsubstitutedType(classifierDescriptor: ClassifierDescriptor, unsubstitutedMemberScope: MemberScope, refinedTypeFactory: (KotlinTypeRefiner) -> SimpleType?): SimpleType {
            if (ErrorUtils.isError(classifierDescriptor)) return ErrorUtils.createErrorType(ErrorTypeKind.UNABLE_TO_SUBSTITUTE_TYPE, classifierDescriptor.toString())
            return makeUnsubstitutedType(classifierDescriptor.typeConstructor, unsubstitutedMemberScope, refinedTypeFactory)
        }

        @JvmStatic fun makeUnsubstitutedType(typeConstructor: TypeConstructor, unsubstitutedMemberScope: MemberScope, refinedTypeFactory: (KotlinTypeRefiner) -> SimpleType?): SimpleType =
            KotlinTypeFactory.simpleTypeWithNonTrivialMemberScope(TypeAttributes.Empty, typeConstructor, getDefaultTypeProjections(typeConstructor.parameters), false, unsubstitutedMemberScope, refinedTypeFactory)

        @JvmStatic fun getDefaultTypeProjections(parameters: List<TypeParameterDescriptor>): List<TypeProjection> =
            parameters.map { TypeProjectionImpl(it.defaultType) }.toList()

        @JvmStatic fun getImmediateSupertypes(type: KotlinType): MutableList<KotlinType> {
            val substitutor = TypeSubstitutor.create(type)
            val originalSupertypes = type.constructor.supertypes
            val result = ArrayList<KotlinType>(originalSupertypes.size)
            for (supertype in originalSupertypes) {
                val substitutedType = createSubstitutedSupertype(type, supertype, substitutor)
                if (substitutedType != null) result.add(substitutedType)
            }
            return result
        }

        @JvmStatic fun createSubstitutedSupertype(subType: KotlinType, superType: KotlinType, substitutor: TypeSubstitutor): KotlinType? {
            val substitutedType = substitutor.substitute(superType, Variance.INVARIANT)
            return if (substitutedType != null) makeNullableIfNeeded(substitutedType, subType.isMarkedNullable) else null
        }

        private fun collectAllSupertypes(type: KotlinType, result: MutableSet<KotlinType>) {
            val immediateSupertypes = getImmediateSupertypes(type)
            result.addAll(immediateSupertypes)
            for (supertype in immediateSupertypes) collectAllSupertypes(supertype, result)
        }

        @JvmStatic fun getAllSupertypes(type: KotlinType): MutableSet<KotlinType> {
            val result = LinkedHashSet<KotlinType>(15)
            collectAllSupertypes(type, result)
            return result
        }

        @JvmStatic fun isNullableType(type: KotlinType): Boolean {
            if (type.isMarkedNullable) return true
            if (type.isFlexible() && isNullableType(type.asFlexibleType().upperBound)) return true
            if (type.isDefinitelyNotNullType) return false
            if (isTypeParameter(type)) return hasNullableSuperType(type)
            if (type is AbstractStubType) {
                val typeVariableConstructor = type.originalTypeVariable as NewTypeVariableConstructor
                val typeParameter = typeVariableConstructor.originalTypeParameter
                return typeParameter == null || hasNullableSuperType(typeParameter.defaultType)
            }
            val constructor = type.constructor
            if (constructor is IntersectionTypeConstructor) for (supertype in constructor.supertypes) if (isNullableType(supertype)) return true
            return false
        }

        @JvmStatic fun acceptsNullable(type: KotlinType): Boolean {
            if (type.isMarkedNullable) return true
            if (type.isFlexible() && acceptsNullable(type.asFlexibleType().upperBound)) return true
            return false
        }

        @JvmStatic fun hasNullableSuperType(type: KotlinType): Boolean {
            if (type.constructor.declarationDescriptor is ClassDescriptor) return false
            for (supertype in getImmediateSupertypes(type)) if (isNullableType(supertype)) return true
            return false
        }

        @JvmStatic fun getClassDescriptor(type: KotlinType): ClassDescriptor? = type.constructor.declarationDescriptor as? ClassDescriptor
        @JvmStatic fun substituteParameters(clazz: ClassDescriptor, typeArguments: List<KotlinType>): KotlinType? =
            substituteProjectionsForParameters(clazz, typeArguments.map { TypeProjectionImpl(it) })

        @JvmStatic fun substituteProjectionsForParameters(clazz: ClassDescriptor, projections: List<TypeProjection>): KotlinType? {
            val clazzTypeParameters = clazz.typeConstructor.parameters
            if (clazzTypeParameters.size != projections.size) throw IllegalArgumentException("type parameter counts do not match: $clazz, $projections")
            val substitutions = newHashMapWithExpectedSize<TypeConstructor, TypeProjection>(clazzTypeParameters.size)
            for (i in clazzTypeParameters.indices) substitutions[clazzTypeParameters[i].typeConstructor] = projections[i]
            return TypeSubstitutor.create(substitutions).substitute(clazz.defaultType, Variance.INVARIANT)
        }

        @JvmStatic fun equalTypes(a: KotlinType, b: KotlinType): Boolean = KotlinTypeChecker.DEFAULT.equalTypes(a, b)
        @JvmStatic fun dependsOnTypeParameters(type: KotlinType, typeParameters: Collection<TypeParameterDescriptor>): Boolean =
            dependsOnTypeConstructors(type, typeParameters.map { it.typeConstructor })

        @JvmStatic fun dependsOnTypeConstructors(type: KotlinType, typeParameterConstructors: Collection<TypeConstructor>): Boolean {
            if (type.constructor in typeParameterConstructors) return true
            for (typeProjection in type.arguments) if (!typeProjection.isStarProjection() && dependsOnTypeConstructors(typeProjection.getType(), typeParameterConstructors)) return true
            return false
        }

        @JvmStatic fun contains(type: KotlinType?, specialType: KotlinType): Boolean = contains(type, { specialType == it }, null)
        @JvmStatic fun contains(type: KotlinType?, isSpecialType: (UnwrappedType) -> Boolean): Boolean = contains(type, isSpecialType, null)

        private fun contains(type: KotlinType?, isSpecialType: (UnwrappedType) -> Boolean, initialVisited: SmartSet<KotlinType>?): Boolean {
            if (type == null) return false
            val unwrappedType = type.unwrap()
            if (noExpectedType(type)) return isSpecialType(unwrappedType)
            if (initialVisited != null && type in initialVisited) return false
            if (isSpecialType(unwrappedType)) return true
            val visited = initialVisited ?: SmartSet.create()
            visited.add(type)
            val flexibleType = unwrappedType as? FlexibleType
            if (flexibleType != null && (contains(flexibleType.lowerBound, isSpecialType, visited) || contains(flexibleType.upperBound, isSpecialType, visited))) return true
            if (unwrappedType is DefinitelyNotNullType && contains(unwrappedType.original, isSpecialType, visited)) return true
            val typeConstructor = type.constructor
            if (typeConstructor is IntersectionTypeConstructor) {
                for (supertype in typeConstructor.supertypes) if (contains(supertype, isSpecialType, visited)) return true
                return false
            }
            for (projection in type.arguments) {
                if (projection.isStarProjection()) continue
                if (contains(projection.getType(), isSpecialType, visited)) return true
            }
            return false
        }

        @JvmStatic fun makeStarProjection(parameterDescriptor: TypeParameterDescriptor): TypeProjection = StarProjectionImpl(parameterDescriptor)
        @JvmStatic fun makeStarProjection(parameterDescriptor: TypeParameterDescriptor, attr: ErasureTypeAttributes): TypeProjection =
            if (attr.howThisTypeIsUsed == TypeUsage.SUPERTYPE) TypeProjectionImpl(parameterDescriptor.starProjectionType()) else StarProjectionImpl(parameterDescriptor)

        @JvmStatic fun getDefaultPrimitiveNumberType(numberValueTypeConstructor: IntegerValueTypeConstructor): KotlinType {
            val type = getDefaultPrimitiveNumberType(numberValueTypeConstructor.supertypes)
            assert(type != null) { "Strange number value type constructor: $numberValueTypeConstructor. Super types doesn't contain double, int or long: ${numberValueTypeConstructor.supertypes}" }
            return type!!
        }

        @JvmStatic fun getDefaultPrimitiveNumberType(supertypes: Collection<KotlinType>): KotlinType? {
            if (supertypes.isEmpty()) return null
            val builtIns = supertypes.first().constructor.builtIns
            val doubleType = builtIns.doubleType
            if (doubleType in supertypes) return doubleType
            val intType = builtIns.intType
            if (intType in supertypes) return intType
            val longType = builtIns.longType
            if (longType in supertypes) return longType
            findByFqName(supertypes, StandardNames.FqNames.uIntFqName)?.let { return it }
            findByFqName(supertypes, StandardNames.FqNames.uLongFqName)?.let { return it }
            return null
        }

        private fun findByFqName(supertypes: Collection<KotlinType>, fqName: FqName): KotlinType? {
            for (supertype in supertypes) {
                val descriptor = supertype.constructor.declarationDescriptor ?: continue
                if (DescriptorUtils.getFqName(descriptor) == fqName.toUnsafe()) return supertype
            }
            return null
        }

        @JvmStatic fun getPrimitiveNumberType(numberValueTypeConstructor: IntegerValueTypeConstructor, expectedType: KotlinType): KotlinType {
            if (noExpectedType(expectedType) || expectedType.isError) return getDefaultPrimitiveNumberType(numberValueTypeConstructor)
            for (primitiveNumberType in numberValueTypeConstructor.supertypes) if (KotlinTypeChecker.DEFAULT.isSubtypeOf(primitiveNumberType, expectedType)) return primitiveNumberType
            return getDefaultPrimitiveNumberType(numberValueTypeConstructor)
        }

        @JvmStatic fun getPrimitiveNumberType(literalTypeConstructor: IntegerLiteralTypeConstructor, expectedType: KotlinType): KotlinType {
            if (noExpectedType(expectedType) || expectedType.isError) return literalTypeConstructor.getApproximatedType()
            val approximatedType = literalTypeConstructor.getApproximatedType()
            if (KotlinTypeChecker.DEFAULT.isSubtypeOf(approximatedType, expectedType)) return approximatedType
            for (primitiveNumberType in literalTypeConstructor.possibleTypes) if (KotlinTypeChecker.DEFAULT.isSubtypeOf(primitiveNumberType, expectedType)) return primitiveNumberType
            return literalTypeConstructor.getApproximatedType()
        }

        @JvmStatic fun isTypeParameter(type: KotlinType): Boolean = getTypeParameterDescriptorOrNull(type) != null || type.constructor is NewTypeVariableConstructor
        @JvmStatic fun isReifiedTypeParameter(type: KotlinType): Boolean = getTypeParameterDescriptorOrNull(type)?.isReified == true
        @JvmStatic fun isNonReifiedTypeParameter(type: KotlinType): Boolean = getTypeParameterDescriptorOrNull(type)?.let { !it.isReified } ?: false
        @JvmStatic fun getTypeParameterDescriptorOrNull(type: KotlinType): TypeParameterDescriptor? = type.constructor.declarationDescriptor as? TypeParameterDescriptor
    }
}
