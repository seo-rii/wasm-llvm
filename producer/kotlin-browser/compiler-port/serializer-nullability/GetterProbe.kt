/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.ir.backend.js.utils.serialization

import org.jetbrains.kotlin.js.backend.ast.*

private fun expression() = JsIntLiteral(7)
private fun name() = JsName("nameΩ",false)
private fun text(value:String?):String = value?.map { it.code.toString(16).padStart(4,'0') }?.joinToString("") ?: "null"
fun getterProbeRaw():String {
    val records=mutableListOf<String>()
    fun observe(id:String,action:()->Any?) {
        var result:Any?=null;var failure:Throwable?=null
        try { result=action() } catch(caught:Throwable) { failure=caught }
        records += id+"\t"+(failure?.let{it::class.simpleName} ?: "ok")+"\t"+text(failure?.message)+"\t"+(if(failure!=null)"failed" else if(result==null)"null" else "value")
    }
    observe("throw:null"){projection0(JsThrow())};observe("throw:valid"){projection0(JsThrow(expression()))}
    observe("label:name-null"){projection1(JsLabel(null,JsBlock()))};observe("label:statement-null"){projection2(JsLabel(name()))};observe("label:valid"){projection2(JsLabel(name(),JsBlock()))}
    observe("switch:null"){projection3(JsSwitch())};observe("switch:valid"){projection3(JsSwitch(expression(),mutableListOf()))}
    observe("case:null"){projection4(JsCase())};observe("case:valid"){projection4(JsCase().apply{setCaseExpression(expression())})}
    observe("while:condition-null"){projection5(JsWhile())};observe("while:body-null"){projection6(JsWhile(expression(),null))};observe("while:valid"){projection6(JsWhile(expression(),JsBlock()))}
    observe("do:condition-null"){projection7(JsDoWhile())};observe("do:body-null"){projection8(JsDoWhile(expression(),null))};observe("do:valid"){projection8(JsDoWhile(expression(),JsBlock()))}
    observe("try:null"){projection9(JsTry())};observe("try:valid"){projection9(JsTry(JsBlock(),mutableListOf<JsCatch>(),null))}
    observe("catch:null"){projection10(JsCatch(JsDeclarable.Named(name())))};observe("catch:valid"){projection10(JsCatch(JsDeclarable.Named(name())).apply{setBody(JsBlock())})}
    observe("regexp:null"){projection11(JsRegExp())};observe("regexp:valid"){projection11(JsRegExp().apply{setPattern("aΩ")})}
    observe("binary:first-null"){projection12(JsBinaryOperation(JsBinaryOperator.ADD,null,expression()))};observe("binary:second-null"){projection13(JsBinaryOperation(JsBinaryOperator.ADD,expression(),null))};observe("binary:valid"){projection13(JsBinaryOperation(JsBinaryOperator.ADD,expression(),expression()))}
    observe("prefix:null"){projection14(JsPrefixOperation(JsUnaryOperator.NOT,null))};observe("prefix:valid"){projection14(JsPrefixOperation(JsUnaryOperator.NOT,expression()))}
    observe("postfix:null"){projection15(JsPostfixOperation(JsUnaryOperator.INC,null))};observe("postfix:valid"){projection15(JsPostfixOperation(JsUnaryOperator.INC,expression()))}
    observe("conditional:test-null"){projection16(JsConditional(null,expression(),expression()))};observe("conditional:then-null"){projection17(JsConditional(expression(),null,expression()))};observe("conditional:else-null"){projection18(JsConditional(expression(),expression(),null))};observe("conditional:valid"){projection18(JsConditional(expression(),expression(),expression()))}
    observe("array:array-null"){projection19(JsArrayAccess(null,expression()))};observe("array:index-null"){projection20(JsArrayAccess(expression(),null))};observe("array:valid"){projection20(JsArrayAccess(expression(),expression()))}
    observe("nameref:null"){projection21(JsNameRef("unused").apply{resolve(null)})};observe("nameref:valid"){projection21(JsNameRef("propertyΩ"))}
    observe("new:null"){projection22(JsNew(null,mutableListOf()))};observe("new:valid"){projection22(JsNew(expression(),mutableListOf()))}
    observe("function:body-null"){projection23(JsFunction(JsProgram().getScope(),"fixture"))}
    observe("function:computed-valid"){projection24(JsFunction(JsProgram().getScope(),JsBlock(),"fixture").apply{setComputedName(expression())})}
    observe("named:visitor"){namedProjection(JsDeclarable.Named(name()))}
    observe("metadata:null"){metadataNullProjection(null)};observe("metadata:nonnull"){metadataNullProjection("textΩ")}
    return records.joinToString("\n")+"\n"
}
