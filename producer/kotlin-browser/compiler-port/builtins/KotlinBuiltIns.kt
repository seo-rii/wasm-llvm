/*
 * Copyright 2010-2018 JetBrains s.r.o. and Kotlin Programming Language contributors.
 * Use of this source code is governed by the Apache 2.0 license that can be found in the license/LICENSE.txt file.
 */

package org.jetbrains.kotlin.builtins

import org.jetbrains.kotlin.builtins.PrimitiveType.*
import org.jetbrains.kotlin.builtins.StandardNames.ANNOTATION_PACKAGE_FQ_NAME
import org.jetbrains.kotlin.builtins.StandardNames.BUILT_INS_PACKAGE_FQ_NAME
import org.jetbrains.kotlin.builtins.StandardNames.BUILT_INS_PACKAGE_NAME
import org.jetbrains.kotlin.builtins.StandardNames.COLLECTIONS_PACKAGE_FQ_NAME
import org.jetbrains.kotlin.builtins.StandardNames.COROUTINES_PACKAGE_FQ_NAME
import org.jetbrains.kotlin.builtins.StandardNames.FqNames
import org.jetbrains.kotlin.builtins.StandardNames.RANGES_PACKAGE_FQ_NAME
import org.jetbrains.kotlin.builtins.StandardNames.getFunctionName
import org.jetbrains.kotlin.builtins.StandardNames.getKFunctionFqName
import org.jetbrains.kotlin.builtins.StandardNames.getSuspendFunctionName
import org.jetbrains.kotlin.builtins.functions.BuiltInFictitiousFunctionClassFactory
import org.jetbrains.kotlin.builtins.functions.FunctionTypeKind
import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.descriptors.annotations.Annotations
import org.jetbrains.kotlin.descriptors.deserialization.AdditionalClassPartsProvider
import org.jetbrains.kotlin.descriptors.deserialization.ClassDescriptorFactory
import org.jetbrains.kotlin.descriptors.deserialization.PlatformDependentDeclarationFilter
import org.jetbrains.kotlin.descriptors.impl.ModuleDescriptorImpl
import org.jetbrains.kotlin.incremental.components.NoLookupLocation
import org.jetbrains.kotlin.name.ClassId
import org.jetbrains.kotlin.name.FqName
import org.jetbrains.kotlin.name.FqNameUnsafe
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.portable.assertions.compilerAssert as assert
import org.jetbrains.kotlin.resolve.DescriptorUtils
import org.jetbrains.kotlin.resolve.DescriptorUtils.getFqName
import org.jetbrains.kotlin.resolve.descriptorUtil.classId
import org.jetbrains.kotlin.resolve.scopes.MemberScope
import org.jetbrains.kotlin.storage.MemoizedFunctionToNotNull
import org.jetbrains.kotlin.storage.NotNullLazyValue
import org.jetbrains.kotlin.storage.StorageManager
import org.jetbrains.kotlin.types.*
import org.jetbrains.kotlin.types.checker.KotlinTypeChecker
import kotlin.jvm.JvmField
import kotlin.jvm.JvmName
import kotlin.jvm.JvmStatic

/** Complete source port of the selected KotlinBuiltIns.java. See sources.lock.json. */
abstract class KotlinBuiltIns protected constructor(private val storageManagerImpl: StorageManager) {
    private var builtInsModuleValue: ModuleDescriptorImpl? = null
    private var postponedBuiltInsModule: NotNullLazyValue<ModuleDescriptorImpl>? = null

    private val builtInPackagesImportedByDefaultValue: NotNullLazyValue<Collection<PackageViewDescriptor>> =
        storageManagerImpl.createLazyValue {
            listOf(
                getBuiltInsModule().getPackage(BUILT_INS_PACKAGE_FQ_NAME),
                getBuiltInsModule().getPackage(COLLECTIONS_PACKAGE_FQ_NAME),
                getBuiltInsModule().getPackage(RANGES_PACKAGE_FQ_NAME),
                getBuiltInsModule().getPackage(ANNOTATION_PACKAGE_FQ_NAME),
            )
        }

    private val primitives: NotNullLazyValue<Primitives> = storageManagerImpl.createLazyValue {
        val primitiveTypeToArrayKotlinType = mutableMapOf<PrimitiveType, SimpleType>()
        val primitiveKotlinTypeToKotlinArrayType = mutableMapOf<KotlinType, SimpleType>()
        val kotlinArrayTypeToPrimitiveKotlinType = mutableMapOf<SimpleType, SimpleType>()
        for (primitive in PrimitiveType.values()) {
            val type = getBuiltInTypeByClassName(primitive.typeName.asString())
            val arrayType = getBuiltInTypeByClassName(primitive.arrayTypeName.asString())
            primitiveTypeToArrayKotlinType[primitive] = arrayType
            primitiveKotlinTypeToKotlinArrayType[type] = arrayType
            kotlinArrayTypeToPrimitiveKotlinType[arrayType] = type
        }
        Primitives(primitiveTypeToArrayKotlinType, primitiveKotlinTypeToKotlinArrayType, kotlinArrayTypeToPrimitiveKotlinType)
    }

