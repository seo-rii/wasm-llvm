@file:OptIn(org.jetbrains.kotlin.fir.PrivateSessionConstructor::class)
package org.jetbrains.kotlin.portable.towermap.probe

import org.jetbrains.kotlin.fir.FirSession
import org.jetbrains.kotlin.fir.declarations.FirTowerDataContext
import org.jetbrains.kotlin.fir.resolve.FirRegularTowerDataContexts
import org.jetbrains.kotlin.fir.scopes.impl.FirLocalScope

// A real minimal session owns genuine local scopes. No FIR resolution is invoked.
private val session = object : FirSession(FirSession.Kind.Source) {}
private val embeddedScope = FirLocalScope(session)
fun newContext(): FirTowerDataContext = FirTowerDataContext().addLocalScope(embeddedScope).also {
    check(it.localScopes.single() === embeddedScope)
    check(it.towerDataElements.single().scope === embeddedScope)
}
fun newScope(): FirLocalScope = FirLocalScope(session).also { check(it.useSiteSession === session) }

fun main(args: Array<String>) {
    check(args.size == 2)
    fun origin(type: Class<*>): String = java.io.File(type.protectionDomain.codeSource.location.toURI()).canonicalPath
    check(origin(FirRegularTowerDataContexts::class.java) == java.io.File(args[0]).canonicalPath)
    check(origin(FirTowerDataContext::class.java) == java.io.File(args[1]).canonicalPath)
    check(origin(FirLocalScope::class.java) == java.io.File(args[1]).canonicalPath)
    print(towerModeSnapshot())
    check(embeddedScope.useSiteSession === session)
    check(embeddedScope.properties.isEmpty() && embeddedScope.classLikeSymbols.isEmpty())
}
