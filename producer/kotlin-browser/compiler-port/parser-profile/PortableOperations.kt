package org.jetbrains.kotlin.portable.parserprofile.probe

import org.jetbrains.kotlin.fir.lightTree.converter.unquoteParserIdentifier

internal fun unquoteForProbe(value: String): String = unquoteParserIdentifier(value)