    private val builtInClassesByName: MemoizedFunctionToNotNull<Name, ClassDescriptor> =
        storageManagerImpl.createMemoizedFunction { name: Name ->
            val classifier = getBuiltInsPackageScope().getContributedClassifier(name, NoLookupLocation.FROM_BUILTINS)
            if (classifier == null) {
                throw AssertionError("Built-in class " + BUILT_INS_PACKAGE_FQ_NAME.child(name) + " is not found")
            }
            if (classifier !is ClassDescriptor) {
                throw AssertionError("Must be a class descriptor " + name + ", but was " + classifier)
            }
            classifier
        }

    protected open fun createBuiltInsModule(isFallback: Boolean) {
        builtInsModuleValue = ModuleDescriptorImpl(BUILTINS_MODULE_NAME, storageManagerImpl, this, null)
        builtInsModuleValue!!.initialize(BuiltInsLoader.Instance.createPackageFragmentProvider(
            storageManagerImpl, builtInsModuleValue!!, getClassDescriptorFactories(),
            getPlatformDependentDeclarationFilter(), getAdditionalClassPartsProvider(), isFallback,
        ))
        builtInsModuleValue!!.setDependencies(builtInsModuleValue!!)
    }

    open fun setBuiltInsModule(module: ModuleDescriptorImpl) {
        storageManagerImpl.compute {
            if (builtInsModuleValue != null) {
                throw AssertionError("Built-ins module is already set: " + builtInsModuleValue + " (attempting to reset to " + module + ")")
            }
            builtInsModuleValue = module
            null
        }
    }

    open fun setPostponedBuiltinsModuleComputation(computation: () -> ModuleDescriptorImpl) {
        postponedBuiltInsModule = storageManagerImpl.createLazyValue(computation)
    }

    protected open fun getAdditionalClassPartsProvider(): AdditionalClassPartsProvider = AdditionalClassPartsProvider.None
    protected open fun getPlatformDependentDeclarationFilter(): PlatformDependentDeclarationFilter =
        PlatformDependentDeclarationFilter.NoPlatformDependent
    protected open fun getClassDescriptorFactories(): Iterable<ClassDescriptorFactory> =
        listOf(BuiltInFictitiousFunctionClassFactory(storageManagerImpl, getBuiltInsModule()))
    protected open fun getStorageManager(): StorageManager = storageManagerImpl

    private class Primitives(
        val primitiveTypeToArrayKotlinType: Map<PrimitiveType, SimpleType>,
        val primitiveKotlinTypeToKotlinArrayType: Map<KotlinType, SimpleType>,
        val kotlinArrayTypeToPrimitiveKotlinType: Map<SimpleType, SimpleType>,
    )

    open fun getBuiltInsModule(): ModuleDescriptorImpl {
        assert(builtInsModuleValue != null || postponedBuiltInsModule != null) { "Uninitialized built-ins module" }
        if (builtInsModuleValue == null) builtInsModuleValue = postponedBuiltInsModule!!.invoke()
        return builtInsModuleValue!!
    }

    open fun getBuiltInPackagesImportedByDefault(): Collection<PackageViewDescriptor> = builtInPackagesImportedByDefaultValue.invoke()
    open fun getBuiltInsPackageScope(): MemberScope = getBuiltInsModule().getPackage(BUILT_INS_PACKAGE_FQ_NAME).memberScope

    open fun getBuiltInClassByFqName(fqName: FqName): ClassDescriptor {
        val descriptor = getBuiltInsModule().resolveClassByFqName(fqName, NoLookupLocation.FROM_BUILTINS)
        assert(descriptor != null) { "Can't find built-in class " + fqName }
        return descriptor!!
    }

    private fun getBuiltInClassByName(simpleName: String): ClassDescriptor = builtInClassesByName.invoke(Name.identifier(simpleName))
    private fun getPrimitiveClassDescriptor(type: PrimitiveType): ClassDescriptor = getBuiltInClassByName(type.typeName.asString())
    private fun getBuiltInTypeByClassName(classSimpleName: String): SimpleType = getBuiltInClassByName(classSimpleName).defaultType

