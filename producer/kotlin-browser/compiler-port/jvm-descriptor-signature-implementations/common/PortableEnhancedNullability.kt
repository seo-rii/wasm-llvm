/* Two complete pinned helper declarations; adjacent JVM loader declarations remain unselected. */
package org.jetbrains.kotlin.load.java.typeEnhancement
import org.jetbrains.kotlin.K1Deprecation
import org.jetbrains.kotlin.types.KotlinType
import org.jetbrains.kotlin.types.TypeSystemCommonBackendContext
import org.jetbrains.kotlin.types.model.KotlinTypeMarker
import org.jetbrains.kotlin.types.checker.SimpleClassicTypeSystemContext
import org.jetbrains.kotlin.load.java.JvmAnnotationNames

@K1Deprecation
fun KotlinType.hasEnhancedNullability(): Boolean =
    SimpleClassicTypeSystemContext.hasEnhancedNullability(this)

fun TypeSystemCommonBackendContext.hasEnhancedNullability(type: KotlinTypeMarker): Boolean =
    type.hasAnnotation(JvmAnnotationNames.ENHANCED_NULLABILITY_ANNOTATION)
