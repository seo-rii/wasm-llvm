/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.portable.tower.probe

import org.jetbrains.kotlin.fir.resolve.calls.tower.*

private class ProbeDepth(depth: Int) : TowerGroupKind.WithDepth(3, depth)

fun towerObservations(): String {
    val out = mutableListOf<String>()
    fun emit(id: String, body: () -> Any?) {
        val value = try { body().toString() } catch (e: IllegalArgumentException) { "IllegalArgumentException:" + e.message }
        out.add(id + "|" + value)
    }
    val kinds = mutableListOf<TowerGroupKind>(TowerGroupKind.Start, TowerGroupKind.QualifierOrClassifier,
        TowerGroupKind.Member, TowerGroupKind.InvokeExtensionWithImplicitReceiver, TowerGroupKind.QualifierValue, TowerGroupKind.Last)
    for (depth in listOf(-65536, -1, 0, 1, 2, 32767, 65535, 65536)) {
        kinds.addAll(listOf(TowerGroupKind.TopPrioritized(depth), TowerGroupKind.Local(depth), TowerGroupKind.Implicit(depth),
            TowerGroupKind.NonLocal(depth), TowerGroupKind.ContextReceiverGroup(depth), ProbeDepth(depth)))
    }
    for (i in kinds.indices) {
        val a = kinds[i]
        for (j in kinds.indices) { val b = kinds[j]; emit("kind:$i:$j") { "${a.compareTo(b)}:${a == b}:${(a == b) == (b == a)}" } }
        emit("kind-null:$i") { a.equals(null) }
        if (a is TowerGroupKind.WithDepth) emit("depth-hash:$i") { a.hashCode() }
    }
    val groups = mutableListOf(TowerGroup.EmptyRoot, TowerGroup.EmptyRootForInvokeReceiver, TowerGroup.Start,
        TowerGroup.QualifierOrClassifier, TowerGroup.QualifierValue, TowerGroup.Member, TowerGroup.Last)
    for (depth in listOf(-65536, -1, 0, 1, 32767, 65535)) groups.addAll(listOf(TowerGroup.Local(depth),
        TowerGroup.Implicit(depth), TowerGroup.NonLocal(depth), TowerGroup.ContextReceiverGroup(depth), TowerGroup.TopPrioritized(depth)))
    for (root in listOf(TowerGroup.Start, TowerGroup.Member, TowerGroup.Implicit(0))) {
        groups.addAll(listOf(root.Member, root.InvokeExtensionWithImplicitReceiver, root.Local(3), root.Implicit(7), root.TopPrioritized(65535)))
    }
    val receiver = TowerGroup.Local(1).InvokeResolvePriority(InvokeResolvePriority.INVOKE_RECEIVER)
    for (priority in InvokeResolvePriority.entries) {
        groups.add(TowerGroup.Member.InvokeResolvePriority(priority))
        if (priority == InvokeResolvePriority.COMMON_INVOKE || priority == InvokeResolvePriority.INVOKE_EXTENSION) {
            groups.add(TowerGroup.Local(0).InvokeReceiver(receiver, priority))
            groups.add(TowerGroup.Implicit(2).InvokeReceiver(receiver, priority))
            groups.add(TowerGroup.Local(0).InvokeReceiver(TowerGroup.Implicit(3).InvokeResolvePriority(InvokeResolvePriority.INVOKE_RECEIVER), priority))
        }
    }
    for (i in groups.indices) {
        val a = groups[i]
        emit("text:$i") { a.toString() }
        emit("hash-stable:$i") { a.hashCode() == a.hashCode() }
        emit("group-null:$i") { a.equals(null) }
        emit("group-wrong:$i") { a.equals("TowerGroup") }
        for (j in groups.indices) { val b = groups[j]; emit("group:$i:$j") { "${a.compareTo(b)}:${a == b}:${(a == b) == (b == a)}" } }
    }
    for (depth in listOf(65536, Int.MAX_VALUE)) emit("overflow-depth:$depth") { TowerGroup.Local(depth) }
    emit("overflow-bits-depth") { TowerGroup.Implicit(0).Local(0).Implicit(0) }
    emit("overflow-bits-kind") {
        var group = TowerGroup.Start
        repeat(15) { group = group.Member }
        group
    }
    for (priority in InvokeResolvePriority.entries) emit("receiver-priority:$priority") { TowerGroup.Start.InvokeReceiver(receiver, priority) }
    emit("receiver-wrong-kind") { TowerGroup.Start.InvokeReceiver(TowerGroup.Local(1), InvokeResolvePriority.COMMON_INVOKE) }
    val nested = TowerGroup.Start.InvokeReceiver(receiver, InvokeResolvePriority.COMMON_INVOKE).InvokeResolvePriority(InvokeResolvePriority.INVOKE_RECEIVER)
    emit("receiver-priority-reset") { TowerGroup.Start.InvokeReceiver(nested, InvokeResolvePriority.COMMON_INVOKE) }
    val arrays: List<Array<TowerGroupKind>> = listOf(emptyArray(), arrayOf(TowerGroupKind.Start), arrayOf(TowerGroupKind.Member),
        arrayOf(TowerGroupKind.Start, TowerGroupKind.Member), arrayOf(TowerGroupKind.Local(1)), arrayOf(TowerGroupKind.Local(65535)))
    for (i in arrays.indices) for (j in arrays.indices) emit("debug-kind:$i:$j") { TowerGroup.DEBUG_KINDS_COMPARATOR.compare(arrays[i], arrays[j]) }
    return out.joinToString("\n", postfix = "\n")
}