    open fun getAny(): ClassDescriptor = getBuiltInClassByName("Any")
    open fun getNothing(): ClassDescriptor = getBuiltInClassByName("Nothing")
    open fun getByte(): ClassDescriptor = getPrimitiveClassDescriptor(BYTE)
    open fun getShort(): ClassDescriptor = getPrimitiveClassDescriptor(SHORT)
    open fun getInt(): ClassDescriptor = getPrimitiveClassDescriptor(INT)
    open fun getLong(): ClassDescriptor = getPrimitiveClassDescriptor(LONG)
    open fun getFloat(): ClassDescriptor = getPrimitiveClassDescriptor(FLOAT)
    open fun getDouble(): ClassDescriptor = getPrimitiveClassDescriptor(DOUBLE)
    open fun getChar(): ClassDescriptor = getPrimitiveClassDescriptor(CHAR)
    open fun getBoolean(): ClassDescriptor = getPrimitiveClassDescriptor(BOOLEAN)
    open fun getArray(): ClassDescriptor = getBuiltInClassByName("Array")
    open fun getPrimitiveArrayClassDescriptor(type: PrimitiveType): ClassDescriptor = getBuiltInClassByName(type.arrayTypeName.asString())
    open fun getNumber(): ClassDescriptor = getBuiltInClassByName("Number")
    open fun getUnit(): ClassDescriptor = getBuiltInClassByName("Unit")
    open fun getFunction(parameterCount: Int): ClassDescriptor = getBuiltInClassByName(getFunctionName(parameterCount))
    open fun getSuspendFunction(parameterCount: Int): ClassDescriptor =
        getBuiltInClassByFqName(COROUTINES_PACKAGE_FQ_NAME.child(Name.identifier(getSuspendFunctionName(parameterCount))))
    open fun getKFunction(parameterCount: Int): ClassDescriptor = getBuiltInClassByFqName(getKFunctionFqName(parameterCount).toSafe())
    open fun getKSuspendFunction(parameterCount: Int): ClassDescriptor {
        val name = Name.identifier(FunctionTypeKind.KSuspendFunction.classNamePrefix + parameterCount)
        return getBuiltInClassByFqName(COROUTINES_PACKAGE_FQ_NAME.child(name))
    }
    open fun getThrowable(): ClassDescriptor = getBuiltInClassByName("Throwable")
    open fun getString(): ClassDescriptor = getBuiltInClassByName("String")
    open fun getCharSequence(): ClassDescriptor = getBuiltInClassByName("CharSequence")
    open fun getComparable(): ClassDescriptor = getBuiltInClassByName("Comparable")
    open fun getEnum(): ClassDescriptor = getBuiltInClassByName("Enum")
    open fun getAnnotation(): ClassDescriptor = getBuiltInClassByName("Annotation")
    open fun getKClass(): ClassDescriptor = getBuiltInClassByFqName(FqNames.kClass.toSafe())
    open fun getKType(): ClassDescriptor = getBuiltInClassByFqName(FqNames.kType.toSafe())
    open fun getKCallable(): ClassDescriptor = getBuiltInClassByFqName(FqNames.kCallable.toSafe())
    open fun getKProperty(): ClassDescriptor = getBuiltInClassByFqName(FqNames.kPropertyFqName.toSafe())
    open fun getKProperty0(): ClassDescriptor = getBuiltInClassByFqName(FqNames.kProperty0.toSafe())
    open fun getKProperty1(): ClassDescriptor = getBuiltInClassByFqName(FqNames.kProperty1.toSafe())
    open fun getKProperty2(): ClassDescriptor = getBuiltInClassByFqName(FqNames.kProperty2.toSafe())
    open fun getKMutableProperty0(): ClassDescriptor = getBuiltInClassByFqName(FqNames.kMutableProperty0.toSafe())
    open fun getKMutableProperty1(): ClassDescriptor = getBuiltInClassByFqName(FqNames.kMutableProperty1.toSafe())
    open fun getKMutableProperty2(): ClassDescriptor = getBuiltInClassByFqName(FqNames.kMutableProperty2.toSafe())
    open fun getIterator(): ClassDescriptor = getBuiltInClassByFqName(FqNames.iterator)
    open fun getIterable(): ClassDescriptor = getBuiltInClassByFqName(FqNames.iterable)
    open fun getMutableIterable(): ClassDescriptor = getBuiltInClassByFqName(FqNames.mutableIterable)
    open fun getMutableIterator(): ClassDescriptor = getBuiltInClassByFqName(FqNames.mutableIterator)
    open fun getCollection(): ClassDescriptor = getBuiltInClassByFqName(FqNames.collection)
    open fun getMutableCollection(): ClassDescriptor = getBuiltInClassByFqName(FqNames.mutableCollection)
    open fun getList(): ClassDescriptor = getBuiltInClassByFqName(FqNames.list)
    open fun getMutableList(): ClassDescriptor = getBuiltInClassByFqName(FqNames.mutableList)
    open fun getSet(): ClassDescriptor = getBuiltInClassByFqName(FqNames.set)
    open fun getMutableSet(): ClassDescriptor = getBuiltInClassByFqName(FqNames.mutableSet)
    open fun getMap(): ClassDescriptor = getBuiltInClassByFqName(FqNames.map)
    open fun getMutableMap(): ClassDescriptor = getBuiltInClassByFqName(FqNames.mutableMap)
    open fun getMapEntry(): ClassDescriptor {
        val descriptor = DescriptorUtils.getInnerClassByName(getMap(), "Entry", NoLookupLocation.FROM_BUILTINS)
        assert(descriptor != null) { "Can't find Map.Entry" }
        return descriptor!!
    }
    open fun getMutableMapEntry(): ClassDescriptor {
        val descriptor = DescriptorUtils.getInnerClassByName(getMutableMap(), "MutableEntry", NoLookupLocation.FROM_BUILTINS)
        assert(descriptor != null) { "Can't find MutableMap.MutableEntry" }
        return descriptor!!
    }
    open fun getListIterator(): ClassDescriptor = getBuiltInClassByFqName(FqNames.listIterator)
    open fun getMutableListIterator(): ClassDescriptor = getBuiltInClassByFqName(FqNames.mutableListIterator)

