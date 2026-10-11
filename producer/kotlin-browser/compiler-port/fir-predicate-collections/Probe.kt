package org.jetbrains.kotlin.portable.predicate.probe

import org.jetbrains.kotlin.portable.predicate.boundary.*
import org.jetbrains.kotlin.portable.predicate.boundary.predicate.*
import org.jetbrains.kotlin.portable.predicate.LinkedHashMultimap

fun predicateObservation(): String = buildString {
    fun record(id: String, value: Any?) { append(id).append('|').append(value).append('\n') }
    for (mode in 0..23) {
        val session = FirSession()
        session.registeredPluginAnnotations.annotations += listOf("A", "B", "C")
        val provider = FirPredicateBasedProviderImpl(session); session.predicateBasedProvider = provider
        val file = FirFile("file", session)
        val parent = FirClass("parent", session, false, mutableListOf(FirAnnotation("A"), FirAnnotation("A"), FirAnnotation("B")))
        val child = FirDeclaration("child", session, mutableListOf(FirAnnotation("C"), FirAnnotation("A"), FirAnnotation(null)))
        val sibling = FirDeclaration("sibling", session)
        val leaf = FirDeclaration("leaf", session, mutableListOf(FirAnnotation("ignored")))
        val local = FirClass("local", session, true, mutableListOf(FirAnnotation("B")))
        val library = FirDeclaration("library", session, mutableListOf(FirAnnotation("C")), FirDeclarationOrigin.Library)
        val java = FirClass("java", session, false, mutableListOf(FirAnnotation("A")), FirDeclarationOrigin.Java())
        val registrations = listOf(file to emptyList(), parent to listOf(file), child to listOf(file, parent),
            sibling to listOf(file, parent), leaf to listOf(file, parent, child))
        val ordered = if (mode % 2 == 0) registrations else registrations.drop(1).reversed() + registrations.take(1)
        for ([d, owners] in ordered) { provider.registerAnnotatedDeclaration(d, owners); if (mode % 3 == 0) provider.registerAnnotatedDeclaration(d, owners) }
        if (mode % 4 == 0) provider.registerAnnotatedDeclaration(parent, listOf(file))
        val declarations = listOf(file, parent, child, sibling, leaf, local, library, java)
        val lookup = listOf(
            LookupPredicate.AnnotatedWith(linkedSetOf("A")), LookupPredicate.AnnotatedWith(linkedSetOf("B", "A")),
            LookupPredicate.AncestorAnnotatedWith(linkedSetOf("A")), LookupPredicate.ParentAnnotatedWith(linkedSetOf("C", "A")),
            LookupPredicate.HasAnnotatedWith(linkedSetOf("C", "A")),
            LookupPredicate.Or(LookupPredicate.AnnotatedWith(setOf("B")), LookupPredicate.AncestorAnnotatedWith(setOf("A"))),
            LookupPredicate.And(LookupPredicate.AnnotatedWith(setOf("C")), LookupPredicate.ParentAnnotatedWith(setOf("B"))))
        for ([pIndex, predicate] in lookup.withIndex()) {
            record("$mode/lookup/$pIndex", provider.getSymbolsByPredicate(predicate).map { it.id }.joinToString(","))
            for (declaration in declarations) record("$mode/match/$pIndex/${declaration.id}", provider.matches(predicate, declaration))
        }
        for (d in declarations) record("$mode/owners/${d.id}", provider.getOwnersOfDeclaration(d)?.joinToString(",") { it.id })
        record("$mode/file", provider.fileHasPluginAnnotations(file)); record("$mode/dirty", session.lookupTracker!!.dirty.joinToString(","))
        // Source declarations belonging to another session delegate, while library sessions do not.
        val other = FirSession(); other.registeredPluginAnnotations.annotations += "C"
        val otherProvider = FirPredicateBasedProviderImpl(other); other.predicateBasedProvider = otherProvider
        val otherFile = FirFile("otherfile", other)
        val foreign = FirDeclaration("foreign", other, mutableListOf(FirAnnotation("C")))
        otherProvider.registerAnnotatedDeclaration(foreign, listOf(otherFile))
        record("$mode/foreign", provider.matches(LookupPredicate.AnnotatedWith(setOf("C")), foreign))
        val foreignLibrary = FirDeclaration("foreignlibrary", FirSession(FirSession.Kind.Library), mutableListOf(FirAnnotation("C")), FirDeclarationOrigin.Library)
        record("$mode/foreignlibrary", provider.matches(LookupPredicate.AnnotatedWith(setOf("C")), foreignLibrary))
        val a = FirRegularClassSymbol("Meta"); val b = FirRegularClassSymbol("Ann"); val c = FirRegularClassSymbol("Cycle")
        fun ann(symbol: FirRegularClassSymbol) = FirAnnotation(symbol.id, AnnotationTypeRef(ConeKotlinType(symbol)))
        b.compilerAnnotations += listOf(ann(c), ann(a)); c.compilerAnnotations += ann(b)
        for ([name, symbol] in listOf("direct" to a, "indirect" to b, "cycle" to c)) {
            val d = FirDeclaration("meta-$name", session, mutableListOf(ann(symbol)))
            for (include in listOf(false, true)) record("$mode/meta/$name/$include", provider.matches(DeclarationPredicate.MetaAnnotatedWith(setOf("Meta"), include), d))
            record("$mode/meta/$name/resolution", d.symbol.resolveCount)
        }
        val absent = FirDeclaration("absent", session, mutableListOf(FirAnnotation(null)))
        record("$mode/meta/null", provider.matches(DeclarationPredicate.MetaAnnotatedWith(setOf("Meta"), false), absent))
        val notClass = FirDeclaration("nonclass", session, mutableListOf(FirAnnotation("X", AnnotationTypeRef(ConeKotlinType(FirBasedSymbol("X", Unit))))))
        record("$mode/meta/nonclass", provider.matches(DeclarationPredicate.MetaAnnotatedWith(setOf("Meta"), true), notClass))
    }
    // Compare the exact common helper surface with actual Guava, including retained empty live views.
    for (mode in 0..31) {
        val map = LinkedHashMultimap.create<String?, String?>(); val view = map[null]
        record("map/$mode/empty", view.joinToString(","))
        val inputs = listOf(null, "a", "b", "a", "c", null, "b")
        for ([index, value] in inputs.withIndex()) record("map/$mode/put/$index", map.put(if ((index + mode) % 3 == 0) null else "key", value))
        record("map/$mode/all", map.putAll(null, inputs)); record("map/$mode/all-again", map.putAll(null, inputs))
        record("map/$mode/all-empty", map.putAll("empty", emptyList()))
        record("map/$mode/null", view.joinToString(",")); record("map/$mode/key", map["key"].joinToString(","))
        record("map/$mode/contains", listOf(view.size, view.contains(null), view.contains("a"), map["empty"].size).joinToString(","))
    }
}
