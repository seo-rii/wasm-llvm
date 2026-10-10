package org.jetbrains.kotlin.js.deserializerprobe
import org.jetbrains.kotlin.js.backend.ast.*
private fun Int.bytes() = ByteArray(4) { (this ushr (24 - it * 8)).toByte() }
private fun payload(text: String): ByteArray = text.encodeToByteArray().let { it.size.bytes() + it }
private fun header(file: Int?, line: Int = 12, column: Int = 34): ByteArray = byteArrayOf(1, if (file == null) 0 else 1) +
    (file?.bytes() ?: byteArrayOf()) + line.bytes() + column.bytes()
private fun comment(text: String, multiline: Boolean = false): ByteArray = payload(text) + byteArrayOf(if(multiline) 1 else 0)
private fun bundle(before: Int?, after: Int?): ByteArray {
    fun one(count: Int?): ByteArray = if (count == null) byteArrayOf(0) else byteArrayOf(1) + count.bytes() +
        (0 until count).fold(byteArrayOf()) { acc, i -> acc + comment("c$i", i % 2 == 1) }
    return one(before) + one(after)
}
private fun quote(s: String): String = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
private fun JsNode.locationText(): String = getSource()?.let { "${it.file}/${it.startLine}/${it.startChar}" } ?: "null"
fun observation(): String {
    val records=ArrayList<String>(); val failures=ArrayList<String>(); val raw=ArrayList<String>()
    fun record(name: String, value: Any?) { records.add("$name=$value") }
    fun attempt(name: String, body: () -> Any?) { try { record(name, body()) } catch(e: Throwable) { record(name, if(e is IndexOutOfBoundsException) "IndexOutOfBoundsException" else e::class.simpleName); failures.add("$name:${e::class.simpleName}:${e.message}") } }
    val texts=listOf("", "ASCII", "한글😀\r\n", "e\u0301", "\uFEFF")
    for (item in texts.withIndex()) { val i=item.index; val text=item.value; val input=SelectedInput(payload(text), emptyArray()); record("text.$i", input.text().map { it.code.toString(16) }.joinToString("/")); record("text.$i.position",input.position()) }
    for(length in listOf(-1, Int.MAX_VALUE, 4)) { val input=SelectedInput(length.bytes()+byteArrayOf(1,2,3),emptyArray()); attempt("badlength.$length") { input.text() }; record("badlength.$length.position",input.position()) }
    for (size in 0..8) { val input=SelectedInput(size.bytes()+ByteArray(size) { (it*31).toByte() },emptyArray()); record("bytes.$size",input.bytes().joinToString("/")+"/"+input.position()) }
    for(bits in listOf(0L,Long.MIN_VALUE,0x7ff0000000000001L,0x7ff8000000000000L,-1L)) {
        val input=SelectedInput(ByteArray(8) { (bits ushr (56-it*8)).toByte() },emptyArray()); record("double.$bits",input.double().toRawBits().toString(16)+"/"+input.position())
    }
    val plain=SelectedInput(byteArrayOf(0),arrayOf("a.kt")); var actions=0
    val node=plain.location { actions++; JsStringLiteral("plain") }; record("location.disabled", "${node.locationText()}/$actions/${plain.stack()}")
    for (outer in listOf<Int?>(null,0)) for(inner in listOf<Int?>(null,0,1)) {
        val input=SelectedInput(header(outer,1,2)+header(inner,3,4),arrayOf("a.kt","b.kt")); var nested:JsNode?=null
        val top=input.location { nested=input.location { JsStringLiteral("inner") }; JsStringLiteral("outer") }
        record("location.$outer.$inner", "${top.locationText()}/${nested!!.locationText()}/${input.stack()}/${input.position()}")
    }
    val throwing=SelectedInput(header(0)+header(1)+header(null,8,9),arrayOf("a.kt","b.kt"))
    attempt("location.actionThrows") { throwing.location { throwing.location { throw IllegalStateException("intentional action failure") }; JsStringLiteral("unreachable") } }
    record("location.retainedAfterThrow",throwing.stack())
    record("location.nextInheritsRetained", throwing.location { JsStringLiteral("next") }.locationText())
    record("location.stillRetained",throwing.stack())
    for(before in listOf<Int?>(null,0,1,2,3)) for(after in listOf<Int?>(null,0,1,2)) {
        val input=SelectedInput(bundle(before,after),emptyArray()); var count=0
        val n=input.comments { count++; JsStringLiteral("node") }
        val b=n.getCommentsBeforeNode(); val a=n.getCommentsAfterNode()
        record("comments.$before.$after", "${b?.joinToString("/") { it.text }}/${a?.joinToString("/") { it.text }}/$count/${input.position()}")
        val copy=n.deepCopy(); record("comments.$before.$after.types", b?.joinToString("/") { (it is JsMultiLineComment).toString() })
        record("comments.$before.$after.copyAliases", "${copy.getCommentsBeforeNode() === b}/${copy.getCommentsAfterNode() === a}")
    }
    for(size in 0..3) {
        fun fresh(): Pair<JsNode,MutableList<JsComment>> {
            val n=JsStringLiteral("node") as JsNode
            attachCommentFactory(n,Array<JsComment>(size) { JsSingleLineComment("v$it") }); return n to n.getCommentsBeforeNode()!!
        }
        attempt("factory.$size.add") { fresh().second.add(JsSingleLineComment("new")) }
        attempt("factory.$size.addAllEmpty") { fresh().second.addAll(emptyList()) }
        attempt("factory.$size.removeAbsent") { fresh().second.remove(JsSingleLineComment("absent")) }
        attempt("factory.$size.removeAllEmpty") { fresh().second.removeAll(emptyList()) }
        attempt("factory.$size.clear") { fresh().second.clear(); "ok" }
        attempt("factory.$size.set0") { val list=fresh().second; list.set(0,JsSingleLineComment("replace")).text+"/"+list.joinToString("/") { it.text } }
        attempt("factory.$size.setInvalid") { fresh().second.set(9,JsSingleLineComment("invalid")); "ok" }
        if(size>0) {
            attempt("factory.$size.removePresent") { val list=fresh().second; list.remove(list[0]) }
            attempt("factory.$size.listIteratorSet") { val list=fresh().second; val iter=list.listIterator(); val old=iter.next(); iter.set(JsSingleLineComment("iterator")); old.text+"/"+list[0].text }
            attempt("factory.$size.subListSet") { val list=fresh().second; list.subList(0,1).set(0,JsSingleLineComment("view")).text+"/"+list[0].text }
            attempt("factory.$size.iteratorRemove") { val iter=fresh().second.iterator(); iter.next(); iter.remove(); "ok" }
            attempt("factory.$size.actualAddComment") { val n=fresh().first; mutateComments(n); "ok" }
        }
        val source=Array<JsComment>(size) { JsSingleLineComment("original$it") }; val n=JsStringLiteral("node") as JsNode; attachCommentFactory(n,source)
        val list=n.getCommentsBeforeNode()!!
        if(size>0) { val old=source[0]; source[0]=JsSingleLineComment("external"); record("factory.$size.arrayCopied",list[0]===old) }
        if(size>1) { list[0]=JsSingleLineComment("internal"); record("factory.$size.reverseArrayIsolation",source[0].text=="external") }
        val copy=n.deepCopy(); record("factory.$size.metadataShared", copy.getCommentsBeforeNode()===list)
        val other=JsStringLiteral("other") as JsNode; attachCommentFactory(other,emptyArray()); if(size==0)record("factory.emptyCanonical",list===other.getCommentsBeforeNode())
        raw.add("factory.$size.globalEmptyIdentity=${directCommentFactory(emptyArray()) === emptyList<JsComment>()}")
        raw.add("native.$size.mutable=${source.toList() is MutableList<*>}")
    }
    return "{\"records\":["+records.joinToString(",") { quote(it) }+"],\"failures\":["+failures.joinToString(",") { quote(it) }+"],\"rawFactory\":["+raw.joinToString(",") { quote(it) }+"]}"
}