    open fun getNothingType(): SimpleType = getNothing().defaultType
    open fun getNullableNothingType(): SimpleType = getNothingType().makeNullableAsSpecified(true)
    open fun getAnyType(): SimpleType = getAny().defaultType
    open fun getNullableAnyType(): SimpleType = getAnyType().makeNullableAsSpecified(true)
    open fun getDefaultBound(): SimpleType = getNullableAnyType()
    open fun getPrimitiveKotlinType(type: PrimitiveType): SimpleType = getPrimitiveClassDescriptor(type).defaultType
    open fun getNumberType(): SimpleType = getNumber().defaultType
    open fun getByteType(): SimpleType = getPrimitiveKotlinType(BYTE)
    open fun getShortType(): SimpleType = getPrimitiveKotlinType(SHORT)
    open fun getIntType(): SimpleType = getPrimitiveKotlinType(INT)
    open fun getLongType(): SimpleType = getPrimitiveKotlinType(LONG)
    open fun getFloatType(): SimpleType = getPrimitiveKotlinType(FLOAT)
    open fun getDoubleType(): SimpleType = getPrimitiveKotlinType(DOUBLE)
    open fun getCharType(): SimpleType = getPrimitiveKotlinType(CHAR)
    open fun getBooleanType(): SimpleType = getPrimitiveKotlinType(BOOLEAN)
    open fun getUnitType(): SimpleType = getUnit().defaultType
    open fun getStringType(): SimpleType = getString().defaultType
    open fun getIterableType(): KotlinType = getIterable().defaultType
    open fun getAnnotationType(): SimpleType = getAnnotation().defaultType

    open fun getArrayElementType(arrayType: KotlinType): KotlinType {
        val result = getArrayElementTypeOrNull(arrayType)
        if (result == null) throw IllegalStateException("not array: " + arrayType)
        return result
    }

    open fun getArrayElementTypeOrNull(arrayType: KotlinType): KotlinType? {
        if (isArray(arrayType)) {
            if (arrayType.arguments.size != 1) return null
            return arrayType.arguments[0].type
        }
        val notNullArrayType = TypeUtils.makeNotNullable(arrayType)
        val primitiveType = primitives.invoke().kotlinArrayTypeToPrimitiveKotlinType[notNullArrayType]
        if (primitiveType != null) return primitiveType
        val module = DescriptorUtils.getContainingModuleOrNull(notNullArrayType)
        if (module != null) {
            val unsignedType = getElementTypeForUnsignedArray(notNullArrayType, module)
            if (unsignedType != null) return unsignedType
        }
        return null
    }

    open fun getPrimitiveArrayKotlinType(primitiveType: PrimitiveType): SimpleType =
        primitives.invoke().primitiveTypeToArrayKotlinType[primitiveType]!!

