/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.astprobe

import org.jetbrains.kotlin.js.backend.ast.*
import org.jetbrains.kotlin.js.util.TextOutputImpl
import org.jetbrains.kotlin.js.util.AstUtil
import org.jetbrains.kotlin.js.common.isES5IdentifierPart
import org.jetbrains.kotlin.js.common.isES5IdentifierStart

private fun quote(value: String): String = buildString {
    append('"')
    for (c in value) when (c) {
        '"' -> append("\\\"")
        '\\' -> append("\\\\")
        else -> if (c.code < 32 || c.code >= 127) append("\\u" + c.code.toString(16).padStart(4, '0')) else append(c)
    }
    append('"')
}

// Kotlin/Wasm listOf can be backed by a mutable ArrayList. This same genuine
// AbstractList fixture supplies an explicitly readonly input on every host.
private fun <T> readonlyListOf(vararg values: T): List<T> = object : AbstractList<T>() {
    override val size: Int get() = values.size
    override fun get(index: Int): T = values[index]
}

/** Raw successful observations are compared; actual exception messages remain separate. */
fun astObservation(): String {
    val records = ArrayList<String>()
    val failures = ArrayList<String>()
    fun record(name: String, value: Any?) { records.add("$name=$value") }
    fun failure(name: String, body: () -> Unit) {
        try { body(); record(name, "NO_EXCEPTION") }
        catch (error: Throwable) {
            record(name, error::class.simpleName)
            failures.add("$name=${error::class.simpleName}:${error.message}")
        }
    }
    val program = JsProgram()
    val root = program.getRootScope()
    val scope = program.getScope()
    val name = scope.declareName("value")
    record("scope.same-name", scope.declareName("value") === name)
    record("scope.root-parent", root.getParent())
    record("scope.parent", scope.getParent() === root)
    record("scope.lookup", scope.findName("value") === name)
    record("scope.missing", scope.findName("missing"))
    record("scope.temporary", JsScope.declareTemporaryName("tmp").isTemporary())
    failure("scope.empty-temporary") { JsScope.declareTemporaryName("") }
    val child = JsFunctionScope(scope, "child")
    record("scope.parent-lookup", child.findName("value") === name)
    child.copyOwnNames(scope)
    record("scope.copied-shared-name", child.declareName("value") === name)
    record("scope.description", child.getDescription())
    record("scope.render", child.toString())

    val source = JsLocation("a.kt", 2, 3, "mapped")
    val ref = name.makeRef()
    ref.setSource(source)
    ref.setData("key", "payload")
    val comments = mutableListOf<JsComment>(JsSingleLineComment("before"))
    ref.setCommentsBeforeNode(comments)
    val refCopy = ref.deepCopy() as JsNameRef
    record("copy.name-shared", refCopy.getName() === name)
    record("copy.node-distinct", refCopy !== ref)
    record("copy.source-shared", refCopy.getSource() === source)
    record("copy.comments-shared", refCopy.getCommentsBeforeNode() === comments)
    record("copy.metadata", refCopy.getData<String>("key"))
    val boolean = JsBooleanLiteral(true)
    record("copy.boolean-identity", boolean.deepCopy() === boolean)
    val debugger = JsDebugger()
    record("copy.debugger-identity", debugger.deepCopy() === debugger)
    val continueNode = JsContinue()
    continueNode.setData("key", "continue")
    val continueCopy = continueNode.deepCopy()
    record("copy.continue-null-label-new", continueCopy !== continueNode)
    record("copy.continue-null-label-no-metadata", continueCopy.hasData("key"))
    val labeledContinue = JsContinue(name.makeRef())
    labeledContinue.setData("key", "continue")
    record("copy.continue-label-metadata", labeledContinue.deepCopy().getData<String>("key"))
    val tags = hashMapOf<String, Any>("tag" to "one")
    val doc = JsDocComment(tags)
    val docCopy = doc.deepCopy() as JsDocComment
    tags["tag"] = "two"
    record("copy.doc-tags-shared", docCopy.getTags() === tags)
    record("copy.doc-tags-live", docCopy.getTags()["tag"])
    record("copy.doc-mutable-property-alias", doc.tags === tags)
    val readonlyTags: Map<String, Any?> = object : AbstractMap<String, Any?>() {
        override val entries: Set<Map.Entry<String, Any?>> = setOf(object : Map.Entry<String, Any?> {
            override val key: String = "tag"
            override val value: Any? = null
        })
    }
    val readonlyDoc = JsDocComment(readonlyTags)
    record("copy.doc-readonly-explicit-alias", readonlyDoc.getTags() === readonlyTags)
    record("copy.doc-readonly-null-tag", readonlyDoc.getTags()["tag"])
    failure("copy.doc-readonly-mutation") { readonlyDoc.tags["tag"] = "changed" }
    var docVisits = 0
    object : JsVisitorWithContextImpl() {
        override fun endVisit(x: JsExpression, ctx: JsContext<*>) { docVisits++ }
    }.accept(doc)
    record("visitor.doc-empty-traverse", docVisits)

    val immutableExpressions = readonlyListOf<JsExpression>(JsIntLiteral(1))
    val array = JsArrayLiteral(immutableExpressions)
    record("list.array-explicit-alias", array.getExpressions() === immutableExpressions)
    record("list.array-read", array.toString())
    failure("list.array-readonly-mutation") { array.expressions.add(JsIntLiteral(2)) }
    val mutableExpressions = mutableListOf<JsExpression>(JsIntLiteral(1))
    val mutableArray = JsArrayLiteral(mutableExpressions)
    record("list.array-mutable-property-alias", mutableArray.expressions === mutableExpressions)
    mutableExpressions.add(JsIntLiteral(2))
    record("list.array-mutable-live", mutableArray.toString())
    val suppliedArguments = mutableListOf<JsExpression>(JsIntLiteral(1))
    val invocation = JsInvocation(JsNameRef("call"), suppliedArguments)
    val construction = JsNew(JsNameRef("Ctor"), suppliedArguments)
    suppliedArguments.add(JsIntLiteral(2))
    record("list.invocation-constructor-copy", invocation.getArguments().size)
    record("list.new-constructor-copy", construction.getArguments().size)
    record("list.invocation-getter-alias", invocation.getArguments() === suppliedArguments)
    invocation.getArguments().add(JsIntLiteral(3))
    construction.getArguments().add(JsIntLiteral(4))
    record("list.invocation-getter-mutation", invocation.toString())
    record("list.new-getter-mutation", construction.toString())
    val properties = mutableListOf<JsPropertyInitializer>(JsPropertyInitializer.KeyValue(JsStringLiteral("key"), JsIntLiteral(1)))
    val objectNode = JsObjectLiteral(properties)
    record("list.object-explicit-alias", objectNode.getPropertyInitializers() === properties)
    objectNode.setMultiline(true)
    record("object.copy-multiline", objectNode.deepCopy().isMultiline())
    properties.add(JsPropertyInitializer.Spread(JsNameRef("rest")))
    record("list.object-live", objectNode.toString())
    val readonlyProperties = readonlyListOf<JsPropertyInitializer>(JsPropertyInitializer.KeyValue(JsStringLiteral("key"), JsIntLiteral(1)))
    val readonlyObject = JsObjectLiteral(readonlyProperties)
    record("list.object-readonly-alias", readonlyObject.getPropertyInitializers() === readonlyProperties)
    failure("list.object-readonly-mutation") { readonlyObject.propertyInitializers.add(JsPropertyInitializer.Spread(JsNameRef("rest"))) }
    val resolved = JsNameRef("unresolved", JsNameRef("qualifier"))
    record("name.ident-before-resolve", resolved.getIdent())
    resolved.resolve(name)
    record("name.ident-after-resolve", resolved.getIdent())
    record("name.name-after-resolve", resolved.getName() === name)
    record("name.qualifier-copy-distinct", (resolved.deepCopy() as JsNameRef).getQualifier() !== resolved.getQualifier())
    resolved.setName(null)
    record("name.null-after-resolve", resolved.getName())
    failure("name.invalid-resolved-ident") { resolved.getIdent() }
    failure("name.invalid-render") { resolved.toString() }
    for (mode in listOf("resolve-null", "clear-resolved-name")) {
        val qualifier = JsNameRef("copyQualifier")
        val nullIdent = JsNameRef("beforeResolution", qualifier)
        nullIdent.setSource(source)
        nullIdent.setCommentsBeforeNode(comments)
        nullIdent.setData("key", "null-name-copy")
        if (mode == "resolve-null") nullIdent.resolve(null)
        else { nullIdent.resolve(name); nullIdent.setName(null) }
        record("name.$mode.ident", nullIdent.getIdent())
        record("name.$mode.name", nullIdent.getName())
        val copy = nullIdent.deepCopy()
        record("name.$mode.copy-distinct", copy !== nullIdent)
        record("name.$mode.copy-ident", copy.getIdent())
        record("name.$mode.copy-name", copy.getName())
        record("name.$mode.copy-qualifier-distinct", copy.getQualifier() !== qualifier)
        record("name.$mode.copy-qualifier-text", copy.getQualifier().toString())
        record("name.$mode.copy-source-shared", copy.getSource() === source)
        record("name.$mode.copy-comments-shared", copy.getCommentsBeforeNode() === comments)
        record("name.$mode.copy-metadata", copy.getData<String>("key"))
    }
    val transformedConditional = JsConditional(JsIntLiteral(1), JsIntLiteral(2), JsIntLiteral(3))
    val transformedArray = JsArrayAccess(JsNameRef("array"), JsIntLiteral(4))
    val transformedInvocation = JsInvocation(JsNameRef("fn"), listOf(JsIntLiteral(5)))
    val transformer = object : JsVisitorWithContextImpl() {
        override fun visit(x: JsNumberLiteral, ctx: JsContext<*>): Boolean {
            @Suppress("UNCHECKED_CAST") val mutable = ctx as JsContext<JsExpression>
            mutable.replaceMe(JsIntLiteral((x as JsIntLiteral).value + 10)); return false
        }
        override fun visit(x: JsNameRef, ctx: JsContext<*>): Boolean {
            @Suppress("UNCHECKED_CAST") val mutable = ctx as JsContext<JsExpression>
            mutable.replaceMe(JsNameRef(x.getIdent() + "Changed")); return false
        }
    }
    transformer.accept(transformedConditional); transformer.accept(transformedArray); transformer.accept(transformedInvocation)
    record("visitor.conditional-replace", transformedConditional.toString())
    record("visitor.array-replace", transformedArray.toString())
    record("visitor.invocation-replace", transformedInvocation.toString())
    object : JsVisitorWithContextImpl() {
        override fun visit(x: JsConditional, ctx: JsContext<*>): Boolean = false
        override fun visit(x: JsNumberLiteral, ctx: JsContext<*>): Boolean { throw IllegalStateException("Skipped children were visited") }
    }.accept(transformedConditional)
    record("visitor.false-skips-children", transformedConditional.toString())
    val immutableStatements = readonlyListOf<JsStatement>(JsReturn(JsIntLiteral(1)))
    val block = JsBlock(immutableStatements)
    record("list.block-explicit-alias", block.getStatements() === immutableStatements)
    record("list.block-read", block.toString())
    failure("list.block-readonly-mutation") { block.statements.add(JsReturn(JsIntLiteral(2))) }
    val catch = JsCatch(scope, JsDeclarable.Named(name))
    catch.setBody(JsBlock())
    val catches = readonlyListOf(catch)
    val tryNode = JsTry(JsBlock(), catches, null)
    record("list.try-explicit-alias", tryNode.getCatches() === catches)
    failure("list.try-readonly-mutation") { tryNode.catches.add(catch) }
    val copiedArray = mutableArray.deepCopy()
    record("copy.array-list-distinct", copiedArray.getExpressions() !== mutableExpressions)
    record("copy.array-child-distinct", copiedArray.getExpressions()[0] !== mutableExpressions[0])
    record("copy.array-render", copiedArray.toString())
    record("copy.null-expression", AstUtil.deepCopy(null as JsExpression?))
    record("copy.null-list-size", AstUtil.deepCopy(null as List<JsExpression>?).size)

    val expressionStatement = JsIntLiteral(3).makeStmt()
    record("statement.source-always-null", expressionStatement.getSource())
    failure("statement.source-set") { expressionStatement.setSource(source) }
    val nullArray = JsArrayAccess()
    record("null.array-expression", nullArray.getArrayExpression())
    record("null.array-index", nullArray.getIndexExpression())
    val nullConditional = JsConditional()
    record("null.conditional", listOf(nullConditional.getTestExpression(), nullConditional.getThenExpression(), nullConditional.getElseExpression()))
    val nullBinary = JsBinaryOperation(JsBinaryOperator.ASG_ADD, null, null)
    failure("null.assignment-ordinary-visitor") { nullBinary.acceptChildren(object : RecursiveJsVisitor() {}) }
    object : JsVisitorWithContextImpl() {}.accept(nullBinary)
    record("null.assignment-context", nullBinary.getArg1())
    val nullUnary = JsPrefixOperation(JsUnaryOperator.INC, null)
    failure("null.unary-ordinary-visitor") { nullUnary.acceptChildren(object : RecursiveJsVisitor() {}) }
    object : JsVisitorWithContextImpl() {}.accept(nullUnary)
    record("null.unary-context", nullUnary.getArg())
    val unsetFunction = JsFunction(scope, "unset")
    record("null.function-body", unsetFunction.getBody())
    failure("null.function-copy") { unsetFunction.deepCopy() }

    val function = JsFunction(scope, JsBlock(JsReturn(JsIntLiteral(7))), "fn")
    function.getParameters().add(JsParameter(name))
    function.getModifiers().add(JsFunction.Modifier.GENERATOR)
    function.getModifiers().add(JsFunction.Modifier.STATIC)
    function.getModifiers().add(JsFunction.Modifier.GET)
    record("function.modifier-order", function.getModifiers().joinToString { it.name })
    val iterator = function.getModifiers().iterator()
    iterator.next(); iterator.remove()
    record("function.modifier-iterator-remove", function.getModifiers().joinToString { it.name })
    function.getScope().declareName("local")
    function.setComputedName(JsStringLiteral("computed"))
    val functionCopy = function.deepCopy()
    record("function.copy-computed-name-omitted", functionCopy.getComputedName())
    record("function.copy-params-distinct", functionCopy.getParameters() !== function.getParameters())
    record("function.copy-param-name-shared", functionCopy.getParameters()[0].getName() === name)
    record("function.copy-scope-shared-name", functionCopy.getScope().findName("local") === function.getScope().findName("local"))
    record("function.copy-modifiers", functionCopy.getModifiers().joinToString { it.name })
    function.setName(name)
    failure("function.named-arrow") { function.setEs6Arrow(true) }

    for (operator in JsBinaryOperator.entries) {
        record("binary.${operator.name}.api", "${operator.getSymbol()}/${operator.getPrecedence()}/${operator.isAssignment()}/${operator.isKeyword()}")
        record("binary.${operator.name}.render", JsBinaryOperation(operator, JsNameRef("left"), JsIntLiteral(2)).toString())
    }
    for (operator in JsUnaryOperator.entries) {
        record("unary.${operator.name}.api", "${operator.getSymbol()}/${operator.getPrecedence()}/${operator.isModifying()}/${operator.isKeyword()}")
        record("unary.${operator.name}.prefix", JsPrefixOperation(operator, JsNameRef("value")).toString())
    }
    val expressions: List<JsExpression> = listOf(
        JsArrayAccess(JsNameRef("a"), JsIntLiteral(2)),
        JsConditional(JsBooleanLiteral(true), JsIntLiteral(1), JsIntLiteral(2)),
        JsDoubleLiteral(-0.0), JsDoubleLiteral(1e23), JsIntLiteral(-5),
        JsInvocation(JsNameRef("call"), listOf(JsIntLiteral(1), JsStringLiteral("x"))),
        JsNew(JsNameRef("Ctor"), listOf(JsIntLiteral(1))), JsNullLiteral(),
        JsObjectLiteral(listOf(JsPropertyInitializer.KeyValue(JsStringLiteral("key"), JsIntLiteral(1)))),
        JsPostfixOperation(JsUnaryOperator.INC, JsNameRef("x")),
        JsRegExp().apply { setPattern("[a-z]+"); setFlags("gi") }, JsStringLiteral("line\n\u2028\"'\\"), JsSuperRef(), JsThisRef(),
        JsYield(JsIntLiteral(1)), JsYieldStar(JsNameRef("items")), JsSpread(JsNameRef("items")),
        JsBigIntLiteral(Long.MIN_VALUE)
    )
    for (item in expressions.withIndex()) {
        val index = item.index
        val expression = item.value
        record("expression.$index.render", expression.toString())
        record("expression.$index.copy-render", expression.deepCopy().toString())
        record("expression.$index.leaf", expression.isLeaf())
    }

    val loopTrace = ArrayList<String>()
    val traceVisitor = object : RecursiveJsVisitor() {
        override fun visitInt(x: JsIntLiteral) { loopTrace.add("int:${x.value}") }
        override fun visitReturn(x: JsReturn) { loopTrace.add("return"); super.visitReturn(x) }
    }
    val whileNode = JsWhile(JsIntLiteral(1), JsReturn(JsIntLiteral(2)))
    whileNode.accept(traceVisitor)
    record("visitor.while-ordinary-order", loopTrace.joinToString())
    loopTrace.clear()
    val doNode = JsDoWhile(JsIntLiteral(1), JsReturn(JsIntLiteral(2)))
    doNode.accept(traceVisitor)
    record("visitor.do-ordinary-order", loopTrace.joinToString())
    loopTrace.clear()
    val contextTrace = object : JsVisitorWithContextImpl() {
        override fun visit(x: JsNumberLiteral, ctx: JsContext<*>): Boolean { loopTrace.add("int:${(x as JsIntLiteral).value}"); return true }
        override fun visit(x: JsReturn, ctx: JsContext<*>): Boolean { loopTrace.add("return"); return true }
    }
    contextTrace.accept(doNode)
    record("visitor.do-context-order", loopTrace.joinToString())
    val mutation = JsBlock(JsReturn(JsIntLiteral(1)), JsReturn(JsIntLiteral(2)), JsReturn(JsIntLiteral(3)))
    val visited = ArrayList<Int>()
    object : JsVisitorWithContextImpl() {
        override fun visit(x: JsReturn, ctx: JsContext<*>): Boolean {
            val n = (x.getExpression() as JsIntLiteral).value
            visited.add(n)
            @Suppress("UNCHECKED_CAST") val mutable = ctx as JsContext<JsStatement>
            when (n) {
                1 -> mutable.addPrevious(JsReturn(JsIntLiteral(10)))
                2 -> mutable.removeMe()
                3 -> mutable.replaceMe(JsReturn(JsIntLiteral(30)))
            }
            return false
        }
    }.accept(mutation)
    record("visitor.mutation-visits", visited.joinToString())
    record("visitor.mutation-result", mutation.toString())
    failure("visitor.replace-null") {
        object : JsVisitorWithContextImpl() {
            override fun visit(x: JsNumberLiteral, ctx: JsContext<*>): Boolean {
                @Suppress("UNCHECKED_CAST") val mutable = ctx as JsContext<JsNode>
                mutable.replaceMe(null); return false
            }
        }.accept(JsIntLiteral(1))
    }
    for (mode in 0..3) {
        val vars = JsVars(JsVars.Variant.Var, JsVars.JsVar(name, JsIntLiteral(0)))
        val forNode = JsFor(vars, JsBooleanLiteral(true), JsIntLiteral(1), JsBlock())
        val parent = JsBlock(forNode)
        object : JsVisitorWithContextImpl() {
            override fun visit(x: JsVars, ctx: JsContext<*>): Boolean {
                @Suppress("UNCHECKED_CAST") val mutable = ctx as JsContext<JsStatement>
                when (mode) {
                    1 -> mutable.replaceMe(JsIntLiteral(4).makeStmt())
                    2 -> mutable.removeMe()
                    3 -> mutable.replaceMe(JsReturn(JsIntLiteral(5)))
                }
                return false
            }
        }.accept(parent)
        record("visitor.for-init.$mode", parent.toString())
    }

    val case = JsCase().apply { setCaseExpression(JsIntLiteral(1)); getStatements().add(JsReturn(JsIntLiteral(2))) }
    val default = JsDefault().apply { getStatements().add(JsBreak()) }
    val cases = readonlyListOf<JsSwitchMember>(case, default)
    val switch = JsSwitch(JsNameRef("value"), cases)
    record("list.switch-explicit-alias", switch.getCases() === cases)
    failure("list.switch-readonly-mutation") { switch.cases.add(default) }
    val statements: List<JsStatement> = listOf(
        JsBreak(), JsContinue(name.makeRef()), JsDebugger(),
        JsIf(JsBooleanLiteral(true), JsReturn(JsIntLiteral(1)), JsThrow(JsStringLiteral("bad"))),
        JsLabel(name, JsBlock()), JsReturn(), JsThrow(JsStringLiteral("err")), whileNode, doNode, tryNode,
        switch, JsForIn(JsVars.Variant.Var, JsDeclarable.Named(name), null, JsNameRef("object"), JsBlock()),
        JsForOf(JsVars.Variant.Let, JsDeclarable.Named(name), null, JsNameRef("items"), JsBlock()),
        JsImport("module", JsImport.Element(name, JsNameRef("alias"))), JsExport(name.makeRef())
    )
    for (item in statements.withIndex()) {
        val index = item.index
        val statement = item.value
        record("statement.$index.render", statement.toString())
        record("statement.$index.copy-render", statement.deepCopy().toString())
    }
    val binding = JsBindingElement(JsDeclarable.Named(name), JsIntLiteral(9), false)
    val arrayPattern = JsDeclarable.ArrayPattern(listOf(JsBindingArrayItem.Hole(), JsBindingArrayItem.Element(binding)))
    val objectPattern = JsDeclarable.ObjectPattern(listOf(JsBindingProperty(JsStringLiteral("key"), binding)))
    val modernExpressions: List<JsExpression> = listOf(
        JsAssignmentOperation.Simple(JsNameRef("target"), JsIntLiteral(1)),
        JsAssignmentOperation.Destructuring(arrayPattern, JsNameRef("items")),
        JsAssignmentOperation.Destructuring(objectPattern, JsNameRef("object")),
        JsTemplateStringLiteral(null, listOf(JsTemplateStringLiteral.Segment.StringLiteral("text"), JsTemplateStringLiteral.Segment.Interpolation(JsNameRef("value")))),
        JsClass(name, JsNameRef("Base"), JsFunction(scope, JsBlock(), "constructor"))
    )
    for (item in modernExpressions.withIndex()) {
        record("modern.${item.index}.render", item.value.toString())
        record("modern.${item.index}.copy-render", item.value.deepCopy().toString())
    }

    val output = TextOutputImpl()
    output.print("start"); output.newline(); output.indentIn(); output.print("\uD83D\uDE00"); output.print(charArrayOf('x', '\n'))
    output.newline(); output.print(1e23); output.indentOut(); output.newline(); output.print(-0.0)
    record("output.text", output.toString())
    record("output.positions", "${output.getPosition()}/${output.getLine()}/${output.getColumn()}")
    var seed = 0x12345678
    for (index in 0 until 240) {
        val bytes = ByteArray(index % 31 + 1) { seed = seed * 1664525 + 1013904223; (seed ushr 24).toByte() }
        val value = byteInteger(bytes).value
        record("integer.$index", "${value}/${value.toByteArray().joinToString { (it.toInt() and 255).toString(16) }}/${value.hashCode()}")
        record("integer.$index.sign", value.compareTo(byteInteger(byteArrayOf(0)).value).coerceIn(-1, 1))
    }
    for (group in 0 until 256) {
        val bits = buildString {
            for (code in group * 256 until (group + 1) * 256) {
                val c = code.toChar()
                append(if (c.isES5IdentifierStart()) '1' else '0')
                append(if (c.isES5IdentifierPart()) '1' else '0')
            }
        }
        record("identifier.bmp.$group", bits)
    }
    records.addAll(readerObservations())
    return "{\"records\":[" + records.joinToString(",") { quote(it) } + "],\"failures\":[" + failures.joinToString(",") { quote(it) } + "]}"
}
