package org.jetbrains.kotlin.portable.versions.probe
import org.jetbrains.kotlin.config.KotlinCompilerVersion
internal fun policyLower(text: String): String = UnicodeReference.lower(text)
internal fun policyDigit(char: Char): Int = UnicodeReference.digit(char)
internal fun policyInt(text: String): Int? = text.toIntOrNull()
internal fun setTestPreReleaseOverride(value: String?) {
    if (value == null) System.clearProperty(KotlinCompilerVersion.TEST_IS_PRE_RELEASE_SYSTEM_PROPERTY)
    else System.setProperty(KotlinCompilerVersion.TEST_IS_PRE_RELEASE_SYSTEM_PROPERTY, value)
}
