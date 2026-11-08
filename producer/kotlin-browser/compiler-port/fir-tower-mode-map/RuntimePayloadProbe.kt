// Only the explicit opaque boundary fixture uses these factories.
package org.jetbrains.kotlin.portable.towermap.probe
import org.jetbrains.kotlin.fir.declarations.FirTowerDataContext
import org.jetbrains.kotlin.fir.scopes.impl.FirLocalScope
fun newContext(): FirTowerDataContext = FirTowerDataContext()
fun newScope(): FirLocalScope = FirLocalScope()
