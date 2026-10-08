package org.jetbrains.kotlin.portable.parserprofile.probe

import org.jetbrains.kotlin.portable.parserprofile.reference.OriginalIdentifier

internal fun unquoteForProbe(value: String): String = OriginalIdentifier.unquoteIdentifier(value)
