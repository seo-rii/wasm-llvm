/* Probe-only typed settings; this does not implement compiler language feature resolution. */
package org.jetbrains.kotlin.portable.metadata.boundary

import org.jetbrains.kotlin.portable.metadata.reference.config.LanguageVersion

class ApiVersion private constructor() { companion object { val LATEST_STABLE = ApiVersion() } }
class LanguageVersionSettingsImpl(val languageVersion: LanguageVersion, @Suppress("UNUSED_PARAMETER") apiVersion: ApiVersion) {
    companion object { val DEFAULT = LanguageVersionSettingsImpl(LanguageVersion.LATEST_STABLE, ApiVersion.LATEST_STABLE) }
}
