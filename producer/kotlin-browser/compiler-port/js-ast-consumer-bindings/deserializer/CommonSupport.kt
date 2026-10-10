package org.jetbrains.kotlin.js.deserializerprobe
import org.jetbrains.kotlin.js.backend.ast.*
import org.jetbrains.kotlin.js.portable.jsAstCommentList
fun directCommentFactory(values: Array<JsComment>): List<JsComment> = jsAstCommentList(values)
fun attachCommentFactory(node: JsNode, values: Array<JsComment>) { node.setCommentsBeforeNode(jsAstCommentList(values)) }
