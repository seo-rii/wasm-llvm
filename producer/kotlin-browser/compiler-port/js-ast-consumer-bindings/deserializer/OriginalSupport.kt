package org.jetbrains.kotlin.js.deserializerprobe
import org.jetbrains.kotlin.js.backend.ast.*
fun directCommentFactory(values: Array<JsComment>): List<JsComment> = values.toList()
fun attachCommentFactory(node: JsNode, values: Array<JsComment>) { node.setCommentsBeforeNode(values.toList()) }
