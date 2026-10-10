/* Host translation of the pinned KtToken/KtSingleValueToken/KtKeywordToken/KtModifierKeywordToken declarations. */
package org.jetbrains.kotlin.lexer

import kotlin.jvm.JvmStatic
import org.jetbrains.kotlin.portable.source.IElementType

open class KtToken(debugName: String, val tokenId: Int) : IElementType(debugName) {
    @Deprecated("Use the 'KtToken(String, int)' constructor instead", level = DeprecationLevel.ERROR)
    constructor(debugName: String) : this(debugName, -1)
}

open class KtSingleValueToken(debugName: String, val value: String, tokenId: Int) : KtToken(debugName, tokenId) {
    @Deprecated("Use the 'KtSingleValueToken(String, String, int)' constructor instead", level = DeprecationLevel.ERROR)
    constructor(debugName: String, value: String) : this(debugName, value, -1)
}

open class KtKeywordToken protected constructor(debugName: String, value: String, val isSoft: Boolean, tokenId: Int) : KtSingleValueToken(debugName, value, tokenId) {
    companion object {
        @JvmStatic fun keyword(value: String, tokenId: Int): KtKeywordToken = keyword(value, value, tokenId)
        @JvmStatic fun keyword(debugName: String, value: String, tokenId: Int): KtKeywordToken = KtKeywordToken(debugName, value, false, tokenId)
        @JvmStatic fun softKeyword(value: String, tokenId: Int): KtKeywordToken = KtKeywordToken(value, value, true, tokenId)
        @Deprecated("Use 'keyword(value, tokenId)' instead", level = DeprecationLevel.ERROR)
        @JvmStatic fun keyword(value: String): KtKeywordToken = KtKeywordToken(value, value, false, -1)
        @Deprecated("Use 'keyword(debugName, value, tokenId)' instead", level = DeprecationLevel.ERROR)
        @JvmStatic fun keyword(debugName: String, value: String): KtKeywordToken = KtKeywordToken(debugName, value, false, -1)
        @Deprecated("Use 'softKeyword(value, tokenId)' instead", level = DeprecationLevel.ERROR)
        @JvmStatic fun softKeyword(value: String): KtKeywordToken = KtKeywordToken(value, value, true, -1)
    }
}

class KtModifierKeywordToken private constructor(debugName: String, value: String, isSoft: Boolean, tokenId: Int) : KtKeywordToken(debugName, value, isSoft, tokenId) {
    companion object {
        @JvmStatic fun keywordModifier(value: String, tokenId: Int): KtModifierKeywordToken = KtModifierKeywordToken(value, value, false, tokenId)
        @JvmStatic fun softKeywordModifier(value: String, tokenId: Int): KtModifierKeywordToken = KtModifierKeywordToken(value, value, true, tokenId)
        @Deprecated("Use 'keywordModifier(value, tokenId)' instead", level = DeprecationLevel.ERROR)
        @JvmStatic fun keywordModifier(value: String): KtModifierKeywordToken = KtModifierKeywordToken(value, value, false, -1)
        @Deprecated("Use 'softKeywordModifier(value, tokenId)' instead", level = DeprecationLevel.ERROR)
        @JvmStatic fun softKeywordModifier(value: String): KtModifierKeywordToken = KtModifierKeywordToken(value, value, true, -1)
    }
}
