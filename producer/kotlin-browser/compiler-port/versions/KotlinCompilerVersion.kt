/*
 * Copyright 2000-2016 JetBrains s.r.o.
 * Licensed under the Apache License, Version 2.0; see LICENSES.md.
 * Source port of the selected compiler.version class. Resource generation is
 * performed by the producer, using the pinned actual upstream token rule.
 */
package org.jetbrains.kotlin.config

open class KotlinCompilerVersion {
    companion object {
        const val VERSION_FILE_PATH: String = "/META-INF/compiler.version"
        @kotlin.jvm.JvmField
        val VERSION: String = CompilerVersionResource.firstLine
        private const val IS_PRE_RELEASE: Boolean = false
        const val TEST_IS_PRE_RELEASE_SYSTEM_PROPERTY: String = "kotlin.test.is.pre.release"

        // A JVM test system property becomes an explicit profile factory input;
        // the browser factory supplies null. No environment probing is performed.
        private var testPreReleaseOverride: String? = null

        @kotlin.jvm.JvmStatic
        fun isPreRelease(): Boolean {
            val overridden = testPreReleaseOverride
            if (overridden != null) return overridden.equals("true", ignoreCase = true)
            return IS_PRE_RELEASE
        }

        internal fun bindTestPreReleaseOverride(value: String?) {
            testPreReleaseOverride = value
        }

        @kotlin.jvm.JvmStatic
        fun getVersion(): String? = if (VERSION == "@snapshot@") null else VERSION

        init {
            if (VERSION != "@snapshot@" && !VERSION.contains('-') && IS_PRE_RELEASE) {
                error("IS_PRE_RELEASE cannot be true for a compiler without '-' in its version.\n" +
                    "Please change IS_PRE_RELEASE to false, commit and push this change to master")
            }
        }
    }
}
