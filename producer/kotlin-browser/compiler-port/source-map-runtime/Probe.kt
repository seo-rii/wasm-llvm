package org.jetbrains.kotlin.js.sourcemapruntimeprobe

import org.jetbrains.kotlin.config.CompilerConfiguration
import org.jetbrains.kotlin.js.portable.sourcemap.installRequestSourceMapRuntime
import org.jetbrains.kotlin.js.portable.sourcemap.requestSourceMapRuntime

private class PrintState(val failAt: Int = -1, val runtimeFailure: Boolean = false) {
    val calls = mutableListOf<String>()
    val bytes = mutableListOf<Byte>()
    val ioFault = HostIoFailure("request print IO")
    val runtimeFault = IllegalStateException("request print runtime")
    fun write(source: ByteArray, offset: Int, length: Int) {
        calls += "write-$length"
        if (calls.size == failAt) throw if (runtimeFailure) runtimeFault else ioFault
        for (i in offset until offset + length) bytes += source[i]
    }
}
private fun units(text: String): String = text.map { it.code.toString(16).padStart(4, '0') }.joinToString("")
private fun hex(bytes: ByteArray): String = bytes.joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }
private fun escaped(value: String): String = buildString {
    append('"'); for (char in value) when (char) { '"' -> append("\\\""); '\\' -> append("\\\\"); else -> if (char.code < 32) append("\\u" + char.code.toString(16).padStart(4, '0')) else append(char) }; append('"')
}
private fun json(text: String, mappings: String = "AAAA") = "{\"version\":3,\"sourceRoot\":\"\",\"sources\":[\"a\"],\"sourcesContent\":[" + escaped(text) + "],\"names\":[\"named\"],\"mappings\":" + escaped(mappings) + "}"
private fun segments(map: SourceMap): String = map.groups.joinToString(";") { group -> group.segments.joinToString("|") { segment ->
    "${segment.generatedColumnNumber}:${segment.sourceFileName}:${segment.sourceLineNumber}:${segment.sourceColumnNumber}:${segment.name}:${segment.isIgnored}" } }
private fun result(result: SourceMapParseResult): String = when (result) { is SourceMapError -> "error:" + units(result.message); is SourceMapSuccess -> "success:" + units(segments(result.value)) }
private fun source(node: JsNode): String {
    val location = node.source
    return when (location) {
        is JsLocationWithEmbeddedSource -> "embedded:${units(location.file)}:${location.startLine}:${location.startChar}:${location.name}"
        is JsLocation -> "plain:${units(location.file)}:${location.startLine}:${location.startChar}:${location.name}"
        null -> "null"
        else -> "opaque"
    }
}

