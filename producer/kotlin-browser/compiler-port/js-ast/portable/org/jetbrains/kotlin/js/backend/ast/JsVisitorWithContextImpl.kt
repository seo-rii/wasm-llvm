/*
 * Copyright 2008 Google Inc.
 * 
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License. You may obtain a copy of the License at
 * 
 * http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software distributed under the License
 * is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
 * or implied. See the License for the specific language governing permissions and limitations under
 * the License.
 */

package org.jetbrains.kotlin.js.backend.ast

/*
 * Taken from GWT project with modifications.
 * Original:
 *  repository: https://gwt.googlesource.com/gwt
 *  revision: e32bf0a95029165d9e6ab457c7ee7ca8b07b908c
 *  file: dev/core/src/com/google/gwt/dev/js/ast/JsModVisitor.java
 */

import org.jetbrains.kotlin.utils.SmartList
import org.jetbrains.kotlin.js.util.asJavaMutableList

open class JsVisitorWithContextImpl : JsVisitorWithContext() {
    protected val statementContexts = ArrayList<JsContext<JsStatement>>()

    inner class ListContext<T : JsNode> : JsContext<T>() {
        private lateinit var nodes: MutableList<T>
        private var index = 0
        private val previous = SmartList<T>()
        private val next = SmartList<T>()
        private var removed = false
        override fun <R : T> addPrevious(node: R) { previous.add(node) }
        override fun removeMe() { removed = true }
        override fun <R : T> replaceMe(node: R?) {
            checkReplacement(nodes[index], node)
            nodes[index] = node!!
            removed = false
        }
        override fun getCurrentNode(): T? = if (!removed && index < nodes.size) nodes[index] else null
        fun traverse(original: List<T>) {
            if (previous.isNotEmpty()) throw AssertionError("addPrevious() was called before traverse()")
            if (next.isNotEmpty()) throw AssertionError("addNext() was called before traverse()")
            val nodes = asJavaMutableList(original)
            this.nodes = nodes
            index = 0
            while (index < nodes.size) {
                removed = false
                previous.clear()
                next.clear()
                doTraverse(getCurrentNode()!!, this)
                if (previous.isNotEmpty()) { nodes.addAll(index, previous); index += previous.size }
                if (removed) { nodes.removeAt(index); index-- }
                if (next.isNotEmpty()) { nodes.addAll(index + 1, next); index += next.size }
                index++
            }
            previous.clear()
            next.clear()
        }
    }

    private inner class LvalueContext : NodeContext<JsExpression>()
    private open inner class NodeContext<T : JsNode> : JsContext<T>() {
        protected var node: T? = null
        override fun removeMe() { throw UnsupportedOperationException() }
        override fun <R : T> replaceMe(node: R?) {
            checkReplacement(this.node, node)
            this.node = node
        }
        override fun getCurrentNode(): T? = node
        fun traverse(node: T): T {
            this.node = node
            doTraverse(node, this)
            return this.node!!
        }
    }

    protected override fun <T : JsNode> doAccept(node: T): T = NodeContext<T>().traverse(node)
    protected override fun doAcceptLvalue(expr: JsExpression): JsExpression = LvalueContext().traverse(expr)
    protected override fun <T : JsStatement> doAcceptStatement(statement: T): JsStatement {
        val statements = SmartList<JsStatement>(statement)
        doAcceptStatementList(statements)
        return if (statements.size == 1) statements[0] else JsBlock(statements)
    }
    protected override fun doAcceptStatementList(statements: List<JsStatement>) {
        val context = ListContext<JsStatement>()
        statementContexts.add(context)
        context.traverse(statements)
        statementContexts.removeAt(statementContexts.lastIndex)
    }
    protected override fun <T : JsNode> doAcceptList(collection: List<T>) { ListContext<T>().traverse(collection) }
    protected override fun <T : JsNode> doTraverse(node: T, ctx: JsContext<*>) { node.traverse(this, ctx) }
    companion object {
        private fun checkReplacement(original: JsNode?, replacement: JsNode?) {
            if (replacement == null) throw RuntimeException("Cannot replace with null")
        }
    }
}
