/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.asJavaMutableList
import org.jetbrains.kotlin.js.util.asJavaMutableMap

// Java synthetic properties remain separate from explicit source methods.
// Readonly Java-list values keep their actual node getter identity; this view
// exposes their Java mutation boundary without an early common mutable cast.
val HasArguments.arguments: MutableList<JsExpression>
    get() = getArguments()

var HasName.name: JsName?
    get() = getName()
    set(value) { setName(value) }

var JsArrayAccess.arrayExpression: JsExpression?
    get() = getArrayExpression()
    set(value) { setArrayExpression(value) }

var JsArrayAccess.indexExpression: JsExpression?
    get() = getIndexExpression()
    set(value) { setIndexExpression(value) }

val JsArrayLiteral.expressions: MutableList<JsExpression>
    get() = asJavaMutableList(getExpressions())

var JsBinaryOperation.arg1: JsExpression?
    get() = getArg1()
    set(value) { setArg1(value) }

var JsBinaryOperation.arg2: JsExpression?
    get() = getArg2()
    set(value) { setArg2(value) }

val JsBinaryOperation.operator: JsBinaryOperator
    get() = getOperator()

val JsBinaryOperator.precedence: Int
    get() = getPrecedence()

val JsBinaryOperator.symbol: String
    get() = getSymbol()

val JsBinaryOperator.isAssignment: Boolean
    get() = isAssignment()

val JsBinaryOperator.isKeyword: Boolean
    get() = isKeyword()

val JsBinaryOperator.isLeftAssociative: Boolean
    get() = isLeftAssociative()

val JsBlock.statements: MutableList<JsStatement>
    get() = asJavaMutableList(getStatements())

var JsBlock.closingBraceSource: JsLocationWithSource?
    get() = getClosingBraceSource()
    set(value) { setClosingBraceSource(value) }

val JsBlock.isEmpty: Boolean
    get() = isEmpty()

val JsBlock.isTransparent: Boolean
    get() = isTransparent()

val JsBooleanLiteral.value: Boolean
    get() = getValue()

var JsCase.caseExpression: JsExpression?
    get() = getCaseExpression()
    set(value) { setCaseExpression(value) }

var JsCatch.body: JsBlock?
    get() = getBody()
    set(value) { setBody(value) }

val JsCatch.parameter: JsParameter
    get() = getParameter()

val JsCatch.scope: JsScope?
    get() = getScope()

var JsConditional.elseExpression: JsExpression?
    get() = getElseExpression()
    set(value) { setElseExpression(value) }

var JsConditional.testExpression: JsExpression?
    get() = getTestExpression()
    set(value) { setTestExpression(value) }

var JsConditional.thenExpression: JsExpression?
    get() = getThenExpression()
    set(value) { setThenExpression(value) }

val JsContinue.label: JsNameRef?
    get() = getLabel()

val JsDocComment.tags: MutableMap<String, Any?>
    get() = asJavaMutableMap(getTags())

val JsExpression.isLeaf: Boolean
    get() = isLeaf()

val JsExpressionStatement.expression: JsExpression
    get() = getExpression()

var JsExpressionStatement.source: JsLocationWithSource?
    get() = getSource()
    set(value) { setSource(value) }

var JsFor.body: JsStatement?
    get() = getBody()
    set(value) { setBody(value) }

val JsFor.condition: JsExpression?
    get() = getCondition()

val JsFor.incrementExpression: JsExpression?
    get() = getIncrementExpression()

val JsFor.initExpression: JsExpression?
    get() = getInitExpression()

val JsFor.initVars: JsVars?
    get() = getInitVars()

var JsFunction.body: JsBlock?
    get() = getBody()
    set(value) { setBody(value!!) }

var JsFunction.name: JsName?
    get() = getName()
    set(value) { setName(value) }

var JsFunction.computedName: JsExpression?
    get() = getComputedName()
    set(value) { setComputedName(value) }

val JsFunction.parameters: MutableList<JsParameter>
    get() = getParameters()

val JsFunction.scope: JsFunctionScope
    get() = getScope()

val JsFunction.isStatic: Boolean
    get() = isStatic()

val JsFunction.isGetter: Boolean
    get() = isGetter()

val JsFunction.isSetter: Boolean
    get() = isSetter()

val JsFunction.isGenerator: Boolean
    get() = isGenerator()

val JsFunction.modifiers: MutableSet<JsFunction.Modifier>
    get() = getModifiers()

var JsFunction.isEs6Arrow: Boolean
    get() = isEs6Arrow()
    set(value) { setEs6Arrow(value) }

var JsIf.elseStatement: JsStatement?
    get() = getElseStatement()
    set(value) { setElseStatement(value) }

var JsIf.ifExpression: JsExpression
    get() = getIfExpression()
    set(value) { setIfExpression(value) }

var JsIf.thenStatement: JsStatement
    get() = getThenStatement()
    set(value) { setThenStatement(value) }

