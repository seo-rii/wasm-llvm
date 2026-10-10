/*
 * Copyright 2010-2026 JetBrains s.r.o. and Kotlin Programming Language contributors.
 * Use of this source code is governed by the Apache 2.0 license that can be found in the license/LICENSE.txt file.
 */

package org.jetbrains.kotlin.fir.lightTree.converter

/** Exact pure identifier algorithm from the pinned KtPsiUtil and AbstractTreeRawFirBuilder. */
internal fun unquoteParserIdentifier(quoted: String): String {
    if (quoted.indexOf('`') < 0) {
        return quoted
    }

    if (quoted.startsWith('`') && quoted.endsWith('`') && quoted.length >= 2) {
        return quoted.substring(1, quoted.length - 1)
    } else {
        return quoted
    }
}

/** Reject an incompatible parser request before touching the session or any source. */
internal fun requireMultiplatformParser(useMultiplatformParsing: Boolean) {
    require(useMultiplatformParsing) {
        "The browser compiler profile requires the official multiplatform parser"
    }
}
