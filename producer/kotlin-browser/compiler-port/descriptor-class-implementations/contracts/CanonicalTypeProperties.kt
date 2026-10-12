// Typed property aliases for genuine type and receiver contract methods.
package org.jetbrains.kotlin.portable.descriptors

val org.jetbrains.kotlin.resolve.ExternalOverridabilityCondition.contract: org.jetbrains.kotlin.resolve.ExternalOverridabilityCondition.Contract get() = getContract()
val org.jetbrains.kotlin.resolve.scopes.receivers.ReceiverValue.type: org.jetbrains.kotlin.types.KotlinType get() = getType()
val org.jetbrains.kotlin.resolve.scopes.receivers.ReceiverValue.original: org.jetbrains.kotlin.resolve.scopes.receivers.ReceiverValue get() = getOriginal()
val org.jetbrains.kotlin.types.TypeConstructor.parameters: List<org.jetbrains.kotlin.descriptors.TypeParameterDescriptor> get() = getParameters()
val org.jetbrains.kotlin.types.TypeConstructor.supertypes: Collection<org.jetbrains.kotlin.types.KotlinType> get() = getSupertypes()
val org.jetbrains.kotlin.types.TypeConstructor.isFinal: Boolean get() = isFinal()
val org.jetbrains.kotlin.types.TypeConstructor.isDenotable: Boolean get() = isDenotable()
val org.jetbrains.kotlin.types.TypeConstructor.declarationDescriptor: org.jetbrains.kotlin.descriptors.ClassifierDescriptor? get() = getDeclarationDescriptor()
val org.jetbrains.kotlin.types.TypeConstructor.builtIns: org.jetbrains.kotlin.builtins.KotlinBuiltIns get() = getBuiltIns()
val org.jetbrains.kotlin.types.TypeProjection.projectionKind: org.jetbrains.kotlin.types.Variance get() = getProjectionKind()
val org.jetbrains.kotlin.types.TypeProjection.type: org.jetbrains.kotlin.types.KotlinType get() = getType()
val org.jetbrains.kotlin.types.TypeProjection.isStarProjection: Boolean get() = isStarProjection()