    open fun getPrimitiveArrayKotlinTypeByPrimitiveKotlinType(kotlinType: KotlinType): SimpleType? {
        val primitiveArray = primitives.invoke().primitiveKotlinTypeToKotlinArrayType[kotlinType]
        if (primitiveArray != null) return primitiveArray
        if (UnsignedTypes.isUnsignedType(kotlinType)) {
            if (TypeUtils.isNullableType(kotlinType)) return null
            val module = DescriptorUtils.getContainingModuleOrNull(kotlinType) ?: return null
            val unsignedClassId = kotlinType.constructor.declarationDescriptor.classId
            assert(unsignedClassId != null) { "unsignedClassId should not be null for unsigned type " + kotlinType }
            val arrayClassId = UnsignedTypes.getUnsignedArrayClassIdByUnsignedClassId(unsignedClassId!!)
            assert(arrayClassId != null) { "arrayClassId should not be null for unsigned type " + unsignedClassId }
            val arrayClassDescriptor = module.findClassAcrossModuleDependencies(arrayClassId!!) ?: return null
            return arrayClassDescriptor.defaultType
        }
        return null
    }

    open fun getArrayType(projectionType: Variance, argument: KotlinType, annotations: Annotations): SimpleType =
        KotlinTypeFactory.simpleNotNullType(annotations.toDefaultAttributes(), getArray(), listOf(TypeProjectionImpl(projectionType, argument)))
    open fun getArrayType(projectionType: Variance, argument: KotlinType): SimpleType =
        getArrayType(projectionType, argument, Annotations.EMPTY)
    open fun getEnumType(argument: SimpleType): SimpleType =
        KotlinTypeFactory.simpleNotNullType(TypeAttributes.Empty, getEnum(), listOf(TypeProjectionImpl(Variance.INVARIANT, argument)))
    open fun isBooleanOrSubtype(type: KotlinType): Boolean = KotlinTypeChecker.DEFAULT.isSubtypeOf(type, getBooleanType())
    open fun isMemberOfAny(descriptor: DeclarationDescriptor): Boolean = descriptor.containingDeclaration === getAny()

    // Explicit properties retain all Java synthetic-property source spellings.
    // The original methods remain available to Kotlin and to genuine JVM dependencies.
    @get:JvmName("builtInsModuleProperty")
    @set:JvmName("setBuiltInsModuleProperty")
    var builtInsModule: ModuleDescriptorImpl
        get() = getBuiltInsModule()
        set(value) = setBuiltInsModule(value)

    @get:JvmName("builtInPackagesImportedByDefaultProperty")
    val builtInPackagesImportedByDefault: Collection<PackageViewDescriptor> get() = getBuiltInPackagesImportedByDefault()
    @get:JvmName("builtInsPackageScopeProperty")
    val builtInsPackageScope: MemberScope get() = getBuiltInsPackageScope()
    @get:JvmName("storageManagerProperty")
    protected val storageManager: StorageManager get() = getStorageManager()
    @get:JvmName("additionalClassPartsProviderProperty")
    protected val additionalClassPartsProvider: AdditionalClassPartsProvider get() = getAdditionalClassPartsProvider()
    @get:JvmName("platformDependentDeclarationFilterProperty")
    protected val platformDependentDeclarationFilter: PlatformDependentDeclarationFilter get() = getPlatformDependentDeclarationFilter()
    @get:JvmName("classDescriptorFactoriesProperty")
    protected val classDescriptorFactories: Iterable<ClassDescriptorFactory> get() = getClassDescriptorFactories()

    // Remaining zero-argument Java getter aliases are mechanically generated from
    // the pinned method inventory during preparation, after verifying this file.
    // GENERATED_GETTER_ALIASES

