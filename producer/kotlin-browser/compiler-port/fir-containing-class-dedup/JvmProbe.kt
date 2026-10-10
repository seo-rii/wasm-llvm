@file:OptIn(org.jetbrains.kotlin.fir.PrivateSessionConstructor::class,
    org.jetbrains.kotlin.fir.SessionConfiguration::class, org.jetbrains.kotlin.fir.symbols.SymbolInternals::class,
    org.jetbrains.kotlin.fir.symbols.impl.LookupTagInternals::class)
package org.jetbrains.kotlin.portable.containingclass.actual

import org.jetbrains.kotlin.descriptors.*
import org.jetbrains.kotlin.fir.*
import org.jetbrains.kotlin.fir.declarations.*
import org.jetbrains.kotlin.fir.declarations.builder.*
import org.jetbrains.kotlin.fir.declarations.impl.FirDeclarationStatusImpl
import org.jetbrains.kotlin.fir.resolve.bindSymbolToLookupTag
import org.jetbrains.kotlin.fir.resolve.getContainingClass
import org.jetbrains.kotlin.fir.scopes.FirKotlinScopeProvider
import org.jetbrains.kotlin.fir.symbols.impl.*
import org.jetbrains.kotlin.fir.types.ConeClassLikeTypeImpl
import org.jetbrains.kotlin.name.*

// Real bootstrap FIR implementation objects; no replacement compiler classes.
fun main() = print(buildString {
    repeat(128) { index ->
        val session = object : FirSession(FirSession.Kind.Source) {}
        val module = FirBinaryDependenciesModuleData(Name.special("<probe$index>"))
        module.bindSession(session)
        session.register(FirModuleData::class, module)
        val classId = ClassId.topLevel(FqName("probe.C$index"))
        val symbol = FirRegularClassSymbol(classId)
        val klass = buildRegularClass {
            moduleData = module; origin = FirDeclarationOrigin.Library
            status = FirDeclarationStatusImpl(Visibilities.Public, Modality.FINAL)
            scopeProvider = FirKotlinScopeProvider(); classKind = ClassKind.CLASS
            name = classId.shortClassName; this.symbol = symbol
        }
        val lookup = ConeClassLikeLookupTagImpl(classId)
        lookup.bindSymbolToLookupTag(session, symbol)
        val function = buildNamedFunction {
            moduleData = module; origin = FirDeclarationOrigin.Library
            status = FirDeclarationStatusImpl(Visibilities.Public, Modality.FINAL)
            isLocal = false; returnTypeRef = session.builtinTypes.unitType
            name = Name.identifier("f$index"); this.symbol = FirNamedFunctionSymbol(CallableId(FqName("probe"), name))
            dispatchReceiverType = ConeClassLikeTypeImpl(lookup, emptyArray(), false)
        }
        check(function.getContainingClass() === klass)
        append("identity:").append(index).append('\t').append(function.getContainingClass() === klass).append('\n')
        lookup.bindSymbolToLookupTag(session, null)
        append("unresolved:").append(index).append('\t').append(function.getContainingClass() == null).append('\n')
        lookup.bindSymbolToLookupTag(session, symbol)
        append("rebound:").append(index).append('\t').append(function.getContainingClass() === klass).append('\n')
        val topLevel = buildNamedFunction {
            moduleData = module; origin = FirDeclarationOrigin.Library
            status = FirDeclarationStatusImpl(Visibilities.Public, Modality.FINAL)
            isLocal = false; returnTypeRef = session.builtinTypes.unitType
            name = Name.identifier("topLevel"); this.symbol = FirNamedFunctionSymbol(CallableId(FqName("probe"), name))
        }
        append("top-level:").append(index).append('\t').append(topLevel.getContainingClass() == null).append('\n')
        val unbound = FirBinaryDependenciesModuleData(Name.special("<unbound$index>"))
        val top = buildNamedFunction {
            moduleData = unbound; origin = FirDeclarationOrigin.Library
            status = FirDeclarationStatusImpl(Visibilities.Public, Modality.FINAL)
            isLocal = false; returnTypeRef = session.builtinTypes.unitType
            name = Name.identifier("top"); this.symbol = FirNamedFunctionSymbol(CallableId(FqName("probe"), name))
        }
        append("no-tag-short-circuit:").append(index).append('\t').append(top.getContainingClass() == null).append('\n')
        val unboundMember = buildNamedFunction {
            moduleData = unbound; origin = FirDeclarationOrigin.Library
            status = FirDeclarationStatusImpl(Visibilities.Public, Modality.FINAL)
            isLocal = false; returnTypeRef = session.builtinTypes.unitType
            name = Name.identifier("unboundMember"); this.symbol = FirNamedFunctionSymbol(CallableId(FqName("probe"), name))
            dispatchReceiverType = ConeClassLikeTypeImpl(lookup, emptyArray(), false)
        }
        var failed = false
        try { unboundMember.getContainingClass() } catch (expected: IllegalStateException) { failed = true }
        check(failed); append("module-binding-required:").append(index).append('\t').append(failed).append('\n')
    }
})