val JsInvocation.arguments: MutableList<JsExpression>
    get() = getArguments()

var JsInvocation.qualifier: JsExpression
    get() = getQualifier()
    set(value) { setQualifier(value) }

var JsLabel.name: JsName?
    get() = getName()
    set(value) { setName(value) }

var JsLabel.statement: JsStatement?
    get() = getStatement()
    set(value) { setStatement(value) }

val JsLiteral.isLeaf: Boolean
    get() = isLeaf()

val JsName.isTemporary: Boolean
    get() = isTemporary()

val JsName.ident: String
    get() = getIdent()

val JsNameRef.ident: String?
    get() = getIdent()

var JsNameRef.name: JsName?
    get() = getName()
    set(value) { setName(value) }

var JsNameRef.qualifier: JsExpression?
    get() = getQualifier()
    set(value) { setQualifier(value) }

val JsNameRef.isLeaf: Boolean
    get() = isLeaf()

var JsNew.constructorExpression: JsExpression?
    get() = getConstructorExpression()
    set(value) { setConstructorExpression(value) }

var JsNode.source: JsLocationWithSource?
    get() = getSource()
    set(value) { setSource(value) }

var JsNode.commentsBeforeNode: MutableList<JsComment>?
    get() = getCommentsBeforeNode()
    set(value) { setCommentsBeforeNode(value) }

var JsNode.commentsAfterNode: MutableList<JsComment>?
    get() = getCommentsAfterNode()
    set(value) { setCommentsAfterNode(value) }

var JsObjectLiteral.isMultiline: Boolean
    get() = isMultiline()
    set(value) { setMultiline(value) }

val JsObjectLiteral.propertyInitializers: MutableList<JsPropertyInitializer>
    get() = asJavaMutableList(getPropertyInitializers())

val JsOperator.precedence: Int
    get() = getPrecedence()

val JsOperator.symbol: String
    get() = getSymbol()

val JsOperator.isKeyword: Boolean
    get() = isKeyword()

val JsOperator.isLeftAssociative: Boolean
    get() = isLeftAssociative()

val JsProgram.globalBlock: JsCompositeBlock
    get() = getGlobalBlock()

val JsProgram.rootScope: JsRootScope
    get() = getRootScope()

val JsProgram.scope: JsObjectScope
    get() = getScope()

var JsRegExp.flags: String?
    get() = getFlags()
    set(value) { setFlags(value) }

var JsRegExp.pattern: String?
    get() = getPattern()
    set(value) { setPattern(value) }

var JsReturn.expression: JsExpression?
    get() = getExpression()
    set(value) { setExpression(value) }

val JsScope.parent: JsScope?
    get() = getParent()

val JsScope.description: String
    get() = getDescription()

val JsStringLiteral.value: String
    get() = getValue()

val JsSwitch.cases: MutableList<JsSwitchMember>
    get() = asJavaMutableList(getCases())

var JsSwitch.expression: JsExpression?
    get() = getExpression()
    set(value) { setExpression(value) }

val JsSwitchMember.statements: MutableList<JsStatement>
    get() = getStatements()

val JsThisRef.isLeaf: Boolean
    get() = isLeaf()

var JsThrow.expression: JsExpression?
    get() = getExpression()
    set(value) { setExpression(value) }

val JsTry.catches: MutableList<JsCatch>
    get() = asJavaMutableList(getCatches())

var JsTry.finallyBlock: JsBlock?
    get() = getFinallyBlock()
    set(value) { setFinallyBlock(value) }

var JsTry.tryBlock: JsBlock?
    get() = getTryBlock()
    set(value) { setTryBlock(value) }

var JsUnaryOperation.arg: JsExpression?
    get() = getArg()
    set(value) { setArg(value) }

val JsUnaryOperation.operator: JsUnaryOperator
    get() = getOperator()

val JsUnaryOperator.precedence: Int
    get() = getPrecedence()

val JsUnaryOperator.symbol: String
    get() = getSymbol()

val JsUnaryOperator.isKeyword: Boolean
    get() = isKeyword()

val JsUnaryOperator.isModifying: Boolean
    get() = isModifying()

val JsUnaryOperator.isLeftAssociative: Boolean
    get() = isLeftAssociative()

var JsWhile.body: JsStatement?
    get() = getBody()
    set(value) { setBody(value) }

var JsWhile.condition: JsExpression?
    get() = getCondition()
    set(value) { setCondition(value) }

var SourceInfoAwareJsNode.source: JsLocationWithSource?
    get() = getSource()
    set(value) { setSource(value) }

val <T : JsNode> JsContext<T>.currentNode: T? get() = getCurrentNode()

@Suppress("UNCHECKED_CAST")
fun JsContext<*>.replaceMe(node: JsNode?) {
    (this as JsContext<JsNode>).replaceMe(node)
}

@Suppress("UNCHECKED_CAST")
fun JsContext<*>.addPrevious(node: JsNode) {
    (this as JsContext<JsNode>).addPrevious(node)
}