@OptIn(CompilerConfiguration.Internals::class)
fun observation(): String {
    val records = mutableListOf<String>(); val failures = mutableListOf<String>()
    val state = PrintState(); val host = runtime(emptyMap(), state)
    val inputs = listOf("", "[]", "null", "{}", "{\"version\":2}", "{\"version\":3}", "{\"version\":3,\"mappings\":0}",
        "{\"version\":3,\"sourceRoot\":0,\"mappings\":\"\"}", "{\"version\":3,\"sources\":false,\"mappings\":\"\"}",
        "{\"version\":3,\"sources\":[null],\"mappings\":\"\"}", "{\"version\":3,\"sourcesContent\":[1],\"mappings\":\"\"}",
        "{\"version\":3,\"names\":[null],\"mappings\":\"\"}", "{\"version\":3,\"ignoreList\":[null],\"mappings\":\"\"}",
        "{\"version\":3,\"x_google_ignoreList\":[0],\"sources\":[\"a\"],\"mappings\":\"AAAA\"}",
        "{\"version\":3,\"ignoreList\":[1],\"x_google_ignoreList\":[0],\"sources\":[\"a\"],\"mappings\":\"AAAA\"}",
        "{\"version\":1e20}", "{\"version\":1e309}", "{\"version\":-0}")
    for ([index, text] in inputs.withIndex()) records += "parse-$index:" + result(parse(text, host))
    for (mapping in listOf("", "A", "D", ";", ";;;", "AAAA", "AAAAA", "AAAA,C", "AAAA,KAAA", "AAAA;A;;K", "AAAA,AAAA", "ACAA", "AAAAC", "g", "!", "AA", "AAA", "AAAA!", "AAAA,", "AAAA;;", "/////////A")) records += "mapping-${units(mapping)}:" + result(parse(json("raw\ud800\udc00", mapping), host))
    var seed = 0x17293
    for (index in 0 until 600) {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/;,!?"
        val mapping = buildString { repeat(index % 23) { seed = seed * 1664525 + 1013904223; append(alphabet[(seed ushr 1) % alphabet.length]) } }
        records += "seed-mapping-$index:" + result(parse(json("source", mapping), host))
    }
    for (mapping in listOf("", "A", "Z", "gA", "//////A", "ggggggggggggggggggA", "!", "g", ",", ";")) {
        val stream = SourceMapParser.MappingStream(mapping)
        records += "vlq-${units(mapping)}:${stream.readInt()}:${stream.position}:${stream.isEof}"
    }
    val good = (parse(json("one\r\ntwo\n\ud800", "AAAA,KAAAA;A;;E"), host) as SourceMapSuccess).value
    for (line in -1..5) for (column in listOf<Int?>(null, -1, 0, 1, 4, 5, 6, 100)) {
        val segment = good.segmentForGeneratedLocation(line, column)
        records += "location-$line-$column:${segment?.generatedColumnNumber}:${segment?.sourceFileName}:${segment?.name}"
    }
    for (root in listOf("", "root/")) {
        val text = json("\ud800raw\udc00").replace("\"sourceRoot\":\"\"", "\"sourceRoot\":" + escaped(root))
        val map = (parse(text, host) as SourceMapSuccess).value
        for (name in listOf("a", "root/a", "missing")) {
            val reader = map.sourceContentResolver(name); val next = map.sourceContentResolver(name)
            records += "resolver-${units(root)}-$name:${reader == null}:${reader !== next}:" + (reader?.readText()?.let(::units) ?: "null")
            if (reader != null) { reader.close(); try { reader.readText() } catch (error: Throwable) { failures += "closed-reader:${failureType(error)}:${error.message}" } }
        }
    }
    val printStates = listOf(PrintState(), PrintState(1), PrintState(1, true))
    for ([index, output] in printStates.withIndex()) {
        val runtime = runtime(emptyMap(), output); val map = (parse(json("x", "AAAAA,KAAA;A"), runtime) as SourceMapSuccess).value
        val error = try { debug(map, runtime); null } catch (failure: Throwable) { failure }
        records += "debug-$index:${error === output.runtimeFault}:${checkPrintError(runtime)}:${hex(output.bytes.toByteArray())}:${output.calls.joinToString(".")}"
        records += "debugToString-$index:" + units(map.debugToString())
    }
    for (content in listOf(json("source", "AAAAA,KAAA;A"), json("source", ""), "{}", "[]", "broken", "{\"sources\":[]}", "{\"sources\":[\"a\",\"b\"]}", "{\"sources\":0}", "{\"sources\":[null]}")) {
        for (change in listOf(false, true)) {
            var callbacks = 0; val mapping: (String) -> String = { callbacks++; if (change) "renamed/$it" else it }
            val mapped = try { val [changed, text] = mapSources(content, mapping); "$changed:${units(text)}" } catch (error: SourceMapSourceReplacementException) { "replacement:${units(error.message ?: "")}:${units(error.cause?.message ?: "")}" }
            records += "mapSources-${units(content)}-$change:$callbacks:$mapped"
            val fileRuntime = runtime(mapOf("map" to utf8(content)), PrintState())
            callbacks = 0
            val replaced = try { replaceSources(fileRuntime, "map", mapping).toString() } catch (error: SourceMapSourceReplacementException) { "replacement:${units(error.message ?: "")}:${units(error.cause?.message ?: "")}" }
            records += "replaceSources-${units(content)}-$change:$callbacks:$replaced:${hex(bytes(fileRuntime, "map"))}"
        }
    }
    val verboseState = PrintState()
    val fileRuntime = runtime(mapOf("map" to utf8(json("source", "AAAAA,KAAA;A")), "code" to utf8("abcde\r\nx\n")), verboseState)
    val fileMap = (parseFile("map", fileRuntime) as SourceMapSuccess).value
    records += "parse-file:" + units(segments(fileMap))
    debugVerbose(fileMap, fileRuntime, "code")
    records += "debugVerbose:" + hex(verboseState.bytes.toByteArray()) + ":" + verboseState.calls.joinToString(".")
    try { debugVerbose(fileMap, fileRuntime, "missing") } catch (error: Throwable) { failures += "missing-verbose:${failureType(error)}:${error.message}" }
    for (failAt in 1..3) {
        val fault = IllegalStateException("mapping callback")
        val order = mutableListOf<String>()
        val content = "{\"sources\":[\"a\",\"b\",\"c\"]}"
        val fileHost = runtime(mapOf("map" to utf8(content)), PrintState())
        val error = try { replaceSources(fileHost, "map") { order += it; if (order.size == failAt) throw fault; "new/$it" }; null } catch (error: Throwable) { error }
        records += "replacement-callback-failure-$failAt:${error === fault}:${order.joinToString(".")}:${hex(bytes(fileHost, "map"))}"
    }
    // Request-owned configuration replacement must not retarget an existing map's output.
    val configuration = CompilerConfiguration(); val otherConfiguration = CompilerConfiguration()
    val a = PrintState(); val b = PrintState(); val runtimeA = runtime(emptyMap(), a); val runtimeB = runtime(emptyMap(), b)
    installRequestSourceMapRuntime(configuration, runtimeA)
    val captured = requestSourceMapRuntime(configuration); val oldMap = (parse(json("x"), captured) as SourceMapSuccess).value
    installRequestSourceMapRuntime(configuration, runtimeB)
    debug(oldMap, captured)
    val currentMap = (parse(json("x"), requestSourceMapRuntime(configuration)) as SourceMapSuccess).value; debug(currentMap, runtimeB)
    records += "runtime-capture:${captured === runtimeA}:${requestSourceMapRuntime(configuration) === runtimeB}:${hex(a.bytes.toByteArray())}:${hex(b.bytes.toByteArray())}"
    val missingRuntime = try { requestSourceMapRuntime(otherConfiguration); false } catch (error: IllegalArgumentException) { error.message == "Source map runtime is not installed for this request" }
    records += "runtime-isolation:$missingRuntime"
    // Real AST ordering and full remapping, including do/while and last-segment carry.
    for (ordering in 0..3) {
        val left = JsNameRef("left").apply { source = JsLocation("generated", 0, if (ordering == 0) 0 else 8) }
        val right = JsNameRef("right").apply { source = JsLocation("generated", 2, 1) }
        val binary = JsBinaryOperation(JsBinaryOperator.ADD, left, right).apply { source = JsLocation(if (ordering == 3) "other" else "generated", 0, ordering * 3) }
        val loop = JsDoWhile().apply { body = binary.makeStmt(); condition = JsNameRef("condition").apply { source = JsLocation("generated", 3, 6) }; source = JsLocation("generated", 0, 0) }
        val collector = SourceMapLocationRemapper.JsNodeFlatListCollector(); loop.accept(collector)
        records += "collector-$ordering:" + collector.nodeList.joinToString("|") { source(it) }
        val mapped = (parse(json("embedded\ud800", "AAAAA,KAAA;;A;EAAA"), host) as SourceMapSuccess).value
        SourceMapLocationRemapper(mapped) { "mapped/$it" }.remap(loop)
        records += "remap-$ordering:" + collector.nodeList.joinToString("|") { source(it) }
        val embedded = left.source as? JsLocationWithEmbeddedSource
        records += "remap-content-$ordering:" + (embedded?.sourceProvider?.invoke()?.readText()?.let(::units) ?: "null")
    }
    // A genuine default Java function has a null body despite its @NotNull getter.
    // Preserve partial visitation and the null dereference category, retaining raw
    // the exact selected dereference message, without claiming stacktrace parity.
    for (remap in listOf(false, true)) {
        val function = JsFunction(JsProgram().rootScope, "null-body").apply {
            source = JsLocation("generated", 0, 4)
            parameters += JsParameter(JsName("parameter", false)).apply { source = JsLocation("generated", 0, 1) }
        }
        val collector = SourceMapLocationRemapper.JsNodeFlatListCollector()
        val error = try {
            if (remap) SourceMapLocationRemapper(good).remap(function) else function.accept(collector)
            null
        } catch (failure: Throwable) { failure }
        records += "null-function-body-$remap:${error is NullPointerException}:${units(error?.message ?: "")}:" + source(function) + ":" + collector.nodeList.joinToString("|") { source(it) }
        if (error != null) failures += "null-function-body-$remap:${failureType(error)}:${error.message}"
    }
    for (kind in 0..11) for (parentFirst in listOf(false, true)) {
        fun leaf(name: String, column: Int) = JsNameRef(name).apply { source = JsLocation("generated", 0, column, name) }
        val first = leaf("first", if (parentFirst) 8 else 0); val second = leaf("second", 5); val third = leaf("third", 9)
        val node: JsNode = when (kind) {
            0 -> JsConditional(first, second, third)
            1 -> JsArrayAccess(first, second)
            2 -> JsArrayLiteral(mutableListOf<JsExpression>(first, second, third))
            3 -> JsPrefixOperation(JsUnaryOperator.NEG, first)
            4 -> JsPostfixOperation(JsUnaryOperator.INC, first)
            5 -> JsNameRef("qualified", first)
            6 -> JsInvocation(first, mutableListOf<JsExpression>(second, third))
            7 -> JsAssignmentOperation.Simple(first, second)
            8 -> JsFunction(JsProgram().rootScope, JsBlock(mutableListOf(first.makeStmt(), second.makeStmt())), "fixture").apply {
                parameters += JsParameter(JsName("parameter", false)).apply { source = JsLocation("generated", 0, 1, "parameter") }
                computedName = third
            }
            9 -> JsArrayLiteral()
            10 -> JsConditional()
            else -> JsBlock(mutableListOf(first.makeStmt(), JsDebugger(), second.makeStmt()))
        }
        node.source = JsLocation("generated", 0, 4, "parent")
        val collector = SourceMapLocationRemapper.JsNodeFlatListCollector(); node.accept(collector)
        records += "collector-kind-$kind-$parentFirst:" + collector.nodeList.joinToString("|") { source(it) }
        val mapped = (parse(json("embedded", "AAAAA,KAAA"), host) as SourceMapSuccess).value
        SourceMapLocationRemapper(mapped).remap(node)
        records += "remap-kind-$kind-$parentFirst:" + collector.nodeList.joinToString("|") { source(it) }
        if (kind == 8) records += "unvisited-computed-name-$parentFirst:" + source(third)
    }
    return "{\"records\":[" + records.joinToString(",") { escaped(it) } + "],\"failures\":[" + failures.joinToString(",") { escaped(it) } + "],\"entryRuntimeInstalled\":false}"
}
