/*
 * Copyright (c) 1998, 2022, Oracle and/or its affiliates. All rights reserved.
 * Copyright (c) 1994, 2022, Oracle and/or its affiliates. All rights reserved.
 * DO NOT ALTER OR REMOVE COPYRIGHT NOTICES OR THIS FILE HEADER.
 *
 * This code is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License version 2 only, as
 * published by the Free Software Foundation.  Oracle designates this
 * particular file as subject to the "Classpath" exception as provided
 * by Oracle in the LICENSE file that accompanied this code.
 *
 * This code is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License
 * version 2 for more details (a copy is included in the LICENSE file that
 * accompanied this code).
 *
 * You should have received a copy of the GNU General Public License version
 * 2 along with this work; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin St, Fifth Floor, Boston, MA 02110-1301 USA.
 *
 * Please contact Oracle, 500 Oracle Parkway, Redwood Shores, CA 94065 USA
 * or visit www.oracle.com if you need additional information or have any
 * questions.
 */

/*
 * Component/root/relative algorithms: Copyright 2010-2018 and 2010-2020
 * JetBrains s.r.o. and Kotlin Programming Language contributors.
 * Those portions are governed by Apache-2.0; see LICENSE.Kotlin.
 * Common host adaptation: Copyright 2026 wasm-llvm contributors.
 */
package org.jetbrains.kotlin.js.portable.modules

/** The selected POSIX module-name algorithm; no cwd or filesystem is consulted. */
fun relativeModuleRequirePath(mainModuleName: String, importedModuleName: String): String {
    val parentMain = posixParent(posixFilePath(mainModuleName)) ?: return "./$importedModuleName"
    val relativePath = toRelativePosixString(posixFilePath(importedModuleName), parentMain)
    return relativePath.takeIf { it.startsWith("../") } ?: "./$relativePath"
}

// Exact selected single-string UnixFileSystem.normalize semantics.
private fun posixFilePath(value: String): String {
    val doubleSlash = value.indexOf("//")
    val offset = if (doubleSlash >= 0) doubleSlash else if (value.endsWith('/')) value.length - 1 else return value
    var n = value.length
    while (n > offset && value[n - 1] == '/') n--
    if (n == 0) return "/"
    if (n == offset) return value.substring(0, offset)
    val result = StringBuilder(n)
    if (offset > 0) result.append(value, 0, offset)
    var previous = '\u0000'
    for (i in offset until n) {
        val c = value[i]
        if (previous == '/' && c == '/') continue
        result.append(c)
        previous = c
    }
    return result.toString()
}

// File.getParent/getParentFile: the selected object is an actual single-string File.
private fun posixParent(value: String): String? {
    val prefixLength = if (value.startsWith('/')) 1 else 0
    val index = value.lastIndexOf('/')
    if (index < prefixLength) {
        if (prefixLength > 0 && value.length > prefixLength) return value.substring(0, prefixLength)
        return null
    }
    return value.substring(0, index)
}

private class PathComponents(val root: String, val segments: List<String>)

// Kotlin FilePathComponents.getRootLength, including its colon-root policy.
private fun rootLength(value: String): Int {
    var first = value.indexOf('/', 0)
    if (first == 0) {
        if (value.length > 1 && value[1] == '/') {
            first = value.indexOf('/', 2)
            if (first >= 0) {
                first = value.indexOf('/', first + 1)
                return if (first >= 0) first + 1 else value.length
            }
        }
        return 1
    }
    if (first > 0 && value[first - 1] == ':') return first + 1
    if (first == -1 && value.endsWith(':')) return value.length
    return 0
}

// Normalize components directly, as toRelativeStringOrNull does. Recombining via
// File.normalize/resolve would change some colon-root results and is not equivalent.
private fun components(value: String): PathComponents {
    val rootLength = rootLength(value)
    val subPath = value.substring(rootLength)
    val segments = ArrayList<String>()
    if (subPath.isNotEmpty()) for (file in subPath.split('/')) when (file) {
        "." -> {}
        ".." -> if (segments.isNotEmpty() && segments.last() != "..") segments.removeAt(segments.lastIndex) else segments.add(file)
        else -> segments.add(file)
    }
    return PathComponents(posixFilePath(value.substring(0, rootLength)), segments)
}

private fun toRelativePosixString(value: String, base: String): String {
    val result = toRelativePosixStringOrNull(value, base)
    return result ?: throw IllegalArgumentException("this and base files have different roots: $value and $base.")
}

// Exact Kotlin Utils.toRelativeStringOrNull: root test, shared prefix, remaining
// base '..' failure, upward components, then remaining target components.
private fun toRelativePosixStringOrNull(value: String, base: String): String? {
    val thisComponents = components(value)
    val baseComponents = components(base)
    if (thisComponents.root != baseComponents.root) return null
    val baseCount = baseComponents.segments.size
    val thisCount = thisComponents.segments.size
    var sameCount = 0
    val maxSameCount = minOf(thisCount, baseCount)
    while (sameCount < maxSameCount && thisComponents.segments[sameCount] == baseComponents.segments[sameCount]) sameCount++
    val result = StringBuilder()
    for (i in baseCount - 1 downTo sameCount) {
        if (baseComponents.segments[i] == "..") return null
        result.append("..")
        if (i != sameCount) result.append('/')
    }
    if (sameCount < thisCount) {
        if (sameCount < baseCount) result.append('/')
        thisComponents.segments.drop(sameCount).joinTo(result, "/")
    }
    return result.toString()
}
