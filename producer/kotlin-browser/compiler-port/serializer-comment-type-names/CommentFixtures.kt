/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.commentprobe

import org.jetbrains.kotlin.js.backend.ast.*

class CommentState(val body:String,val failRead:Boolean) {
    val textEvents=ArrayList<String>()
    fun read():String {
        textEvents.add("getText")
        if(failRead)throw IllegalArgumentException("comment text Ω")
        return body
    }
}
/** A legitimate external implementation of the genuine open comment protocol. */
open class ExternalComment(val state:CommentState) : SourceInfoAwareJsNode(),JsComment {
    override val text:String get()=state.read()
    override fun accept(visitor:JsVisitor) {visitor.visitProgram(JsProgram())}
    override fun traverse(visitor:JsVisitorWithContext,context:JsContext<*>) {}
    override fun deepCopy():JsStatement=this
}
class GenericComment<T>(state:CommentState):ExternalComment(state)
class ΩComment(state:CommentState):ExternalComment(state)
class CommentContainer {
    class Nested(state:CommentState):ExternalComment(state)
    inner class Inner(state:CommentState):ExternalComment(state)
}
fun customComment(kind:Int,state:CommentState):JsComment {
    class LocalComment:ExternalComment(state)
    return when(kind) {
        0->ExternalComment(state)
        1->GenericComment<String>(state)
        2->CommentContainer.Nested(state)
        3->CommentContainer().Inner(state)
        4->ΩComment(state)
        5->LocalComment()
        6->object:ExternalComment(state){}
        else->throw IllegalArgumentException("unknown fixture $kind")
    }
}
