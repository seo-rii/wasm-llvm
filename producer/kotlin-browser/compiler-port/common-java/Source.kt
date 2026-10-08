/* Copyright 2010-2015 JetBrains s.r.o. Apache License 2.0; see source recipe. */
package org.jetbrains.kotlin.descriptors

interface SourceElement {
    fun getContainingFile(): SourceFile
    companion object {
        val NO_SOURCE: SourceElement = object : SourceElement {
            override fun toString(): String = "NO_SOURCE"
            override fun getContainingFile(): SourceFile = SourceFile.NO_SOURCE_FILE
        }
    }
}

interface SourceFile {
    fun getName(): String?
    companion object {
        val NO_SOURCE_FILE: SourceFile = object : SourceFile {
            override fun getName(): String? = null
        }
    }
}
