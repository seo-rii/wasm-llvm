@file:OptIn(org.jetbrains.kotlin.config.CompilerConfiguration.Internals::class)
package org.jetbrains.kotlin.portable.metadata.probe

import org.jetbrains.kotlin.config.ApiVersion
import org.jetbrains.kotlin.config.CompilerConfiguration
import org.jetbrains.kotlin.config.LanguageVersion
import org.jetbrains.kotlin.config.LanguageVersionSettingsImpl
import org.jetbrains.kotlin.config.languageVersionSettings
import org.jetbrains.kotlin.config.metadataVersion as metadataVersionOverride
import org.jetbrains.kotlin.metadata.deserialization.BinaryVersion
import org.jetbrains.kotlin.metadata.deserialization.MetadataVersion
import org.jetbrains.kotlin.util.metadataVersion
import org.jetbrains.kotlin.util.toMetadataVersion

private class OtherBinaryVersion : BinaryVersion(99, 12, 7) {
    override fun isCompatibleWithCurrentCompilerVersion() = false
}

fun observeMetadata(): String = buildString {
    fun record(name: String, value: Any?) { append(name).append('|').append(value).append('\n') }
    val languages = LanguageVersion.entries
    record("entries", languages.size)
    for (language in languages) {
        val metadata = language.toMetadataVersion()
        record("mapping.$language", metadata.toArray().joinToString(","))
        record("repeat.$language", metadata === language.toMetadataVersion())
        record("instance.$language", metadata === MetadataVersion.INSTANCE)
        record("strict.$language", metadata.isStrictSemantics)
        record("current.$language", metadata.isCompatibleWithCurrentCompilerVersion())
    }
    for (first in languages) for (second in languages) {
        record("identity.$first.$second", first.toMetadataVersion() === second.toMetadataVersion())
    }
    val empty = CompilerConfiguration()
    record("default", empty.metadataVersion())
    record("default.identity", empty.metadataVersion() === LanguageVersion.LATEST_STABLE.toMetadataVersion())
    record("default.settings", empty.languageVersionSettings.languageVersion)
    for (language in languages) {
        val configuration = CompilerConfiguration()
        configuration.languageVersionSettings = LanguageVersionSettingsImpl(language, ApiVersion.LATEST_STABLE)
        record("configured.$language", configuration.metadataVersion())
        record("configured.identity.$language", configuration.metadataVersion() === language.toMetadataVersion())
        for (explicit in languages) record("explicit.$language.$explicit", configuration.metadataVersion(explicit) === explicit.toMetadataVersion())
        for (entry in listOf(MetadataVersion.INVALID_VERSION, MetadataVersion.INSTANCE, MetadataVersion(0, 0, 0),
            MetadataVersion(19, 8, 3), MetadataVersion(intArrayOf(2, 6, 1), true)).withIndex()) {
            val index = entry.index
            val override = entry.value
            configuration.metadataVersionOverride = override
            record("override.$language.$index", configuration.metadataVersion() === override)
            record("override.strict.$language.$index", configuration.metadataVersion().isStrictSemantics)
            record("override.explicit.$language.$index", configuration.metadataVersion(LanguageVersion.KOTLIN_1_0) === override)
            val copy = configuration.copy()
            record("override.copy.$language.$index", copy.metadataVersion() === override)
        }
        configuration.metadataVersionOverride = OtherBinaryVersion()
        record("foreign.$language", configuration.metadataVersion() === language.toMetadataVersion())
        record("foreign.explicit.$language", configuration.metadataVersion(LanguageVersion.KOTLIN_1_0) === LanguageVersion.KOTLIN_1_0.toMetadataVersion())
        try { configuration.metadataVersionOverride = null; record("null.$language", "allowed") }
        catch (error: IllegalArgumentException) { record("null.$language", error.message) }
    }
}
