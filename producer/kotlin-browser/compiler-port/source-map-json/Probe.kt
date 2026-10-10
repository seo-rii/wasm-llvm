package org.jetbrains.kotlin.sourcemapsprobe

import org.jetbrains.kotlin.js.parser.sourcemaps.*
import org.jetbrains.kotlin.js.parser.sourcemaps.ECMA426BasedSourceMapParser as Ecma
import org.jetbrains.kotlin.sourcemaps.runPinnedTests

private fun quote(text: String) = JsonString(text).toString()
private fun JsonNode.shape(): String = when (this) {
    is JsonNull -> "null"
    is JsonBoolean -> "boolean:$value"
    is JsonNumber -> "number:" + value.toRawBits().toULong().toString(16)
    is JsonString -> "string:" + value.map { it.code.toString(16) }.joinToString(".")
    is JsonArray -> "array:" + elements.joinToString("|") { it.shape() }
    is JsonObject -> "object:" + properties.entries.joinToString("|") { quote(it.key) + ":" + it.value.shape() }
}
private fun mapShape(value: Ecma.DecodedSourceMapRecord): String = buildString {
    append("file="); append(quote(value.file ?: "<null>"))
    for (source in value.sources) {
        append(";source="); append(quote(source.url ?: "<null>")); append('/'); append(quote(source.content ?: "<null>"))
        append('/'); append(source.ignored); append('/'); append(source.rootScopes)
    }
    for (mapping in value.mappings) {
        append(";mapping="); append(mapping.generatedPosition); append('/'); append(quote(mapping.name ?: "<null>"))
        mapping.originalPosition?.let { position ->
            append('/'); append(value.sources.indexOfFirst { it === position.source }); append('/'); append(position.line); append('/'); append(position.column)
        } ?: append("/<null>")
    }
    // Scope/range structural and source-identity assertions are made by the exact 38 original tests.
    append(";rangeCount="); append(value.ranges.size)
}
fun observation(): String {
    val records = ArrayList<String>(); val rawFailures = ArrayList<String>()
    fun record(name: String, value: Any?) { records.add("$name=$value") }
    fun json(name: String, input: String) {
        try {
            val parsed = parseJson(input)
            record(name, parsed.shape() + "/" + parsed.toString())
        } catch (failure: JsonSyntaxException) {
            record(name, "JsonSyntaxException/${failure.offset}/${failure.line}/${failure.column}/${failure.text}/${failure.message}")
            rawFailures.add("$name:${failure::class.simpleName}:${failure.message}")
        } catch (failure: Throwable) {
            record(name, failure::class.simpleName); rawFailures.add("$name:${failure::class.simpleName}:${failure.message}")
        }
    }
    for (name in runPinnedTests()) record("originalTest.$name", "PASS")
    val examples = listOf("null", "true", "false", "{}", "[]", "[1,true,null,\"text\"]", "{\"z\":1,\"a\":2}",
        " \r\n\t{\"x\": [0,-0,1.0,-1.25,1e2]}\n", "{\"한글\":\"😀\"}", "{\"\u0000\":\"\u0001\"}")
    for (item in examples.withIndex()) json("example.${item.index}", item.value)
    val malformed = listOf("", " ", "nul", "truE", "fals", "[", "{", "[1,]", "[,1]", "{\"x\":1,}", "{x:1}",
        "{\"x\":1,\"x\":2}", "{\"x\":1,\"\\u0078\":2}", "[1 2]", "null x", "\"unterminated", "\"\\q\"",
        "\"\\u12\"", "\"\\u12zz\"", "\"\n\"", "\"\u0000\"", "01", "-01", "1.", "1e", "1e+", "-", "NaN", "Infinity",
        "\r\n[1,\r\n?]", "\r\n\n[?]", "\r\r\n[?]")
    for (item in malformed.withIndex()) json("malformed.${item.index}", item.value)
    for (code in 0..65535) {
        val text = code.toChar().toString(); val encoded = JsonString(text).toString()
        record("utf16.$code", encoded + "/" + ((parseJson(encoded) as JsonString).value == text))
    }
    for (item in listOf("\ud800\udfff", "\ud800x\udfff", "\u0000\n\r\t\b\u000c\\\"", "한글😀").withIndex()) {
        json("utf16Pair.${item.index}", JsonString(item.value).toString())
    }
    val decimals = listOf("-0", "0.0", "-0.0", "1e-323", "5e-324", "2.2250738585072014e-308", "1.7976931348623157e308",
        "1e309", "-1e309", "9007199254740991", "9007199254740992", "9007199254740993", "9223372036854775807",
        "9223372036854775808", "-9223372036854775809", "0.1", "0.1000000000000000055511151231257827021181583404541015625")
    for (item in decimals.withIndex()) json("decimal.${item.index}", item.value)
    var seed = 0x73151927
    repeat(2048) { index ->
        seed = seed xor (seed shl 13); seed = seed xor (seed ushr 17); seed = seed xor (seed shl 5)
        val input = (if (seed < 0) "-" else "") + (seed.toUInt().toULong() + 1u).toString() + "." + (seed.toUInt() % 100000u).toString() + "e" + (index % 660 - 330)
        json("seededDecimal.$index", input)
    }
    for (item in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, -0.0, Double.MIN_VALUE, Double.MAX_VALUE, 1.5, 1.0e20).withIndex()) {
        record("constructedNumber.${item.index}", JsonNumber(item.value).toString())
    }
    val properties = linkedMapOf("z" to JsonNumber(1.0) as JsonNode, "a" to JsonString("original"))
    val objectNode = JsonObject(properties); record("objectAlias", objectNode.properties === properties)
    properties["a"] = JsonBoolean.TRUE; properties["last"] = JsonNull; record("objectMutation", objectNode.toString())
    val elements = mutableListOf<JsonNode>(JsonNull, JsonBoolean.FALSE); val array = JsonArray(elements)
    record("arrayAlias", array.elements === elements); elements.add(JsonString("added")); record("arrayMutation", array.toString())
    record("booleanIdentity", JsonBoolean.of(true) === JsonBoolean.TRUE && JsonBoolean.of(false) === JsonBoolean.FALSE)
    record("dataEquality", JsonObject("x" to JsonNumber(2.0)) == JsonObject("x" to JsonNumber(2.0)))
    val scoped = listOf("", "CAA", "BAAA", "BAAg", "BAAA,CBA", "BAAA,DAE,CBA", "DAC", "?", ",", "///////A")
    for (item in scoped.withIndex()) {
        val result = Ecma.decodeSourceScopes(item.value, listOf("a"))
        record("scope.${item.index}", when (result) {
            is Ecma.ParsingResult.Success -> "Success/${result.value}"
            is Ecma.ParsingResult.Failure -> "Failure/${result.message}/${result.cause?.let { it::class.simpleName }}"
            is Ecma.ParsingResult.NoMatch -> "NoMatch"
        })
    }
    val mappings = listOf("", "AAAA", "AAAAA", "A", "AAAA;AACA", "AAAA,CAAC", "?", "g", ",", ";;", "///////A", "ACAA", "AAAAC")
    for (item in mappings.withIndex()) {
        val input = JsonObject("version" to JsonNumber(3.0), "file" to JsonString("output.js"),
            "sources" to JsonArray(JsonString("a.kt")), "sourcesContent" to JsonArray(JsonString("한글\ntext")),
            "ignoreList" to JsonArray(JsonNumber(0.0)), "names" to JsonArray(JsonString("name")), "mappings" to JsonString(item.value)).toString()
        val result = Ecma.parseSourceMap(input, "https://example.test/dir/")
        record("ecmaMapping.${item.index}", when (result) {
            is Ecma.ParsingResult.Success -> "Success/${mapShape(result.value)}"
            is Ecma.ParsingResult.Failure -> "Failure/${result.message}/${result.cause?.let { it::class.simpleName }}"
            is Ecma.ParsingResult.NoMatch -> "NoMatch"
        })
    }
    for (item in listOf("", "null", "[]", "{}", "{\"version\":2}", "{\"version\":3,\"sources\":1}",
        "{\"version\":3,\"sources\":[null],\"mappings\":\"\"}", "{\"version\":3,\"sections\":[]}").withIndex()) {
        try {
            val result = Ecma.parseSourceMap(item.value, "")
            record("ecmaMalformed.${item.index}", when (result) {
                is Ecma.ParsingResult.Success -> "Success/${mapShape(result.value)}"
                is Ecma.ParsingResult.Failure -> "Failure/${result.message}/${result.cause?.let { it::class.simpleName }}"
                is Ecma.ParsingResult.NoMatch -> "NoMatch"
            })
        } catch (failure: Throwable) {
            record("ecmaMalformed.${item.index}", "${failure::class.simpleName}/${failure.message}")
            rawFailures.add("ecmaMalformed.${item.index}:${failure::class.simpleName}:${failure.message}")
        }
    }
    return "{\"records\":[" + records.joinToString(",") { quote(it) } + "],\"rawFailures\":[" + rawFailures.joinToString(",") { quote(it) } + "]}"
}
