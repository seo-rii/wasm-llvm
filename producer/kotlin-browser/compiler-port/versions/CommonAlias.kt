package org.jetbrains.kotlin.portable.versions.probe
import org.jetbrains.kotlin.config.KotlinCompilerVersion
import org.jetbrains.kotlin.portable.versions.versionDigit
import org.jetbrains.kotlin.portable.versions.versionIntOrNull
import org.jetbrains.kotlin.portable.versions.versionLowercase
internal fun policyLower(text: String): String = versionLowercase(text)
internal fun policyDigit(char: Char): Int = versionDigit(char)
internal fun policyInt(text: String): Int? = versionIntOrNull(text)
internal fun setTestPreReleaseOverride(value: String?) = KotlinCompilerVersion.bindTestPreReleaseOverride(value)
