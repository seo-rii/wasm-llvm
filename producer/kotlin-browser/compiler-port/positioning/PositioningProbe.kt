/* Tree fixtures are algorithm inputs, not an implementation of the Kotlin parser. */
package org.jetbrains.kotlin.portable.positioningprobe

class FixtureNode(val id: String, val type: String, val start: Int, val end: Int, val children: List<FixtureNode> = emptyList(), val text: String = "0".repeat(end - start)) {
    override fun toString(): String = "$id:$type[$start,$end]"
}

private fun StringBuilder.quoted(value: String) {
    append('"')
    for (character in value) when (character) {
        '"' -> append("\\\"")
        '\\' -> append("\\\\")
        else -> if (character.code < 32) append("\\u").append(character.code.toString(16).padStart(4, '0')) else append(character)
    }
    append('"')
}

fun positioningProbeJson(): String {
    val cases = mutableListOf<Pair<String, String>>()
    fun leaf(id: String, type: String, start: Int, end: Int) = FixtureNode(id, type, start, end)
    fun n(id: String, type: String, start: Int, end: Int, vararg children: FixtureNode) = FixtureNode(id, type, start, end, children.toList())
    val fixtures = listOf(
        leaf("id", "t:IDENTIFIER", 10, 14),
        leaf("int", "t:INTEGER_LITERAL", 10, 15),
        FixtureNode("long", "t:INTEGER_LITERAL", 10, 16, text = "12345L"),
        leaf("error", "error", 10, 10),
        n("empty-function", "n:FUN", 10, 10),
        n("function", "n:FUN", 10, 50,
            leaf("kw", "t:FUN_KEYWORD", 10, 13), leaf("space", "t:WHITE_SPACE", 13, 14), leaf("name", "t:IDENTIFIER", 14, 17),
            n("params", "n:VALUE_PARAMETER_LIST", 17, 19, leaf("lp", "t:LPAR", 17, 18), leaf("rp", "t:RPAR", 18, 19)),
            leaf("colon", "t:COLON", 19, 20), n("type", "n:TYPE_REFERENCE", 21, 24, leaf("type-id", "t:IDENTIFIER", 21, 24)),
            n("block", "n:BLOCK", 25, 50, leaf("lb", "t:LBRACE", 25, 26), leaf("body", "t:INTEGER_LITERAL", 30, 31), leaf("rb", "t:RBRACE", 49, 50))),
        n("property", "n:PROPERTY", 10, 35, leaf("var", "t:VAR_KEYWORD", 10, 13), leaf("name", "t:IDENTIFIER", 14, 15),
            leaf("colon", "t:COLON", 15, 16), n("type", "n:TYPE_REFERENCE", 17, 20, leaf("type-id", "t:IDENTIFIER", 17, 20)),
            leaf("eq", "t:EQ", 21, 22), leaf("value", "t:INTEGER_LITERAL", 23, 25)),
        n("object", "n:OBJECT_DECLARATION", 10, 40, leaf("object-kw", "t:OBJECT_KEYWORD", 10, 16), leaf("name", "t:IDENTIFIER", 17, 18),
            n("supers", "n:SUPER_TYPE_LIST", 20, 23, leaf("super-id", "t:IDENTIFIER", 20, 23))),
        n("object-literal", "n:OBJECT_LITERAL", 10, 40, n("decl", "n:OBJECT_DECLARATION", 10, 40,
            leaf("object-kw", "t:OBJECT_KEYWORD", 10, 16), n("supers", "n:SUPER_TYPE_LIST", 18, 21, leaf("super-id", "t:IDENTIFIER", 18, 21)))),
        n("class", "n:CLASS", 10, 60, n("modifiers", "n:MODIFIER_LIST", 10, 17, leaf("public", "t:PUBLIC_KEYWORD", 10, 16)),
            leaf("class-kw", "t:CLASS_KEYWORD", 18, 23), leaf("name", "t:IDENTIFIER", 24, 25),
            n("constructor", "n:PRIMARY_CONSTRUCTOR", 25, 27, n("params", "n:VALUE_PARAMETER_LIST", 25, 27, leaf("lp", "t:LPAR", 25, 26), leaf("rp", "t:RPAR", 26, 27)))),
        n("constructor", "n:SECONDARY_CONSTRUCTOR", 10, 45, leaf("constructor-kw", "t:CONSTRUCTOR_KEYWORD", 10, 21),
            n("params", "n:VALUE_PARAMETER_LIST", 21, 23, leaf("lp", "t:LPAR", 21, 22), leaf("rp", "t:RPAR", 22, 23)),
            n("delegation", "n:CONSTRUCTOR_DELEGATION_CALL", 25, 31, n("ref", "n:CONSTRUCTOR_DELEGATION_REFERENCE", 25, 29, leaf("this", "t:THIS_KEYWORD", 25, 29)))),
        n("accessor", "n:PROPERTY_ACCESSOR", 10, 20, leaf("get", "t:GET_KEYWORD", 10, 13), n("params", "n:VALUE_PARAMETER_LIST", 13, 15,
            leaf("lp", "t:LPAR", 13, 14), leaf("rp", "t:RPAR", 14, 15))),
        n("binary", "n:BINARY_EXPRESSION", 10, 22, n("left", "n:REFERENCE_EXPRESSION", 10, 11, leaf("left-id", "t:IDENTIFIER", 10, 11)),
            n("op", "n:OPERATION_REFERENCE", 12, 13, leaf("plus", "t:PLUS", 12, 13)), leaf("right", "t:INTEGER_LITERAL", 14, 22)),
        n("assignment", "n:BINARY_EXPRESSION", 10, 25, n("parenthesized", "n:PARENTHESIZED", 10, 15,
            leaf("lp", "t:LPAR", 10, 11), leaf("left-id", "t:IDENTIFIER", 11, 14), leaf("rp", "t:RPAR", 14, 15)),
            n("op", "n:OPERATION_REFERENCE", 17, 18, leaf("equals", "t:EQ", 17, 18)), leaf("rhs", "t:INTEGER_LITERAL", 19, 25)),
        n("call", "n:CALL_EXPRESSION", 10, 24, n("callee", "n:REFERENCE_EXPRESSION", 10, 13, leaf("callee-id", "t:IDENTIFIER", 10, 13)),
            n("args", "n:VALUE_ARGUMENT_LIST", 13, 24, leaf("lp", "t:LPAR", 13, 14), n("arg", "n:VALUE_ARGUMENT", 14, 23,
                leaf("star", "t:MUL", 14, 15), leaf("id", "t:IDENTIFIER", 15, 23)), leaf("rp", "t:RPAR", 23, 24))),
        n("dot", "n:DOT_QUALIFIED_EXPRESSION", 10, 20, n("receiver", "n:REFERENCE_EXPRESSION", 10, 13, leaf("receiver-id", "t:IDENTIFIER", 10, 13)),
            leaf("dot-token", "t:DOT", 13, 14), n("selector", "n:REFERENCE_EXPRESSION", 14, 20, leaf("selector-id", "t:IDENTIFIER", 14, 20))),
        n("safe", "n:SAFE_ACCESS_EXPRESSION", 10, 20, n("receiver", "n:REFERENCE_EXPRESSION", 10, 13, leaf("receiver-id", "t:IDENTIFIER", 10, 13)),
            leaf("safe-token", "t:SAFE_ACCESS", 13, 15), n("selector", "n:REFERENCE_EXPRESSION", 15, 20, leaf("selector-id", "t:IDENTIFIER", 15, 20))),
        n("when", "n:WHEN", 10, 30, leaf("when-kw", "t:WHEN_KEYWORD", 10, 14), leaf("lb", "t:LBRACE", 15, 16),
            n("entry", "n:WHEN_ENTRY", 17, 25, leaf("else", "t:ELSE_KEYWORD", 17, 21), leaf("arrow", "t:ARROW", 22, 24)), leaf("rb", "t:RBRACE", 29, 30)),
        n("if", "n:IF", 10, 31, leaf("if-kw", "t:IF_KEYWORD", 10, 12), n("condition", "n:CONDITION", 13, 17,
            leaf("true", "t:TRUE_KEYWORD", 13, 17)), n("then", "n:THEN", 18, 22, leaf("value", "t:INTEGER_LITERAL", 18, 19)),
            leaf("else", "t:ELSE_KEYWORD", 23, 27), n("else-node", "n:ELSE", 28, 31, leaf("value", "t:INTEGER_LITERAL", 28, 31))),
        n("array", "n:ARRAY_ACCESS_EXPRESSION", 10, 18, leaf("array-name", "t:IDENTIFIER", 10, 13),
            n("indices", "n:INDICES", 13, 18, leaf("lsq", "t:LBRACKET", 13, 14), leaf("index", "t:INTEGER_LITERAL", 14, 17), leaf("rsq", "t:RBRACKET", 17, 18))),
        n("return", "n:RETURN", 10, 24, leaf("return-kw", "t:RETURN_KEYWORD", 10, 16), n("label", "n:LABEL_QUALIFIER", 16, 20,
            leaf("at", "t:AT", 16, 17), leaf("label-id", "t:IDENTIFIER", 17, 20)), leaf("value", "t:INTEGER_LITERAL", 21, 24)),
        n("filler", "n:BLOCK", 10, 30, leaf("ws", "t:WHITE_SPACE", 10, 12), leaf("comment", "t:BLOCK_COMMENT", 12, 18),
            leaf("value", "t:INTEGER_LITERAL", 18, 20), leaf("tail-comment", "t:EOL_COMMENT", 20, 26), leaf("tail-ws", "t:WHITE_SPACE", 26, 30)),
        n("invalid", "n:FUN", 10, 30, leaf("kw", "t:FUN_KEYWORD", 10, 13), leaf("id", "t:IDENTIFIER", 14, 16),
            n("broken", "n:VALUE_PARAMETER_LIST", 16, 30, leaf("lp", "t:LPAR", 16, 17), leaf("error", "error", 30, 30))),
        n("filler-error", "n:BLOCK", 10, 30, leaf("error", "error", 10, 10), leaf("last-id", "t:IDENTIFIER", 11, 12), leaf("semicolon", "t:SEMICOLON", 29, 30)),
        n("all-fillers", "n:BLOCK", 10, 30, leaf("ws", "t:WHITE_SPACE", 10, 15), leaf("comment", "t:DOC_COMMENT", 15, 30)),
        n("nullable", "n:TYPE_REFERENCE", 10, 20, n("outer-nullable", "n:NULLABLE_TYPE", 10, 20,
            n("inner-nullable", "n:NULLABLE_TYPE", 10, 19, n("user-type", "n:USER_TYPE", 10, 18,
                leaf("type-id", "t:IDENTIFIER", 10, 18)), leaf("quest-1", "t:QUEST", 18, 19)), leaf("quest-2", "t:QUEST", 19, 20))),
    )
    for (fixture in fixtures) {
        for (strategy in strategyNames()) {
            cases.add("mark/${fixture.id}/$strategy" to markSnapshot(strategy, fixture, fixture.start + 100, fixture.end + 100))
            cases.add("valid/${fixture.id}/$strategy" to validitySnapshot(strategy, fixture))
        }
        cases.add("helpers/${fixture.id}" to helperSnapshot(fixture))
    }
    cases.add("unreachable/leaves-and-filler-removal" to unreachableSnapshot(n("root", "n:BLOCK", 10, 30,
        leaf("a", "t:IDENTIFIER", 10, 12), leaf("comma", "t:COMMA", 12, 13), leaf("space", "t:WHITE_SPACE", 13, 14),
        n("nested", "n:BINARY_EXPRESSION", 14, 24, leaf("b", "t:IDENTIFIER", 14, 18), leaf("c", "t:IDENTIFIER", 18, 24)),
        leaf("tail", "t:IDENTIFIER", 25, 30))))
    for ([name, value] in rangeSnapshots()) cases.add("range/$name" to value)
    for ([name, value] in declarationSnapshots()) cases.add("declaration/$name" to value)
    for ([name, value] in childGuardSnapshots()) cases.add("children-guard/$name" to value)
    for ([name, source] in listOf("unicode-crlf" to "//한글\r\nfun café() { println(\"😀\") }\r\n", "syntax-error" to "fun broken( { val x = \"미완", "empty" to "")) {
        cases.add("official-parser-placeholder/$name" to placeholderSnapshot(source))
    }
    return buildString {
        append("{\"cases\":[")
        for ([index, case] in cases.withIndex()) {
            if (index != 0) append(',')
            append('['); quoted(case.first); append(','); quoted(case.second); append(']')
        }
        append("]}")
    }
}
