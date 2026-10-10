/*
 * Copyright 2010-2016 JetBrains s.r.o.
 * Use of this source code is governed by the Apache 2.0 license that can be found in the license/LICENSE.txt file.
 */
package org.jetbrains.kotlin.utils

import kotlin.jvm.JvmStatic

/** Common host translation of the official DFS.java traversal and handler algorithms. */
open class DFS {
    interface NodeHandler<N, R> {
        fun beforeChildren(current: N): Boolean
        fun afterChildren(current: N)
        fun result(): R
    }

    fun interface Neighbors<N> { fun getNeighbors(current: N): Iterable<N> }
    fun interface Visited<N> { fun checkAndMarkVisited(current: N): Boolean }

    abstract class AbstractNodeHandler<N, R> : NodeHandler<N, R> {
        override fun beforeChildren(current: N): Boolean = true
        override fun afterChildren(current: N) {}
    }

    open class VisitedWithSet<N>(private val visited: MutableSet<N> = HashSet()) : Visited<N> {
        override fun checkAndMarkVisited(current: N): Boolean = visited.add(current)
    }

    abstract class CollectingNodeHandler<N, R, C : Iterable<R>>(protected val result: C) : AbstractNodeHandler<N, C>() {
        override fun result(): C = result
    }

    abstract class NodeHandlerWithListResult<N, R> : CollectingNodeHandler<N, R, ArrayDeque<R>>(ArrayDeque())

    open class TopologicalOrder<N> : NodeHandlerWithListResult<N, N>() {
        override fun afterChildren(current: N) { result.addFirst(current) }
    }

    companion object {
        @JvmStatic fun <N, R> dfs(nodes: Collection<N>, neighbors: Neighbors<N>, visited: Visited<N>, handler: NodeHandler<N, R>): R {
            for (node in nodes) doDfs(node, neighbors, visited, handler)
            return handler.result()
        }

        @JvmStatic fun <N, R> dfs(nodes: Collection<N>, neighbors: Neighbors<N>, handler: NodeHandler<N, R>): R =
            dfs(nodes, neighbors, VisitedWithSet(), handler)

        @JvmStatic fun <N> ifAny(nodes: Collection<N>, neighbors: Neighbors<N>, predicate: (N) -> Boolean): Boolean {
            var result = false
            return dfs(nodes, neighbors, object : AbstractNodeHandler<N, Boolean>() {
                override fun beforeChildren(current: N): Boolean {
                    if (predicate(current)) result = true
                    return !result
                }
                override fun result(): Boolean = result
            })
        }

        @JvmStatic fun <N, R> dfsFromNode(node: N, neighbors: Neighbors<N>, visited: Visited<N>, handler: NodeHandler<N, R>): R {
            doDfs(node, neighbors, visited, handler)
            return handler.result()
        }

        @JvmStatic fun <N> dfsFromNode(node: N, neighbors: Neighbors<N>, visited: Visited<N>) {
            dfsFromNode(node, neighbors, visited, object : AbstractNodeHandler<N, Any?>() {
                override fun result(): Any? = null
            })
        }

        @JvmStatic fun <N> topologicalOrder(nodes: Iterable<N>, neighbors: Neighbors<N>, visited: Visited<N>): MutableList<N> {
            val handler = TopologicalOrder<N>()
            for (node in nodes) doDfs(node, neighbors, visited, handler)
            return handler.result()
        }

        @JvmStatic fun <N> topologicalOrder(nodes: Iterable<N>, neighbors: Neighbors<N>): MutableList<N> =
            topologicalOrder(nodes, neighbors, VisitedWithSet())

        @JvmStatic fun <N> doDfs(current: N, neighbors: Neighbors<N>, visited: Visited<N>, handler: NodeHandler<N, *>) {
            if (!visited.checkAndMarkVisited(current)) return
            if (!handler.beforeChildren(current)) return
            for (neighbor in neighbors.getNeighbors(current)) doDfs(neighbor, neighbors, visited, handler)
            handler.afterChildren(current)
        }
    }
}
