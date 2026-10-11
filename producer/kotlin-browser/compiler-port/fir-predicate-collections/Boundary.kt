package org.jetbrains.kotlin.portable.predicate.boundary

// Proof-only data and callback boundaries. None of these definitions ship in the compiler package.
typealias AnnotationFqn = String
typealias PersistentList<T> = List<T>
annotation class NoMutableState
annotation class FirExtensionApiInternals
class FirSession(val kind: Kind = Kind.Source) {
    enum class Kind { Source, Library }
    val registeredPluginAnnotations = RegisteredAnnotations()
    var lookupTracker: Tracker? = Tracker()
    lateinit var predicateBasedProvider: FirPredicateBasedProvider
}
class RegisteredAnnotations { val annotations = linkedSetOf<String>() }
class Tracker { val dirty = mutableListOf<String>(); fun recordDirtyDeclaration(symbol: FirBasedSymbol<*>) { dirty += symbol.id } }
class ModuleData(val session: FirSession)
sealed class FirDeclarationOrigin {
    data object Source : FirDeclarationOrigin()
    data object Library : FirDeclarationOrigin()
    class Java : FirDeclarationOrigin()
}
open class FirDeclaration(val id: String, session: FirSession, val annotations: MutableList<FirAnnotation> = mutableListOf(),
                          val origin: FirDeclarationOrigin = FirDeclarationOrigin.Source) {
    val moduleData = ModuleData(session)
    val symbol: FirBasedSymbol<FirDeclaration> = FirBasedSymbol(id, this)
}
class FirFile(id: String, session: FirSession) : FirDeclaration(id, session)
open class FirClass(id: String, session: FirSession, val isLocal: Boolean,
                    annotations: MutableList<FirAnnotation>, origin: FirDeclarationOrigin = FirDeclarationOrigin.Source) :
    FirDeclaration(id, session, annotations, origin)
open class FirBasedSymbol<D>(val id: String, val fir: D) {
    var resolveCount = 0
    val resolvedCompilerAnnotationsWithClassIds: List<FirAnnotation> get() = when (this) {
        is FirRegularClassSymbol -> compilerAnnotations
        else -> emptyList()
    }
}
class FirRegularClassSymbol(id: String) : FirBasedSymbol<Unit>(id, Unit) {
    val classId = ClassId(id)
    val compilerAnnotations = mutableListOf<FirAnnotation>()
}
class ClassId(private val name: String) { fun asSingleFqName(): String = name }
enum class FirResolvePhase { COMPILER_REQUIRED_ANNOTATIONS }
fun FirBasedSymbol<*>.lazyResolveToPhase(phase: FirResolvePhase) { resolveCount += 1 }
class ConeKotlinType(val symbol: FirBasedSymbol<*>?)
class AnnotationTypeRef(val type: Any?)
class FirAnnotation(val name: String?, val annotationTypeRef: AnnotationTypeRef = AnnotationTypeRef(null))
fun FirAnnotation.fqName(session: FirSession): String? = name
fun ConeKotlinType.toSymbol(session: FirSession): FirBasedSymbol<*>? = symbol
inline fun <reified T> AnnotationTypeRef.coneTypeSafe(): T? = type as? T

abstract class FirPredicateBasedProvider {
    abstract fun getSymbolsByPredicate(predicate: org.jetbrains.kotlin.portable.predicate.boundary.predicate.LookupPredicate): List<FirBasedSymbol<*>>
    abstract fun getOwnersOfDeclaration(declaration: FirDeclaration): List<FirBasedSymbol<*>>?
    abstract fun fileHasPluginAnnotations(file: FirFile): Boolean
    abstract fun matches(predicate: org.jetbrains.kotlin.portable.predicate.boundary.predicate.AbstractPredicate<*>, declaration: FirDeclaration): Boolean
    open fun registerAnnotatedDeclaration(declaration: FirDeclaration, owners: PersistentList<FirDeclaration>) {}
}
