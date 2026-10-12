package org.jetbrains.kotlin.portable.overriding

import org.jetbrains.kotlin.resolve.OverridingUtil.OverrideCompatibilityInfo

val OverrideCompatibilityInfo.result: OverrideCompatibilityInfo.Result get() = getResult()
val OverrideCompatibilityInfo.debugMessage: String get() = getDebugMessage()
