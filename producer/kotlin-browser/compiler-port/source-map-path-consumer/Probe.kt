package org.jetbrains.kotlin.js.sourcemappathprobe

import org.jetbrains.kotlin.js.backend.ast.*
import org.jetbrains.kotlin.js.sourceMap.*
import org.jetbrains.kotlin.js.backend.JsToStringGenerationVisitor
import org.jetbrains.kotlin.js.util.TextOutputImpl
import org.jetbrains.kotlin.ir.backend.js.SourceMapsInfo
import org.jetbrains.kotlin.backend.wasm.utils.SourceMapGenerator
import org.jetbrains.kotlin.wasm.ir.source.location.SourceLocation
import org.jetbrains.kotlin.wasm.ir.source.location.SourceLocationMapping

private fun units(text: String): String = text.map { it.code.toString(16).padStart(4,'0') }.joinToString("")
private fun quote(value: String): String = buildString { append('"');for(char in value) when(char){'"'->append("\\\"");'\\'->append("\\\\");else->if(char.code<32||char.code>=127)append("\\u"+char.code.toString(16).padStart(4,'0'))else append(char)};append('"') }
private fun attempt(action: () -> String?): String = try { action()?.let { "value:"+units(it) } ?: "null" } catch(error: Throwable) { "failure:${error::class.simpleName}:${units(error.message?:"<null>")}" }
private val malformedContracts=ArrayList<String>()
private val rawMalformedFailures=ArrayList<String>()
private fun observeMalformed(label: String, kind: String, expected: (Throwable)->Boolean, action: ()->Unit) {
    try { action();error("Expected malformed $kind failure at $label") } catch(error: Throwable) {
        check(expected(error)) { "Unexpected malformed failure at $label: ${error::class.simpleName}:${error.message}" }
        malformedContracts.add("$label:$kind")
        rawMalformedFailures.add("$label:${error::class.simpleName}:${units(error.message?:"<null>")}")
    }
}
private fun sameNormalizedAbsolute(first: String,second: String): Boolean = path(first).absoluteFile.normalize()==path(second).absoluteFile.normalize()
private class Location(override val file: String,override val fileIdentity: Any?,override val startLine: Int,override val startChar: Int,override val name: String?,private val events: MutableList<String>): JsLocationWithSource {
    override val sourceProvider: () -> ProbeReader? get() { events.add("get-provider:$file");return { events.add("read-provider:$file");newReader("text:$file\r\n\ud800") } }
    override fun asSimpleLocation(): JsLocation = JsLocation(file,startLine,startChar,name)
}
fun observePaths(): String {
    val records=ArrayList<String>();malformedContracts.clear();rawMalformedFailures.clear()
    val values=listOf("","/","//","///","a","a/","a//b///","./a","a/./b","a/../b","../../x","/../../x","/foo/../C:","C:","C:/../x","a\\b","/a\\b","a:b","./","..","../","/a/../","NUL\u0000x","한글/\ufeffx","a\ud800/b\udfff","foo\r\nbar")
    for(value in values){val f=path(value);records.add("path:${units(value)}:${units(f.path)}:${units(f.name)}:${f.parentFile?.path?.let(::units)}:${f.isAbsolute}:${units(f.absoluteFile.path)}:${units(f.normalize().path)}:${f.hashCode()}")}
    for(parent in values)for(child in values.take(18)){val f=joined(parent,child);records.add("join:${units(parent)}:${units(child)}:${units(f.path)}:${units(f.normalize().path)}")}
    val bases=listOf("/","/a","/a/b","/a/b/c","a",".","../a","/a/./b","/a/x/../b")
    val targets=listOf("/","/a","/a/b","/a/b/c","/a/c/b","/a/x/c","/b/b/c","a",".","../a","/a/../../b","/a/./b","/foo/../C:","C:")
    for(base in bases)for(target in targets){val label="relative:${units(base)}:${units(target)}";if(sameNormalizedAbsolute(base,target))observeMalformed(label,"negative-length",::isExpectedNegativeLength){RelativePathCalculator(path(base)).calculateRelativePathTo(path(target))}else records.add(label+":"+attempt{RelativePathCalculator(path(base)).calculateRelativePathTo(path(target))})}
    for(roots in listOf(emptyList(),listOf("/a"),listOf("/a/"),listOf("/a/./b"),listOf("/a","/a/b"),listOf(".")))for(output in listOf(null,"/","/a",".")){
        val resolver=resolver(roots,output,true)
        for(value in targets){val label="resolve:${roots.joinToString(",") { units(it) }}:${output?.let(::units)}:${units(value)}";if(output!=null&&sameNormalizedAbsolute(output,value))observeMalformed(label,"negative-length",::isExpectedNegativeLength){resolver.getPathRelativeToSourceRoots(path(value))}else records.add(label+":"+attempt{resolver.getPathRelativeToSourceRoots(path(value))})}
    }
    for(roots in listOf(emptyList(),listOf("/a")))for(prefix in listOf("","prefix"))for(output in listOf(null,"/a")){
        val resolver=createResolver(roots,prefix,output,false)
        for(value in targets){val label="create:${roots.joinToString(",")}:${units(prefix)}:$output:${units(value)}";if(roots.isEmpty()&&prefix.isEmpty()&&output!=null&&sameNormalizedAbsolute(output,value))observeMalformed(label,"negative-length",::isExpectedNegativeLength){resolver.getPathRelativeToSourceRoots(path(value))}else records.add(label+":"+attempt{resolver.getPathRelativeToSourceRoots(path(value))})}
    }
    for(first in listOf(false,true))for(include in listOf(false,true)){
        val resolver=resolver(listOf("/a"),null,include);val log=ArrayList<String>()
        val results=listOf("/a/d/one" to first,"/a/d/two" to !first,"/a/d/one" to !first,"/a/e/one" to !first,"/a/Aa/x" to first,"/a/BB/x" to !first,"/a/Aa/y" to !first,"/a/BB/y" to first,"plain" to first,"other" to !first)
            .map { [value,present]->attempt{resolveIfExists(resolver,value,present,log)} }
        records.add("exists:$first:$include:${results.joinToString("|")}:${log.joinToString("|") { units(it) }}")
    }
    for(external in listOf(false,true))for(throwAt in listOf(-1,0,1,2)){
        val events=ArrayList<String>();val consumer=newConsumer(".",recorder(events,throwAt),resolver(emptyList(),null,false),external)
        val outer=Location("src/a.kt","A",1,2,"outer",events);val inner=Location("/a/x.kt","B",3,4,"inner",events)
        val operations=listOf<()->Unit>({consumer.pushSourceInfo(outer)},{consumer.pushSourceInfo(inner)},{consumer.pushDeclarationInfo(JsLocation.IGNORED)},{consumer.pushSourceInfo(null)},{consumer.popSourceInfo()},{consumer.popDeclarationInfo()},{consumer.popSourceInfo()},{consumer.popSourceInfo()},{consumer.newLine()})
        val results=operations.mapIndexed { index,action -> "$index:"+attempt{action();"ok"} }
        records.add("consumer:$external:$throwAt:${results.joinToString("|")}:${events.joinToString("|")}")
        observeMalformed("consumer-underflow:$external:$throwAt","empty-pop",::isExpectedEmptyPop){consumer.popSourceInfo()}
    }
    for(external in listOf(false,true)){
        val events=ArrayList<String>();var column=0;val builder=newBuilder{column};val consumer=newConsumer(".",builder,resolver(emptyList(),null,false),external)
        consumer.pushSourceInfo(Location("source.kt","same",2,3,"value",events));column=5;consumer.pushSourceInfo(Location("source.kt","same",4,1,"other",events));column=9;consumer.popSourceInfo();column=12;consumer.popSourceInfo()
        records.add("builder-consumer:$external:${units(builder.build())}:${events.joinToString("|")}")
    }
    val output=TextOutputImpl();val builder=newBuilder(output::getColumn);val consumer=newConsumer(".",builder,resolver(emptyList(),null,false),false)
    val statement=JsReturn(JsIntLiteral(7));statement.source=JsLocation("visitor.kt",3,2,"seven")
    val function=JsFunction(JsProgram().getRootScope(),JsBlock(statement),"path visitor")
    JsToStringGenerationVisitor(output,consumer).accept(function)
    records.add("real-visitor:${units(output.toString())}:${units(builder.build())}")
    for(enabled in listOf(false,true))for(outputDir in listOf(null,"","/a/","a/../b"))for(roots in listOf(emptyList(),listOf("/a")))for(include in listOf(false,true)) {
        val configuration=makeConfiguration(outputDir,roots,include,enabled)
        val info=SourceMapsInfo.from(configuration)
        records.add("factory:$enabled:${outputDir?.let(::units)}:${roots.joinToString(",")}:$include:${info?.toString()?.let(::units)}:${info?.let { it.hashCode()==it.copy().hashCode() }}")
        val generator=SourceMapGenerator("result",configuration)
        val locations=listOf(SourceLocation.NoLocation,SourceLocation.NextLocation,SourceLocation.DefinedLocation("producer/kotlin-browser/compiler-port/source-map-path-consumer/Probe.kt",2,4),SourceLocation.DefinedLocation("producer/kotlin-browser/compiler-port/source-map-path-consumer/Probe.kt",2,4),SourceLocation.IgnoredLocation,SourceLocation.NextLocation,SourceLocation.DefinedLocation("missing/source.kt",4,9))
        locations.forEachIndexed { index,location -> generator.addSourceLocation(object: SourceLocationMapping(){override val sourceLocation=location;override val generatedLocation=SourceLocation.DefinedLocation("generated",index/3,index*2);override val generatedLocationRelativeToCodeSection=generatedLocation}) }
        records.add("wasm-generator:$enabled:${outputDir?.let(::units)}:${roots.joinToString(",")}:$include:"+attempt{generator.generate()})
        records.add("wasm-debug:${generator.generateDebugInformation().joinToString { it.name+":"+it.data.toString() }}")
        records.add("outlining-print:$enabled:${outputDir?.let(::units)}:${units(printJsCodeWithDebugInfo(function,configuration).toString())}")
    }
    val hostRecords = hostContracts()
    return "{\"hostContracts\":["+hostRecords.joinToString(","){quote(it)}+"],\"records\":["+records.joinToString(",") { quote(it) }+"],\"malformedContracts\":["+malformedContracts.joinToString(","){quote(it)}+"],\"rawFailures\":["+rawMalformedFailures.joinToString(","){quote(it)}+"]}"
}
