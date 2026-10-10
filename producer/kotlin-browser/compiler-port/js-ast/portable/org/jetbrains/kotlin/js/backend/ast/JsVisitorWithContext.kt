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

abstract class JsVisitorWithContext {
    @Suppress("UNCHECKED_CAST")
    fun <T : JsNode?> accept(node: T): T = if (node == null) node else doAccept(node) as T
    open fun acceptLvalue(expr: JsExpression?): JsExpression? = if (expr == null) null else doAcceptLvalue(expr)
    fun <T : JsNode> acceptList(collection: List<T>) { doAcceptList(collection) }
    @Suppress("UNCHECKED_CAST")
    fun <T : JsStatement?> acceptStatement(statement: T): T = if (statement == null) statement else doAcceptStatement(statement) as T
    fun acceptStatementList(statements: List<JsStatement>) { doAcceptStatementList(statements) }

    open fun endVisit(x: JsExpression, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsArrayAccess, ctx: JsContext<*>) { endVisit(x as JsExpression, ctx) }
    open fun endVisit(x: JsArrayLiteral, ctx: JsContext<*>) { endVisit(x as JsExpression, ctx) }
    open fun endVisit(x: JsBinaryOperation, ctx: JsContext<*>) { endVisit(x as JsExpression, ctx) }
    open fun endVisit(x: JsAssignmentOperation, ctx: JsContext<*>) { endVisit(x as JsExpression, ctx) }
    open fun endVisit(x: JsAssignmentOperation.Simple, ctx: JsContext<*>) { endVisit(x as JsAssignmentOperation, ctx) }
    open fun endVisit(x: JsAssignmentOperation.Destructuring, ctx: JsContext<*>) { endVisit(x as JsAssignmentOperation, ctx) }
    open fun endVisit(x: JsBlock, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsBooleanLiteral, ctx: JsContext<*>) { endVisit(x as JsExpression, ctx) }
    open fun endVisit(x: JsBreak, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsCase, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsCatch, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsClass, ctx: JsContext<*>) { endVisit(x as JsExpression, ctx) }
    open fun endVisit(x: JsConditional, ctx: JsContext<*>) { endVisit(x as JsExpression, ctx) }
    open fun endVisit(x: JsContinue, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsYield, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsYieldStar, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsDebugger, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsDefault, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsDoWhile, ctx: JsContext<*>) { endVisit(x as JsLoop, ctx) }
    open fun endVisit(x: JsEmpty, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsExpressionStatement, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsFor, ctx: JsContext<*>) { endVisit(x as JsLoop, ctx) }
    open fun endVisit(x: JsForIn, ctx: JsContext<*>) { endVisit(x as JsLoop, ctx) }
    open fun endVisit(x: JsForOf, ctx: JsContext<*>) { endVisit(x as JsLoop, ctx) }
    open fun endVisit(x: JsFunction, ctx: JsContext<*>) { endVisit(x as JsExpression, ctx) }
    open fun endVisit(x: JsIf, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsInvocation, ctx: JsContext<*>) { endVisit(x as JsExpression, ctx) }
    open fun endVisit(x: JsLabel, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsLoop, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsName, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsNameRef, ctx: JsContext<*>) { endVisit(x as JsExpression, ctx) }
    open fun endVisit(x: JsNew, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsNullLiteral, ctx: JsContext<*>) { endVisit(x as JsExpression, ctx) }
    open fun endVisit(x: JsNumberLiteral, ctx: JsContext<*>) { endVisit(x as JsExpression, ctx) }
    open fun endVisit(x: JsObjectLiteral, ctx: JsContext<*>) { endVisit(x as JsExpression, ctx) }
    open fun endVisit(x: JsParameter, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsPostfixOperation, ctx: JsContext<*>) { endVisit(x as JsExpression, ctx) }
    open fun endVisit(x: JsPrefixOperation, ctx: JsContext<*>) { endVisit(x as JsExpression, ctx) }
    open fun endVisit(x: JsProgram, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsPropertyInitializer, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsPropertyInitializer.KeyValue, ctx: JsContext<*>) { endVisit(x as JsPropertyInitializer, ctx) }
    open fun endVisit(x: JsPropertyInitializer.Spread, ctx: JsContext<*>) { endVisit(x as JsPropertyInitializer, ctx) }
    open fun endVisit(x: JsRegExp, ctx: JsContext<*>) { endVisit(x as JsExpression, ctx) }
    open fun endVisit(x: JsReturn, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsStringLiteral, ctx: JsContext<*>) { endVisit(x as JsExpression, ctx) }
    open fun endVisit(x: JsSwitch, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsThisRef, ctx: JsContext<*>) { endVisit(x as JsExpression, ctx) }
    open fun endVisit(x: JsSuperRef, ctx: JsContext<*>) { endVisit(x as JsExpression, ctx) }
    open fun endVisit(x: JsThrow, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsTry, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsVars.JsVar, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsVars, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsSingleLineComment, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsMultiLineComment, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsExport, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsImport, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsSpread, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsWhile, ctx: JsContext<*>) { endVisit(x as JsLoop, ctx) }
    open fun endVisit(x: JsDeclarable, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsDeclarable.Named, ctx: JsContext<*>) { endVisit(x as JsDeclarable, ctx) }
    open fun endVisit(x: JsDeclarable.ArrayPattern, ctx: JsContext<*>) { endVisit(x as JsDeclarable, ctx) }
    open fun endVisit(x: JsDeclarable.ObjectPattern, ctx: JsContext<*>) { endVisit(x as JsDeclarable, ctx) }
    open fun endVisit(x: JsBindingProperty, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsBindingElement, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsBindingArrayItem, ctx: JsContext<*>) {  }
    open fun endVisit(x: JsBindingArrayItem.Element, ctx: JsContext<*>) { endVisit(x as JsBindingArrayItem, ctx) }
    open fun endVisit(x: JsBindingArrayItem.Hole, ctx: JsContext<*>) { endVisit(x as JsBindingArrayItem, ctx) }
    open fun visit(x: JsArrayAccess, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsArrayLiteral, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsBinaryOperation, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsAssignmentOperation, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsAssignmentOperation.Simple, ctx: JsContext<*>): Boolean = visit(x as JsAssignmentOperation, ctx)
    open fun visit(x: JsAssignmentOperation.Destructuring, ctx: JsContext<*>): Boolean = visit(x as JsAssignmentOperation, ctx)
    open fun visit(x: JsBlock, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsBooleanLiteral, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsBreak, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsCase, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsCatch, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsClass, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsConditional, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsContinue, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsYield, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsYieldStar, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsDebugger, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsDefault, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsDoWhile, ctx: JsContext<*>): Boolean = visit(x as JsLoop, ctx)
    open fun visit(x: JsEmpty, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsExpressionStatement, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsFor, ctx: JsContext<*>): Boolean = visit(x as JsLoop, ctx)
    open fun visit(x: JsForIn, ctx: JsContext<*>): Boolean = visit(x as JsLoop, ctx)
    open fun visit(x: JsForOf, ctx: JsContext<*>): Boolean = visit(x as JsLoop, ctx)
    open fun visit(x: JsFunction, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsIf, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsInvocation, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsLabel, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsLoop, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsName, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsNameRef, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsNew, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsNullLiteral, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsNumberLiteral, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsBigIntLiteral, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsObjectLiteral, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsParameter, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsPostfixOperation, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsPrefixOperation, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsProgram, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsPropertyInitializer, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsPropertyInitializer.KeyValue, ctx: JsContext<*>): Boolean = visit(x as JsPropertyInitializer, ctx)
    open fun visit(x: JsPropertyInitializer.Spread, ctx: JsContext<*>): Boolean = visit(x as JsPropertyInitializer, ctx)
    open fun visit(x: JsRegExp, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsReturn, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsStringLiteral, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsTemplateStringLiteral, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsTemplateStringLiteral.Segment.StringLiteral, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsTemplateStringLiteral.Segment.Interpolation, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsSwitch, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsThisRef, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsSuperRef, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsThrow, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsTry, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsVars.JsVar, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsVars, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsWhile, ctx: JsContext<*>): Boolean = visit(x as JsLoop, ctx)
    open fun visit(x: JsSingleLineComment, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsMultiLineComment, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsExport, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsImport, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsSpread, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsDeclarable, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsDeclarable.Named, ctx: JsContext<*>): Boolean = visit(x as JsDeclarable, ctx)
    open fun visit(x: JsDeclarable.ArrayPattern, ctx: JsContext<*>): Boolean = visit(x as JsDeclarable, ctx)
    open fun visit(x: JsDeclarable.ObjectPattern, ctx: JsContext<*>): Boolean = visit(x as JsDeclarable, ctx)
    open fun visit(x: JsBindingProperty, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsBindingElement, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsBindingArrayItem, ctx: JsContext<*>): Boolean = true
    open fun visit(x: JsBindingArrayItem.Element, ctx: JsContext<*>): Boolean = visit(x as JsBindingArrayItem, ctx)
    open fun visit(x: JsBindingArrayItem.Hole, ctx: JsContext<*>): Boolean = visit(x as JsBindingArrayItem, ctx)

    protected abstract fun <T : JsNode> doAccept(node: T): T
    protected abstract fun doAcceptLvalue(expr: JsExpression): JsExpression
    protected abstract fun <T : JsNode> doAcceptList(collection: List<T>)
    protected abstract fun <T : JsStatement> doAcceptStatement(statement: T): JsStatement
    protected abstract fun doAcceptStatementList(statements: List<JsStatement>)
    protected abstract fun <T : JsNode> doTraverse(node: T, ctx: JsContext<*>)
}