    companion object {
        @JvmField
        val BUILTINS_MODULE_NAME: Name = Name.special("<built-ins module>")

        @JvmStatic
        fun isBuiltIn(descriptor: DeclarationDescriptor): Boolean {
            // Exact non-strict parent traversal; avoids java.lang.Class.isInstance.
            var current: DeclarationDescriptor? = descriptor
            while (current != null) {
                if (current is BuiltInsPackageFragment) return true
                current = current.containingDeclaration
            }
            return false
        }

        @JvmStatic
        fun isUnderKotlinPackage(descriptor: DeclarationDescriptor): Boolean {
            var current: DeclarationDescriptor? = descriptor
            while (current != null) {
                if (current is PackageFragmentDescriptor) return current.fqName.startsWith(BUILT_INS_PACKAGE_NAME)
                current = current.containingDeclaration
            }
            return false
        }

        private fun getElementTypeForUnsignedArray(notNullArrayType: KotlinType, module: ModuleDescriptor): KotlinType? {
            val descriptor = notNullArrayType.constructor.declarationDescriptor ?: return null
            if (!UnsignedTypes.isShortNameOfUnsignedArray(descriptor.name)) return null
            val arrayClassId = descriptor.classId ?: return null
            val elementClassId = UnsignedTypes.getUnsignedClassIdByArrayClassId(arrayClassId) ?: return null
            val elementClassDescriptor = module.findClassAcrossModuleDependencies(elementClassId) ?: return null
            return elementClassDescriptor.defaultType
        }

        @JvmStatic
        fun getPrimitiveType(descriptor: DeclarationDescriptor): PrimitiveType? =
            if (descriptor.name in FqNames.primitiveTypeShortNames) FqNames.fqNameToPrimitiveType[getFqName(descriptor)] else null
        @JvmStatic
        fun getPrimitiveArrayType(descriptor: DeclarationDescriptor): PrimitiveType? =
            if (descriptor.name in FqNames.primitiveArrayTypeShortNames) FqNames.arrayClassFqNameToPrimitiveType[getFqName(descriptor)] else null
        @JvmStatic
        fun isArray(type: KotlinType): Boolean = isConstructedFromGivenClass(type, FqNames.array)
        @JvmStatic
        fun isArrayOrPrimitiveArray(descriptor: ClassDescriptor): Boolean =
            classFqNameEquals(descriptor, FqNames.array) || getPrimitiveArrayType(descriptor) != null
        @JvmStatic
        fun isArrayOrPrimitiveArray(type: KotlinType): Boolean = isArray(type) || isPrimitiveArray(type)
        @JvmStatic
        fun isPrimitiveArray(type: KotlinType): Boolean {
            val descriptor = type.constructor.declarationDescriptor
            return descriptor != null && getPrimitiveArrayType(descriptor) != null
        }
        @JvmStatic
        fun getPrimitiveArrayElementType(type: KotlinType): PrimitiveType? =
            type.constructor.declarationDescriptor?.let { getPrimitiveArrayType(it) }
        @JvmStatic
        fun getPrimitiveType(type: KotlinType): PrimitiveType? = type.constructor.declarationDescriptor?.let { getPrimitiveType(it) }
        @JvmStatic
        fun isPrimitiveType(type: KotlinType): Boolean = !type.isMarkedNullable && isPrimitiveTypeOrNullablePrimitiveType(type)
        @JvmStatic
        fun isPrimitiveTypeOrNullablePrimitiveType(type: KotlinType): Boolean {
            val descriptor = type.constructor.declarationDescriptor
            return descriptor is ClassDescriptor && isPrimitiveClass(descriptor)
        }
        @JvmStatic
        fun isPrimitiveClass(descriptor: ClassDescriptor): Boolean = getPrimitiveType(descriptor) != null
        private fun isConstructedFromGivenClass(type: KotlinType, fqName: FqNameUnsafe): Boolean =
            isTypeConstructorForGivenClass(type.constructor, fqName)
        @JvmStatic
        fun isConstructedFromGivenClass(type: KotlinType, fqName: FqName): Boolean = isConstructedFromGivenClass(type, fqName.toUnsafe())
        @JvmStatic
        fun isTypeConstructorForGivenClass(typeConstructor: TypeConstructor, fqName: FqNameUnsafe): Boolean {
            val descriptor = typeConstructor.declarationDescriptor
            return descriptor is ClassDescriptor && classFqNameEquals(descriptor, fqName)
        }
        private fun classFqNameEquals(descriptor: ClassifierDescriptor, fqName: FqNameUnsafe): Boolean =
            descriptor.name == fqName.shortName() && fqName == getFqName(descriptor)
        private fun isNotNullConstructedFromGivenClass(type: KotlinType, fqName: FqNameUnsafe): Boolean =
            !type.isMarkedNullable && isConstructedFromGivenClass(type, fqName)
        @JvmStatic
        fun isSpecialClassWithNoSupertypes(descriptor: ClassDescriptor): Boolean =
            classFqNameEquals(descriptor, FqNames.any) || classFqNameEquals(descriptor, FqNames.nothing)
        @JvmStatic
        fun isAny(descriptor: ClassDescriptor): Boolean = classFqNameEquals(descriptor, FqNames.any)
        @JvmStatic
        fun isAny(type: KotlinType): Boolean = isConstructedFromGivenClassAndNotNullable(type, FqNames.any)
        @JvmStatic
        fun isBoolean(type: KotlinType): Boolean = isConstructedFromGivenClassAndNotNullable(type, FqNames._boolean)
        @JvmStatic
        fun isBooleanOrNullableBoolean(type: KotlinType): Boolean = isConstructedFromGivenClass(type, FqNames._boolean)
        @JvmStatic
        fun isBoolean(classDescriptor: ClassDescriptor): Boolean = classFqNameEquals(classDescriptor, FqNames._boolean)
        @JvmStatic
        fun isNumber(type: KotlinType): Boolean = isConstructedFromGivenClassAndNotNullable(type, FqNames.number)
        @JvmStatic
        fun isChar(type: KotlinType): Boolean = isConstructedFromGivenClassAndNotNullable(type, FqNames._char)
        @JvmStatic
        fun isCharOrNullableChar(type: KotlinType): Boolean = isConstructedFromGivenClass(type, FqNames._char)
        @JvmStatic
        fun isInt(type: KotlinType): Boolean = isConstructedFromGivenClassAndNotNullable(type, FqNames._int)
        @JvmStatic
        fun isByte(type: KotlinType): Boolean = isConstructedFromGivenClassAndNotNullable(type, FqNames._byte)
        @JvmStatic
        fun isLong(type: KotlinType): Boolean = isConstructedFromGivenClassAndNotNullable(type, FqNames._long)
        @JvmStatic
        fun isLongOrNullableLong(type: KotlinType): Boolean = isConstructedFromGivenClass(type, FqNames._long)
        @JvmStatic
        fun isShort(type: KotlinType): Boolean = isConstructedFromGivenClassAndNotNullable(type, FqNames._short)
        @JvmStatic
        fun isFloat(type: KotlinType): Boolean = isFloatOrNullableFloat(type) && !type.isMarkedNullable
        @JvmStatic
        fun isFloatOrNullableFloat(type: KotlinType): Boolean = isConstructedFromGivenClass(type, FqNames._float)
        @JvmStatic
        fun isDouble(type: KotlinType): Boolean = isDoubleOrNullableDouble(type) && !type.isMarkedNullable
        @JvmStatic
        fun isUByte(type: KotlinType): Boolean = isConstructedFromGivenClassAndNotNullable(type, FqNames.uByteFqName.toUnsafe())
        @JvmStatic
        fun isUShort(type: KotlinType): Boolean = isConstructedFromGivenClassAndNotNullable(type, FqNames.uShortFqName.toUnsafe())
        @JvmStatic
        fun isUInt(type: KotlinType): Boolean = isConstructedFromGivenClassAndNotNullable(type, FqNames.uIntFqName.toUnsafe())
        @JvmStatic
        fun isULong(type: KotlinType): Boolean = isConstructedFromGivenClassAndNotNullable(type, FqNames.uLongFqName.toUnsafe())
        @JvmStatic
        fun isUByteArray(type: KotlinType): Boolean = isConstructedFromGivenClassAndNotNullable(type, FqNames.uByteArrayFqName.toUnsafe())
        @JvmStatic
        fun isUShortArray(type: KotlinType): Boolean = isConstructedFromGivenClassAndNotNullable(type, FqNames.uShortArrayFqName.toUnsafe())
        @JvmStatic
        fun isUIntArray(type: KotlinType): Boolean = isConstructedFromGivenClassAndNotNullable(type, FqNames.uIntArrayFqName.toUnsafe())
        @JvmStatic
        fun isULongArray(type: KotlinType): Boolean = isConstructedFromGivenClassAndNotNullable(type, FqNames.uLongArrayFqName.toUnsafe())
        @JvmStatic
        fun isUnsignedArrayType(type: KotlinType): Boolean = isUByteArray(type) || isUShortArray(type) || isUIntArray(type) || isULongArray(type)
        @JvmStatic
        fun isDoubleOrNullableDouble(type: KotlinType): Boolean = isConstructedFromGivenClass(type, FqNames._double)
        private fun isConstructedFromGivenClassAndNotNullable(type: KotlinType, fqName: FqNameUnsafe): Boolean =
            isConstructedFromGivenClass(type, fqName) && !type.isMarkedNullable
        @JvmStatic
        fun isNothing(type: KotlinType): Boolean = isNothingOrNullableNothing(type) && !TypeUtils.isNullableType(type)
        @JvmStatic
        fun isNullableNothing(type: KotlinType): Boolean = isNothingOrNullableNothing(type) && TypeUtils.isNullableType(type)
        @JvmStatic
        fun isNothingOrNullableNothing(type: KotlinType): Boolean = isConstructedFromGivenClass(type, FqNames.nothing)
        @JvmStatic
        fun isAnyOrNullableAny(type: KotlinType): Boolean = isConstructedFromGivenClass(type, FqNames.any)
        @JvmStatic
        fun isNullableAny(type: KotlinType): Boolean = isAnyOrNullableAny(type) && type.isMarkedNullable
        @JvmStatic
        fun isDefaultBound(type: KotlinType): Boolean = isNullableAny(type)
        @JvmStatic
        fun isUnit(type: KotlinType): Boolean = isNotNullConstructedFromGivenClass(type, FqNames.unit)

        @JvmStatic
        fun mayReturnNonUnitValue(descriptor: FunctionDescriptor): Boolean {
            val functionReturnType = descriptor.returnType
            assert(functionReturnType != null) { "Function return typed type must be resolved." }
            var mayReturnNonUnitValue = !isUnit(functionReturnType!!)
            for (overriddenDescriptor in descriptor.original.overriddenDescriptors) {
                if (mayReturnNonUnitValue) break
                val overriddenFunctionReturnType = overriddenDescriptor.returnType
                assert(overriddenFunctionReturnType != null) { "Function return typed type must be resolved." }
                mayReturnNonUnitValue = !isUnit(overriddenFunctionReturnType!!)
            }
            return mayReturnNonUnitValue
        }

        @JvmStatic
        fun isUnitOrNullableUnit(type: KotlinType): Boolean = isConstructedFromGivenClass(type, FqNames.unit)
        @JvmStatic
        fun isEnum(descriptor: ClassDescriptor): Boolean = classFqNameEquals(descriptor, FqNames._enum)
        @JvmStatic
        fun isEnum(type: KotlinType): Boolean = isConstructedFromGivenClassAndNotNullable(type, FqNames._enum)
        @JvmStatic
        fun isComparable(descriptor: ClassDescriptor): Boolean = classFqNameEquals(descriptor, FqNames.comparable.toUnsafe())
        @JvmStatic
        fun isComparable(type: KotlinType): Boolean = isConstructedFromGivenClassAndNotNullable(type, FqNames.comparable.toUnsafe())
        @JvmStatic
        fun isCharSequence(type: KotlinType?): Boolean = type != null && isNotNullConstructedFromGivenClass(type, FqNames.charSequence)
        @JvmStatic
        fun isString(type: KotlinType?): Boolean = type != null && isNotNullConstructedFromGivenClass(type, FqNames.string)
        @JvmStatic
        fun isUnsignedNumber(type: KotlinType?): Boolean = type != null && (isUByte(type) || isUShort(type) || isUInt(type) || isULong(type))
        @JvmStatic
        fun isCharSequenceOrNullableCharSequence(type: KotlinType?): Boolean =
            type != null && isConstructedFromGivenClass(type, FqNames.charSequence)
        @JvmStatic
        fun isStringOrNullableString(type: KotlinType?): Boolean = type != null && isConstructedFromGivenClass(type, FqNames.string)
        @JvmStatic
        fun isCollectionOrNullableCollection(type: KotlinType): Boolean = isConstructedFromGivenClass(type, FqNames.collection)
        @JvmStatic
        fun isListOrNullableList(type: KotlinType): Boolean = isConstructedFromGivenClass(type, FqNames.list)
        @JvmStatic
        fun isSetOrNullableSet(type: KotlinType): Boolean = isConstructedFromGivenClass(type, FqNames.set)
        @JvmStatic
        fun isMapOrNullableMap(type: KotlinType): Boolean = isConstructedFromGivenClass(type, FqNames.map)
        @JvmStatic
        fun isIterableOrNullableIterable(type: KotlinType): Boolean = isConstructedFromGivenClass(type, FqNames.iterable)
        @JvmStatic
        fun isThrowableOrNullableThrowable(type: KotlinType): Boolean = isConstructedFromGivenClass(type, FqNames.throwable)
        @JvmStatic
        fun isThrowable(descriptor: ClassDescriptor): Boolean = classFqNameEquals(descriptor, FqNames.throwable.toUnsafe())
        @JvmStatic
        fun isKClass(descriptor: ClassDescriptor): Boolean = classFqNameEquals(descriptor, FqNames.kClass)
        @JvmStatic
        fun isNonPrimitiveArray(descriptor: ClassDescriptor): Boolean = classFqNameEquals(descriptor, FqNames.array)

        @JvmStatic
        fun isDeprecated(declarationDescriptor: DeclarationDescriptor): Boolean {
            if (declarationDescriptor.original.annotations.hasAnnotation(FqNames.deprecated)) return true
            if (declarationDescriptor is PropertyDescriptor) {
                val isVar = declarationDescriptor.isVar
                val getter = declarationDescriptor.getter
                val setter = declarationDescriptor.setter
                return getter != null && isDeprecated(getter) && (!isVar || setter != null && isDeprecated(setter))
            }
            return false
        }

        @JvmStatic
        fun isNotNullOrNullableFunctionSupertype(type: KotlinType): Boolean = isConstructedFromGivenClass(type, FqNames.functionSupertype)
    }
}
