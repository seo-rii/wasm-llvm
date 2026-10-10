package org.jetbrains.kotlin.js.sourcemappathprobe

import org.jetbrains.kotlin.config.CompilerConfiguration
import org.jetbrains.kotlin.js.config.JSConfigurationKeys
import org.jetbrains.kotlin.ir.backend.js.SourceMapsInfo
import org.jetbrains.kotlin.js.portable.sourcemap.*

/** New explicit request contract, separate from original global native File/System effects. */
@OptIn(CompilerConfiguration.Internals::class)
fun observeVirtualPathHostContracts(): List<String> {
    val records=ArrayList<String>();val events=ArrayList<String>()
    fun host(cwd: String,output: String?,label: String,present: Boolean)=SourceMapPathHost(cwd,{events.add("$label:exists:${it.path}");present},object:SourceMapEmbeddingDiagnostics{
        override fun println(message: String){events.add("$label:banner:$message")}
        override fun reportThrowable(failure: Throwable){events.add("$label:report:${failure.message}")}
    },output)
    val first=host("/requestA","first/output","A",true);val second=host("/requestB",null,"B",false)
    val configuration=CompilerConfiguration();val other=CompilerConfiguration()
    check(SourceMapsInfo.from(other)==null);records.add("disabled-without-host:true")
    other.put(JSConfigurationKeys.SOURCE_MAP,true)
    val missing=try{SourceMapsInfo.from(other);false}catch(error:IllegalArgumentException){error.message=="Source map path host is not installed for this request"}
    check(missing);records.add("enabled-without-host:true")
    configuration.put(JSConfigurationKeys.SOURCE_MAP,true);installRequestSourceMapPathHost(configuration,first)
    val captured=requestSourceMapPathHost(configuration);val info=SourceMapsInfo.from(configuration)!!;val path=captured.path("x")
    installRequestSourceMapPathHost(configuration,second)
    check(captured===first&&requestSourceMapPathHost(configuration)===second)
    check(path.absoluteFile.path=="/requestA/x"&&second.path("x").absoluteFile.path=="/requestB/x")
    check(path.exists()&&!second.path("x").exists())
    check(info.outputDir?.path=="first/output"&&SourceMapsInfo.from(configuration)!!.outputDir==null)
    records.add("captured-request-path-and-output:true")
    val copy=configuration.copy();check(requestSourceMapPathHost(copy)===second);installRequestSourceMapPathHost(copy,first)
    check(requestSourceMapPathHost(configuration)===second&&requestSourceMapPathHost(copy)===first);records.add("configuration-copy-isolation:true")
    captured.builderHost.diagnostics.println("one");requestSourceMapPathHost(configuration).builderHost.diagnostics.reportThrowable(SourceMapIoFailure("two"))
    check(events==listOf("A:exists:x","B:exists:x","A:banner:one","B:report:two"));records.add("captured-presence-diagnostic-effects:"+events.joinToString("|"))
    val bad=try{host("relative",null,"bad",false);false}catch(error:IllegalArgumentException){error.message=="Source map working directory must be absolute"}
    check(bad);records.add("relative-working-directory-rejected:true")
    val before=events.size;check(!first.path("bad\u0000name").exists());check(events.size==before);records.add("nul-path-does-not-call-presence:true")
    return records
}
