/*
 * Copyright 2010-2022 JetBrains s.r.o. and Kotlin Programming Language contributors.
 * Use of this source code is governed by the Apache 2.0 license that can be found in the license/LICENSE.txt file.
 */

@file:Suppress("FunctionName", "DuplicatedCode")

package org.jetbrains.kotlin.tooling.core

import org.jetbrains.kotlin.portable.versions.versionIntOrNull
import org.jetbrains.kotlin.portable.versions.versionLowercase

fun KotlinToolingVersion(kotlinVersionString: String): KotlinToolingVersion {
    val baseVersion = kotlinVersionString.split("-", limit = 2)[0]
    val classifier = kotlinVersionString.split("-", limit = 2).getOrNull(1)

    val baseVersionSplit = baseVersion.split(".")

    val majorVersion = baseVersionSplit[0].let { versionIntOrNull(it) }
    val minorVersion = baseVersionSplit.getOrNull(1)?.let { versionIntOrNull(it) }

    if (majorVersion == null || minorVersion == null) {
        throw IllegalArgumentException("Invalid Kotlin version: $kotlinVersionString (Failed parsing major/minor version)")
    }

    return KotlinToolingVersion(
        major = majorVersion,
        minor = minorVersion,
        patch = baseVersionSplit.getOrNull(2)?.let { versionIntOrNull(it) } ?: 0,
        classifier = classifier
    )
}

fun KotlinToolingVersion(kotlinVersion: KotlinVersion, classifier: String? = null): KotlinToolingVersion {
    return KotlinToolingVersion(kotlinVersion.major, kotlinVersion.minor, kotlinVersion.patch, classifier)
}

class KotlinToolingVersion(
    val major: Int,
    val minor: Int,
    val patch: Int,
    val classifier: String?
) : Comparable<KotlinToolingVersion> {

    enum class Maturity {
        SNAPSHOT, DEV, MILESTONE, ALPHA, BETA, RC, STABLE
    }

    val maturity: Maturity = run {
        val classifier = this.classifier?.let { versionLowercase(it) }
        when {
            classifier == null || classifier.matches(Regex("""(release-)?\d+""")) -> Maturity.STABLE
            classifier == "snapshot" -> Maturity.SNAPSHOT
            classifier.matches(Regex("""(rc)(\d*)?(-release)?(-?\d+)?""")) -> Maturity.RC
            classifier.matches(Regex("""beta(\d*)?(-release)?(-?\d+)?""")) -> Maturity.BETA
            classifier.matches(Regex("""alpha(\d*)?(-release)?(-?\d+)?""")) -> Maturity.ALPHA
            classifier.matches(Regex("""m\d+(-release)?(-\d+)?""")) -> Maturity.MILESTONE
            else -> Maturity.DEV
        }
    }

    override fun compareTo(other: KotlinToolingVersion): Int {
        if (this == other) return 0
        (this.major - other.major).takeIf { it != 0 }?.let { return it }
        (this.minor - other.minor).takeIf { it != 0 }?.let { return it }
        (this.patch - other.patch).takeIf { it != 0 }?.let { return it }
        (this.maturity.ordinal - other.maturity.ordinal).takeIf { it != 0 }?.let { return it }

        if (this.classifier == null && other.classifier != null) {
            /* eg. 1.6.20 > 1.6.20-200 */
            return 1
        }

        if (this.classifier != null && other.classifier == null) {
            /* e.g. 1.6.20-200 < 1.6.20 */
            return -1
        }

        val thisClassifierNumber = this.classifierNumber
        val otherClassifierNumber = other.classifierNumber
        if (thisClassifierNumber != null && otherClassifierNumber != null) {
            (thisClassifierNumber - otherClassifierNumber).takeIf { it != 0 }?.let { return it }
        }

        if (thisClassifierNumber != null && otherClassifierNumber == null) {
            /* e.g. 1.6.20-rc1 > 1.6.20-rc */
            return 1
        }

        if (thisClassifierNumber == null && otherClassifierNumber != null) {
            /* e.g. 1.6.20-rc < 1.6.20-rc1 */
            return -1
        }

        val thisBuildNumber = this.buildNumber
        val otherBuildNumber = other.buildNumber
        if (thisBuildNumber != null && otherBuildNumber != null) {
            (thisBuildNumber - otherBuildNumber).takeIf { it != 0 }?.let { return it }
        }

        if (thisBuildNumber == null && otherBuildNumber != null) {
            /* e.g. 1.6.20-M1 > 1.6.20-M1-200 */
            return 1
        }

        if (thisBuildNumber != null && otherBuildNumber == null) {
            /* e.g. 1.6.20-M1-200 < 1.6.20-M1 */
            return -1
        }

        return 0
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is KotlinToolingVersion) return false
        if (this.major != other.major) return false
        if (this.minor != other.minor) return false
        if (this.patch != other.patch) return false
        if (this.classifier?.let { versionLowercase(it) } != other.classifier?.let { versionLowercase(it) }) return false
        return true
    }

    override fun hashCode(): Int {
        var result = major
        result = 31 * result + minor
        result = 31 * result + patch
        result = 31 * result + (classifier?.hashCode() ?: 0)
        return result
    }

    override fun toString(): String {
        return "$major.$minor.$patch" + if (classifier != null) "-$classifier" else ""
    }
}

