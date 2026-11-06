import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL,fileURLToPath} from 'node:url';
const cfg=JSON.parse(await readFile(process.argv[2],'utf8')),R=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..'),D=path.join(R,'producer/kotlin-browser/compiler-port/compiler-exception-attachment-profile'),O=cfg.outputRoot;
const {verifyBootstrap}=await import(pathToFileURL(path.join(R,'producer/kotlin-browser/build/bootstrap.mjs'))),{readRegular,sha256,writeJson}=await import(pathToFileURL(path.join(R,'producer/kotlin-browser/scripts/source.mjs'))),{transform}=await import(pathToFileURL(path.join(D,'transform.mjs')));
const b=await verifyBootstrap(),lock=JSON.parse(await readRegular(path.join(D,'sources.lock.json'))),flags=JSON.parse(await readRegular(path.join(R,'producer/kotlin-browser/compiler-port/build-flags.json'))),logical='compiler/util/src/org/jetbrains/kotlin/utils/exceptions/platformExceptionUtils.kt',original=await readRegular(path.join(cfg.sourceRoot,logical)),execute=promisify(execFile),inputs=[],artifacts=[],commands=[],out={};await mkdir(O,{mode:0o700});const id=bytes=>({bytes:bytes.length,sha256:sha256(bytes)});
async function put(relative,bytes){const filename=path.join(O,relative);await mkdir(path.dirname(filename),{recursive:true,mode:0o700});await writeFile(filename,bytes,{flag:'wx',mode:0o600});artifacts.push({filename,...id(bytes)});return filename;}
async function run(phase,cmd,args){const start=performance.now();try{const r=await execute(cmd,args,{cwd:O,timeout:180000,maxBuffer:2*1024*1024});commands.push({phase,argv:[cmd,...args],exitCode:0,elapsedMs:performance.now()-start});return r.stdout;}catch(e){await writeJson(path.join(O,'failure.json'),{phase,commands,stderr:String(e.stderr??'').slice(-14000)});throw e;}}
const jvm=['-Xmx512m','-cp',b.classPath,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,...flags.compilerFlags],stdlib=b.artifacts.find(r=>r.id==='stdlib-jvm').path;
for(const variant of ['original','common']){
 const isOriginal=variant==='original',sources=[await put(variant+'/platformExceptionUtils.kt',isOriginal?Buffer.from(original.toString().replaceAll(/\bcom\.intellij\.(?!platform\.syntax\b)/g,'org.jetbrains.kotlin.com.intellij.')):transform(original,lock.changes[logical]))];
 if(!isOriginal){const filename=path.join(D,'CompilerExceptionHost.kt'),bytes=await readRegular(filename);inputs.push({filename,...id(bytes)});sources.push(await put('common/CompilerExceptionHost.kt',bytes));}
 if(!isOriginal){const filename=path.join(D,'RequestHostProbe.kt'),bytes=await readRegular(filename);inputs.push({filename,...id(bytes)});sources.push(await put('common/RequestHostProbe.kt',bytes));const attachment=path.join(D,'CompilerExceptionAttachments.kt'),attachmentBytes=await readRegular(attachment);inputs.push({filename:attachment,...id(attachmentBytes)});sources.push(await put('common/CompilerExceptionAttachments.kt',attachmentBytes));}
 const probe=String.raw`package policyprobe
import org.jetbrains.kotlin.utils.exceptions.shouldIjPlatformExceptionBeRethrown
import org.jetbrains.kotlin.utils.exceptions.rethrowIntellijPlatformExceptionIfNeeded
import kotlin.coroutines.cancellation.CancellationException
${isOriginal?'':'import org.jetbrains.kotlin.portable.exceptions.*'}
val events=mutableListOf<String>()
fun snapshot(cases:List<Pair<String,Throwable>>,vm:(Throwable)->Boolean):String {
 val out=StringBuilder()
 for(item in cases){
  val name=item.first;val t=item.second
  events.clear();val should=shouldIjPlatformExceptionBeRethrown(t)
  ${isOriginal?'':String.raw`check(events==when(name){"cancel","process"->emptyList();"control"->listOf("control");else->listOf("control","index")})`}
  val thrown=try{rethrowIntellijPlatformExceptionIfNeeded(t);false}catch(e:Throwable){check(e===t);true}
  check(should==thrown);out.append(name).append('\t').append(should).append('\t').append(thrown).append('\t').append(vm(t)).append('\n')
 }
 return out.toString()
}
${isOriginal?'':String.raw`fun uninstalledSnapshot():String {
 check(!compilerExceptionHostInstalled());val cancelled=CancellationException("cancel")
 check(shouldIjPlatformExceptionBeRethrown(cancelled));try{rethrowIntellijPlatformExceptionIfNeeded(cancelled);error("expected cancellation")}catch(e:CancellationException){check(e===cancelled)}
 fun denied(action:()->Unit):Boolean=try{action();false}catch(e:CompilerExceptionHostRequired){true}
 check(denied{shouldIjPlatformExceptionBeRethrown(IllegalStateException("plain"))});check(denied{rethrowIntellijPlatformExceptionIfNeeded(IllegalStateException("plain"))});check(denied{isVirtualMachineError(IllegalStateException("plain"))});check(!compilerExceptionHostInstalled())
 return "complete-platform/cancellation-shortcut-and-throw-identity\ttrue\ncomplete-platform/plain-classification-requires-host\ttrue\ncomplete-platform/plain-rethrow-requires-host\ttrue\nfatal-policy-requires-host\ttrue\nno-shipping-or-wasm-host-installed\ttrue\n"
}`}
`;
 sources.push(await put(variant+'/Probe.kt',Buffer.from(probe)));
 const entry=String.raw`package policyprobe
import org.jetbrains.kotlin.com.intellij.openapi.diagnostic.ControlFlowException
import org.jetbrains.kotlin.com.intellij.openapi.progress.ProcessCanceledException
import org.jetbrains.kotlin.com.intellij.openapi.project.IndexNotReadyException
import java.nio.charset.StandardCharsets
import kotlin.coroutines.cancellation.CancellationException
${isOriginal?'':'import org.jetbrains.kotlin.portable.exceptions.*'}
class GenuineControlMarker:RuntimeException("control"),ControlFlowException
class GenuineVmSubclass:VirtualMachineError("fatal")
${isOriginal?'':String.raw`class GenuineJvmPolicy:CompilerExceptionHost {
 override fun isVirtualMachineError(throwable:Throwable):Boolean=throwable is VirtualMachineError
 override fun isControlFlowException(throwable:Throwable):Boolean{events.add("control");return throwable is ControlFlowException}
 override fun isIndexNotReadyException(throwable:Throwable):Boolean{events.add("index");return throwable is IndexNotReadyException}
 override fun decodeExternalAttachmentUtf8(bytes:ByteArray):String=String(bytes,StandardCharsets.UTF_8)
}`}
fun main(){
 ${isOriginal?'':'check(!compilerExceptionHostInstalled());withCompilerExceptionHost(GenuineJvmPolicy()) {'}
 val cases=listOf("cancel" to CancellationException("cancel"),"control" to GenuineControlMarker(),"process" to ProcessCanceledException(),"plain" to IllegalStateException("plain"),"vm" to GenuineVmSubclass())
 print(snapshot(cases,{t->${isOriginal?'t is VirtualMachineError':'isVirtualMachineError(t)'}}))
 ${isOriginal?'':'};check(!compilerExceptionHostInstalled())'}
}
`;
 const jvmEntry=await put(variant+'/JvmEntry.kt',Buffer.from(entry)),jar=path.join(O,variant+'.jar');await run(variant+'-complete-platform-jvm-build','java',[...jvm,'-classpath',b.classPath,...(!isOriginal?['-Xmulti-platform','-Xcommon-sources='+sources.join(',')]:[]),'-d',jar,...sources,jvmEntry]);out[variant]=await run(variant+'-genuine-platform-jvm-policy','java',['-ea','-cp',jar+path.delimiter+b.classPath,'policyprobe.JvmEntryKt']);await put(variant+'-observations.txt',Buffer.from(out[variant]));
 if(!isOriginal){assert.equal(out.common,out.original);const hostEntry=await put('common/HostEntry.kt',Buffer.from('package policyprobe\nobject HostEntry { @JvmStatic fun main(args:Array<String>) { print(requestHostSnapshot()) } }\n'));await run('request-scoped-host-jvm-build','java',[...jvm,'-classpath',b.classPath,'-Xmulti-platform','-Xcommon-sources='+sources.join(','),'-d',path.join(O,'host.jar'),...sources,hostEntry]);out.hostJvm=await run('request-scoped-host-jvm-execution','java',['-ea','-cp',path.join(O,'host.jar')+path.delimiter+b.classPath,'policyprobe.HostEntry']);await put('host-jvm-observations.txt',Buffer.from(out.hostJvm));const wasmEntry=await put('WasmEntry.kt',Buffer.from('@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class)\npackage policyprobe\n@kotlin.js.JsExport fun policySnapshot():String=uninstalledSnapshot()\n@kotlin.js.JsExport fun requestPolicySnapshot():String=requestHostSnapshot()\n'));await mkdir(path.join(O,'klib'));await mkdir(path.join(O,'wasm'));const wasm=['-Xmx512m','-cp',b.classPath,'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler','-Xwasm-target=wasm-js','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,'-libraries',b.wasmJsStdlib,...flags.compilerFlags];await run('complete-common-platform-wasm-klib','java',[...wasm,'-Xmulti-platform','-Xcommon-sources='+sources.join(','),'-Xir-produce-klib-file','-ir-output-dir',path.join(O,'klib'),'-ir-output-name','policy',...sources,wasmEntry]);await run('complete-common-platform-wasm-binary','java',[...wasm,'-Xir-produce-js','-Xinclude='+path.join(O,'klib/policy.klib'),'-ir-output-dir',path.join(O,'wasm'),'-ir-output-name','policy','-main','noCall']);out.wasm=await run('actual-node-wasm-complete-platform-uninstalled-host-controls',process.execPath,['--experimental-wasm-exnref','--input-type=module','-e','const m=await import(process.argv[1]);process.stdout.write(m.policySnapshot());',pathToFileURL(path.join(O,'wasm/policy.mjs')).href]);await put('wasm-observations.txt',Buffer.from(out.wasm));out.hostWasm=await run('actual-node-wasm-request-scoped-host',process.execPath,['--experimental-wasm-exnref','--input-type=module','-e','const m=await import(process.argv[1]);process.stdout.write(m.requestPolicySnapshot());',pathToFileURL(path.join(O,'wasm/policy.mjs')).href]);assert.equal(out.hostWasm,out.hostJvm);await put('host-wasm-observations.txt',Buffer.from(out.hostWasm));}
}
for(const relative of ['original.jar','common.jar','host.jar','klib/policy.klib',...(await readdir(path.join(O,'wasm'))).map(n=>'wasm/'+n)])artifacts.push({filename:path.join(O,relative),...id(await readRegular(path.join(O,relative)))});
const result={kind:'complete-platform-exception-policy-observation',result:'pass',jvmRecords:out.original.trimEnd().split('\n').length,jvmComparison:{originalJvmSha256:sha256(Buffer.from(out.original)),commonJvmWithGenuineJvmHostSha256:sha256(Buffer.from(out.common)),rawOutputNormalization:false},wasmUninstalledHostRecords:out.wasm.trimEnd().split('\n').length,fullOriginalAndSelectedCommonPlatformBody:true,genuineJvmHostOnlyInIsolatedObserver:true,jvmCancellationControlProcessPlainVmInputs:true,positiveIndexNotReadyInstanceExecuted:false,indexPredicateBoundToGenuineArtifactAndItsCallPositionTested:true,cancellationShortcutArmOrderThrowIdentityVerified:true,browserFatalTaxonomyParityClaimed:false,requestScopedHostExecuted:true,hostRecords:out.hostWasm.trimEnd().split('\n').length,hostJvmSha256:sha256(Buffer.from(out.hostJvm)),hostWasmSha256:sha256(Buffer.from(out.hostWasm)),browserCompilerExecuted:false,fullCompilerBuilt:false,commands,inputs,artifacts,bootstrap:b.artifacts};await writeJson(path.join(O,'result.json'),result);console.log(JSON.stringify({result:'pass',jvmRecords:result.jvmRecords,wasmRequiredHostRecords:result.wasmUninstalledHostRecords}));
