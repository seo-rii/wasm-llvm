package org.jetbrains.kotlin.backend.common

import org.jetbrains.kotlin.ir.util.IdSignature

/** Exact JVM binary names for every final subtype in the pinned sealed hierarchy. */
internal fun signatureIndexTypeName(signature: IdSignature): String = "org.jetbrains.kotlin.ir.util.IdSignature\$" + when (signature) {
    is IdSignature.CommonSignature -> "CommonSignature"
    is IdSignature.CompositeSignature -> "CompositeSignature"
    is IdSignature.AccessorSignature -> "AccessorSignature"
    is IdSignature.FileSignature -> "FileSignature"
    is IdSignature.LocalSignature -> "LocalSignature"
    is IdSignature.SpecialFakeOverrideSignature -> "SpecialFakeOverrideSignature"
    is IdSignature.FileLocalSignature -> "FileLocalSignature"
    is IdSignature.ScopeLocalDeclaration -> "ScopeLocalDeclaration"
    is IdSignature.LoweredDeclarationSignature -> "LoweredDeclarationSignature"
}