fun KotlinToolingVersion.toKotlinVersion(): KotlinVersion =
    KotlinVersion(major, minor, patch)

fun KotlinVersion.toKotlinToolingVersion(classifier: String? = null): KotlinToolingVersion =
    KotlinToolingVersion(this, classifier)

val KotlinToolingVersion.isSnapshot: Boolean
    get() = this.maturity == KotlinToolingVersion.Maturity.SNAPSHOT

val KotlinToolingVersion.isDev: Boolean
    get() = this.maturity == KotlinToolingVersion.Maturity.DEV

val KotlinToolingVersion.isMilestone: Boolean
    get() = this.maturity == KotlinToolingVersion.Maturity.MILESTONE

val KotlinToolingVersion.isAlpha: Boolean
    get() = this.maturity == KotlinToolingVersion.Maturity.ALPHA

val KotlinToolingVersion.isBeta: Boolean
    get() = this.maturity == KotlinToolingVersion.Maturity.BETA

val KotlinToolingVersion.isRC: Boolean
    get() = this.maturity == KotlinToolingVersion.Maturity.RC

val KotlinToolingVersion.isStable: Boolean
    get() = this.maturity == KotlinToolingVersion.Maturity.STABLE

val KotlinToolingVersion.isPreRelease: Boolean get() = !isStable

val KotlinToolingVersion.buildNumber: Int?
    get() {
        if (classifier == null) return null

        /*
        Handle classifiers that only consist of version + build number. This is used for stable releases
        like:
        1.6.20-1
        1.6.20-22
        1.6.
         */
        val buildNumberOnlyClassifierRegex = Regex("\\d+")
        if (buildNumberOnlyClassifierRegex.matches(classifier)) {
            return classifier.let { versionIntOrNull(it) }
        }

        val classifierRegex = Regex("""([^\n\r\u0085\u2028\u2029]+?)(\d*)?(-release)?-?(\d*)?""")
        val classifierMatch = classifierRegex.matchEntire(classifier) ?: return null
        return classifierMatch.groupValues.getOrNull(4)?.let { versionIntOrNull(it) }
    }

val KotlinToolingVersion.classifierNumber: Int?
    get() {
        if (classifier == null) return null

        /*
        dev builds allow additional wildcards in the version (like 1.6.20-dev-myWildcard21-510)
        In this case, 510 will be the buildNumber, but there is still no associated classifierNumber.
        In order to keep the regex below simple, we fast path out here, since we know that
        dev builds never carry classifier numbers
         */
        if (maturity == KotlinToolingVersion.Maturity.DEV) return null

        /*
        Classifiers with only a buildNumber assigned
         */
        val buildNumberOnlyClassifierRegex = Regex("\\d+")
        if (buildNumberOnlyClassifierRegex.matches(classifier)) {
            return null
        }


        val classifierRegex = Regex("""([^\n\r\u0085\u2028\u2029]+?)(\d*)?(-release)?-?(\d*)?""")
        val classifierMatch = classifierRegex.matchEntire(classifier) ?: return null
        return classifierMatch.groupValues.getOrNull(2)?.let { versionIntOrNull(it) }
    }

operator fun String.compareTo(version: KotlinToolingVersion): Int {
    return KotlinToolingVersion(this).compareTo(version)
}

operator fun KotlinToolingVersion.compareTo(kotlinVersionString: String): Int {
    return this.compareTo(KotlinToolingVersion(kotlinVersionString))
}
