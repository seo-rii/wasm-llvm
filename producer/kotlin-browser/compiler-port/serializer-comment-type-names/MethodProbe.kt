/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.commentprobe

import org.jetbrains.kotlin.js.backend.ast.*
import org.jetbrains.kotlin.js.portable.JsCommentTypeNameReporter

private fun utf16(value:String?):String=value?.map {it.code.toString(16).padStart(4,'0')}?.joinToString("") ?: "null"
private fun rawBytes(value:ByteArray):String=value.joinToString(""){(it.toInt() and 255).toString(16).padStart(2,'0')}
fun commentMethodRaw():String {
    val rows=ArrayList<String>()
    fun observe(id:String,kind:Int,body:String,failRead:Boolean,position:Int,throwReporter:Boolean) {
        val state=CommentState(body,failRead)
        val comment:JsComment=when(kind){-2->JsSingleLineComment(body);-1->JsMultiLineComment(body);else->customComment(kind,state)}
        val writer=DataWriter();val reports=ArrayList<String>()
        val boundary=CommentBoundary(JsCommentTypeNameReporter {value->
            check(value===comment)
            reports.add("receiver-identical:"+rawBytes(writer.data.toByteArray()))
            if(throwReporter)throw IllegalArgumentException("reporter Ω")
            hostCommentName(value)
        })
        var failure:Throwable?=null
        try {
            if(position<0)boundary.direct(writer,comment)
            else {
                val node=JsExpressionStatement(JsIntLiteral(7))
                if(position==0)node.setCommentsBeforeNode(mutableListOf(comment))
                else if(position==1)node.setCommentsAfterNode(mutableListOf(comment))
                else {node.setCommentsBeforeNode(mutableListOf(JsSingleLineComment("beforeΩ")));node.setCommentsAfterNode(mutableListOf(comment))}
                boundary.node(writer,node)
            }
        } catch(caught:Throwable) {failure=caught}
        val bytes=rawBytes(writer.data.toByteArray())
        rows.add("core\t$id\t"+(failure?.let{it::class.simpleName} ?: "ok")+"\t"+utf16(failure?.message)+"\t"+bytes+"\t"+state.textEvents.joinToString(","))
        if(reports.isNotEmpty())check(reports.single()=="receiver-identical:"+bytes)
        rows.add("reporter\t$id\t${reports.size}\t"+reports.joinToString("|"))
    }
    val strings=listOf("","ASCII\u0000","Ω中\uD83D\uDE00","\uD800","\uDC00","x".repeat(1025))
    for(throwReporter in listOf(false,true)) {
        val prefix=if(throwReporter)"throw:" else ""
        for(kind in -2..6)for(t in strings.indices)observe(prefix+"direct:$kind:$t",kind,strings[t],false,-1,throwReporter)
        for(kind in 0..6)observe(prefix+"text-failure:$kind",kind,"Ω",true,-1,throwReporter)
        for(position in 0..2)for(kind in -2..6)observe(prefix+"node:$position:$kind",kind,"attachedΩ\uD800",false,position,throwReporter)
    }
    return rows.joinToString("\n")+"\n"
}
