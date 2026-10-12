/* Private prototype only; no shipping host lifecycle decision is implied. */
package org.jetbrains.kotlin.portable.overriding

import org.jetbrains.kotlin.resolve.ExternalOverridabilityCondition

class OverridingConditionSnapshot(
    val realmIdentity: Any,
    providers: List<ExternalOverridabilityCondition>,
    private val actualClassName: (Any) -> String,
    private val actualClassDescription: (Any) -> String,
) {
    // Snapshot only membership/order; the original live provider instances remain shared.
    internal val conditions: List<ExternalOverridabilityCondition> = providers.toList()
    internal fun className(value: Any): String = actualClassName(value)
    internal fun classDescription(value: Any): String = actualClassDescription(value)
}

object OverridingHostContext {
    private var realmIdentity: Any? = null
    private var loader: (() -> OverridingConditionSnapshot)? = null
    private var loading = false
    private var loaded: OverridingConditionSnapshot? = null
    fun installOnce(realmIdentity: Any, loader: () -> OverridingConditionSnapshot) {
        check(this.realmIdentity == null) { "Overriding provider realm is already installed; replacement is unsupported" }
        this.realmIdentity = realmIdentity
        this.loader = loader
    }
    internal fun requireSnapshot(): OverridingConditionSnapshot {
        loaded?.let { return it }
        val providerLoader = checkNotNull(loader) {
            "Explicit overriding provider realm must be installed before OverridingUtil initialization"
        }
        check(!loading) { "Recursive overriding provider initialization is unsupported" }
        loading = true
        try {
            // Run provider constructors/iteration at the original eager static-initialization boundary.
            val snapshot = providerLoader()
            check(snapshot.realmIdentity === realmIdentity) { "Overriding provider snapshot belongs to another declared realm" }
            loaded = snapshot
            return snapshot
        } finally {
            loading = false
        }
    }
}
