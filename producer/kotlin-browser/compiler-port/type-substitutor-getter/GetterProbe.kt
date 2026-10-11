package org.jetbrains.kotlin.portable.typegetter.probe

import org.jetbrains.kotlin.builtins.DefaultBuiltIns
import org.jetbrains.kotlin.portable.descriptors.*
import org.jetbrains.kotlin.types.*

// A real subclass observes dispatch on the complete TypeSubstitutor class.
// All types, projections, maps and substitutions are genuine compiler objects.
private class CountingSubstitutor : TypeSubstitutor(TypeSubstitution.EMPTY) {
    var calls = 0
    val failure = IllegalStateException("getter observer")
    var throws = false
    override fun isEmpty(): Boolean {
        calls++
        if (throws) throw failure
        return calls % 2 == 1
    }
}
private fun property(substitutor: TypeSubstitutor): Boolean = substitutor.isEmpty

fun main() {
    check(property(TypeSubstitutor.EMPTY))
    println("empty-constant\ttrue")
    val empty = TypeSubstitutor.create(emptyMap<TypeConstructor, TypeProjection>())
    check(property(empty))
    println("empty-map\ttrue")
    val builtIns = DefaultBuiltIns.Instance
    val parameter = builtIns.list.declaredTypeParameters.single()
    val mapped = TypeSubstitutor.create(mapOf(parameter.typeConstructor to TypeProjectionImpl(builtIns.intType)))
    check(!property(mapped))
    check(mapped.safeSubstitute(parameter.defaultType, Variance.INVARIANT) == builtIns.intType)
    println("nonempty-map-and-real-substitution\tfalse:Int")
    val changing = CountingSubstitutor()
    val first = property(changing)
    check(first && changing.calls == 1)
    val second = property(changing)
    check(!second && changing.calls == 2)
    println("virtual-exactly-once\ttrue,false:2")
    changing.throws = true
    val failure = try { property(changing); null } catch (failure: IllegalStateException) { failure }
    check(failure === changing.failure && changing.calls == 3)
    println("exception-identity\tpreserved:3")
    val original = TypeSubstitution.EMPTY
    check(TypeSubstitutor.create(original).substitution === original)
    println("existing-substitution-property\tpreserved")
}
