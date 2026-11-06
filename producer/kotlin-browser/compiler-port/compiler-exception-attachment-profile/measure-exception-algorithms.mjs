import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL,fileURLToPath} from 'node:url';
const R=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..'),scope=JSON.parse(await readFile(process.argv[2],'utf8')),O=path.join(scope.outputRoot,'exception-algorithms');
const {verifyBootstrap}=await import(pathToFileURL(path.join(R,'producer/kotlin-browser/build/bootstrap.mjs')));
const {readRegular,sha256,writeJson}=await import(pathToFileURL(path.join(R,'producer/kotlin-browser/scripts/source.mjs')));
const execute=promisify(execFile),b=await verifyBootstrap(),flagsFile=path.join(R,'producer/kotlin-browser/compiler-port/build-flags.json'),flagsBytes=await readRegular(flagsFile),flags=JSON.parse(flagsBytes),commands=[],inputs=[{filename:flagsFile,bytes:flagsBytes.length,sha256:sha256(flagsBytes)}],artifacts=[],observed={};await mkdir(O,{mode:0o700});
const id=bytes=>({bytes:bytes.length,sha256:sha256(bytes)});
async function put(relative,bytes){const filename=path.join(O,relative);await mkdir(path.dirname(filename),{recursive:true,mode:0o700});await writeFile(filename,bytes,{flag:'wx',mode:0o600});artifacts.push({filename,...id(bytes)});return filename;}
async function run(phase,cmd,args){const start=performance.now();try{const r=await execute(cmd,args,{cwd:O,maxBuffer:2*1024*1024,timeout:180000});commands.push({phase,argv:[cmd,...args],exitCode:0,elapsedMs:performance.now()-start});if(r.stderr)process.stderr.write(r.stderr);return r.stdout;}catch(e){await writeJson(path.join(O,'failure.json'),{phase,commands,exitCode:e.code,stderr:String(e.stderr??'').slice(-16000)});throw e;}}
const jvm=['-Xmx512m','-cp',b.classPath,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,...flags.compilerFlags],stdlib=b.artifacts.find(r=>r.id==='stdlib-jvm').path;
const targets=['compiler/util/src/org/jetbrains/kotlin/utils/KotlinExceptionWithAttachments.kt','compiler/util/src/org/jetbrains/kotlin/utils/exceptions/KotlinExceptionWithAttachments.kt'];
for(const variant of ['original','common']){
 const original=variant==='original',sources=[];
 for(const logical of targets){const filename=path.join(scope.outputRoot,original?'original':'draft',logical),bytes=await readRegular(filename);inputs.push({filename,...id(bytes)});sources.push(await put(variant+'/'+logical,original?Buffer.from(bytes.toString().replaceAll(/\bcom\.intellij\.(?!platform\.syntax\b)/g,'org.jetbrains.kotlin.com.intellij.')):bytes));}
 if(!original)for(const name of ['CompilerExceptionAttachments.kt','CompilerExceptionHost.kt']){const filename=path.join(scope.outputRoot,'draft',name),bytes=await readRegular(filename);inputs.push({filename,...id(bytes)});sources.push(await put('common/'+name,bytes));}
 const code=String.raw`package exceptionprobe
import org.jetbrains.kotlin.utils.KotlinExceptionWithAttachments as Legacy
import org.jetbrains.kotlin.utils.checkWithAttachment
import org.jetbrains.kotlin.utils.exceptions.KotlinExceptionWithAttachments as Base
import org.jetbrains.kotlin.utils.exceptions.KotlinRuntimeExceptionWithAttachments as Runtime
import org.jetbrains.kotlin.utils.exceptions.KotlinIllegalStateExceptionWithAttachments as State
import org.jetbrains.kotlin.utils.exceptions.KotlinIllegalArgumentExceptionWithAttachments as Argument
${original?'import org.jetbrains.kotlin.com.intellij.openapi.diagnostic.Attachment\nimport java.nio.charset.StandardCharsets':'import org.jetbrains.kotlin.portable.exceptions.*'}
fun units(value:String?):String=if(value==null)"<null>" else value.map{it.code}.joinToString(",")
fun make(kind:Int,message:String?,cause:Throwable?):Throwable=when(kind){0->Legacy(message,cause);1->Runtime(message,cause);2->State(message,cause);else->Argument(message,cause)}
fun bare(kind:Int):Throwable=when(kind){0->Legacy("bare");1->Runtime("bare");2->State("bare");else->Argument("bare")}
fun makeAttachment(path:String,text:String)=${original?'Attachment(path,text)':'newCompilerStringAttachment(path,text)'}
fun decode(attachment:${original?'Attachment':'CompilerExceptionAttachment'}):String=${original?'String(attachment.bytes,StandardCharsets.UTF_8)':'decodeCompilerAttachmentUtf8(attachment)'}
fun snapshot():String {
 val out=StringBuilder()
 for(kind in 0..3){
  val one=bare(kind);val base=one as Base;check(base.getAttachments().isEmpty());check(one.cause==null);check(one.message=="bare")
  when(kind){0,1->check(one is RuntimeException);2->check(one is IllegalStateException);3->check(one is IllegalArgumentException)}
  out.append("bare/").append(kind).append('\t').append(units(one.message)).append('\t').append(base.getAttachments().size).append('\n')
  val nulls=make(kind,null,null);check(nulls.message==null);check(nulls.cause==null);check((nulls as Base).getAttachments().isEmpty())
  out.append("null/").append(kind).append('\t').append(units(nulls.message)).append('\t').append(nulls.getAttachments().size).append('\n')
  val cause=IllegalStateException("plain")
  val plain=make(kind,"wrapped",cause);check(plain.cause===cause)
  val plainA=(plain as Base).getAttachments();check(plainA.size==1);check(plainA.single().path=="causeThrowable");check(plainA.single().displayText==cause.stackTraceToString())
  out.append("cause-trace/local/").append(kind).append("\ttrue\n")
  val owned=make(kind,"owned",null);val ownedA=owned as Base
  check(ownedA.withAttachment("null",null)===ownedA)
  check(ownedA.withAttachment("text",object{override fun toString()="a\uD800b한글😀"})===ownedA)
  ownedA.mutableAttachments.add(makeAttachment("direct/한글","\uDC00\uD800"))
  val before=ownedA.getAttachments();check(before.size==3);check(before[0].displayText=="<null>");check(before[1].displayText=="a\uD800b한글😀");check(before!==ownedA.getAttachments())
  before[0]=makeAttachment("mutated","other");check(ownedA.getAttachments()[0].path=="null")
  for(a in ownedA.getAttachments()){val first=a.bytes;val expected=first.copyOf();if(first.isNotEmpty())first[0]=0;check(a.bytes.contentEquals(expected));check(first!==a.bytes);out.append("owned/").append(kind).append('/').append(a.path).append('\t').append(units(a.displayText)).append('\t').append(a.bytes.joinToString(",")).append('\n')}
  val copied=make(kind,null,owned);check(copied.cause===owned);val copies=(copied as Base).getAttachments();check(copies.size==4)
  for(i in 0..2){check(copies[i].path=="case_"+ownedA.getAttachments()[i].path);check(copies[i].displayText==decode(ownedA.getAttachments()[i]));out.append("copy/").append(kind).append('/').append(copies[i].path).append('\t').append(units(copies[i].displayText)).append('\t').append(copies[i].bytes.joinToString(",")).append('\n')}
  check(copies[3].path=="causeThrowable");check(copies[3].displayText==owned.stackTraceToString())
  out.append("copy-trace/local/").append(kind).append("\ttrue\n")
  val nested=make(kind,"nested",copied);val nestedA=(nested as Base).getAttachments();check(nestedA.size==5)
  for(i in 0..2){check(nestedA[i].path=="case_case_"+ownedA.getAttachments()[i].path);out.append("nested/").append(kind).append('/').append(nestedA[i].path).append('\t').append(units(nestedA[i].displayText)).append('\t').append(nestedA[i].bytes.joinToString(",")).append('\n')}
  check(nestedA[3].path=="case_causeThrowable");check(nestedA[3].displayText==decode(copies[3]));check(nestedA[4].path=="causeThrowable");check(nestedA[4].displayText==copied.stackTraceToString())
  out.append("nested-trace/local/").append(kind).append("\ttrue\n")
 }
 var messages=0;var attachments=0
 checkWithAttachment(true,{messages++;"bad"},{attachments++;it.withAttachment("bad",null)})
 check(messages==0&&attachments==0)
 try{checkWithAttachment(false,{messages++;"failure"},{attachments++;it.withAttachment("contract",null)});error("expected failure")}catch(e:Legacy){check(messages==1&&attachments==1);check(e.message=="failure");check(e.getAttachments().single().path=="contract");check(e.getAttachments().single().displayText=="<null>")}
 out.append("checkWithAttachment/true-lazy-false-once\ttrue\n")
 return out.toString()
}
${original?'':String.raw`fun uninstalledSnapshot():String {
 check(!compilerExceptionHostInstalled())
 var bytesRead=0
 val alien=object:Throwable("external"),Base {
  override val mutableAttachments=mutableListOf<CompilerExceptionAttachment>(object:CompilerExceptionAttachment{
   override val path="external";override val displayText="binary"
   override val bytes:ByteArray get(){bytesRead++;return byteArrayOf(-19,-96,-128)}
  })
 }
 for(kind in 0..3){try{make(kind,"wrapped",alien);error("external decoder required")}catch(e:CompilerExceptionHostRequired){check(bytesRead==0)}}
 check(!compilerExceptionHostInstalled())
 return "external-throwable/full-four-constructors-deny-before-byte-read\ttrue\nno-host-installed\ttrue\n"
}`}
`;
 sources.push(await put(variant+'/Probe.kt',Buffer.from(code)));
 const jvmEntry=await put(variant+'/JvmEntry.kt',Buffer.from('package exceptionprobe\nfun main(){print(snapshot())}\n')),jar=path.join(O,variant+'.jar');
 await run(variant+'-complete-exception-algorithms-jvm-build','java',[...jvm,'-classpath',original?b.classPath:stdlib,...(!original?['-Xmulti-platform','-Xcommon-sources='+sources.join(',')]:[]),'-d',jar,...sources,jvmEntry]);
 observed[variant]=await run(variant+'-complete-exception-algorithms-jvm-execute','java',['-ea','-cp',jar+path.delimiter+(original?b.classPath:stdlib),'exceptionprobe.JvmEntryKt']);await put(variant+'-observations.txt',Buffer.from(observed[variant]));
 if(!original){
  assert.equal(observed.common,observed.original);
  const entry=await put('WasmEntry.kt',Buffer.from('@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class)\npackage exceptionprobe\n@kotlin.js.JsExport fun exceptionSnapshot():String=snapshot()\n@kotlin.js.JsExport fun uninstalledExceptionSnapshot():String=uninstalledSnapshot()\n'));
  await mkdir(path.join(O,'klib'));await mkdir(path.join(O,'wasm'));
  const wasm=['-Xmx512m','-cp',b.classPath,'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler','-Xwasm-target=wasm-js','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,'-libraries',b.wasmJsStdlib,...flags.compilerFlags];
  await run('complete-common-exception-algorithms-wasm-klib','java',[...wasm,'-Xmulti-platform','-Xcommon-sources='+sources.join(','),'-Xir-produce-klib-file','-ir-output-dir',path.join(O,'klib'),'-ir-output-name','exceptions',...sources,entry]);
  await run('complete-common-exception-algorithms-wasm-binary','java',[...wasm,'-Xir-produce-js','-Xinclude='+path.join(O,'klib/exceptions.klib'),'-ir-output-dir',path.join(O,'wasm'),'-ir-output-name','exceptions','-main','noCall']);
  const url=pathToFileURL(path.join(O,'wasm/exceptions.mjs')).href;
  observed.wasm=await run('actual-node-wasm-complete-exception-algorithms',process.execPath,['--experimental-wasm-exnref','--input-type=module','-e','const m=await import(process.argv[1]);process.stdout.write(m.exceptionSnapshot());',url]);assert.equal(observed.wasm,observed.original);await put('wasm-observations.txt',Buffer.from(observed.wasm));
  observed.required=await run('actual-node-wasm-full-exception-constructors-uninstalled-external-host',process.execPath,['--experimental-wasm-exnref','--input-type=module','-e','const m=await import(process.argv[1]);process.stdout.write(m.uninstalledExceptionSnapshot());',url]);await put('required-boundary-observations.txt',Buffer.from(observed.required));
 }
}
for(const relative of ['original.jar','common.jar','klib/exceptions.klib',...(await readdir(path.join(O,'wasm'))).map(n=>'wasm/'+n)])artifacts.push({filename:path.join(O,relative),...id(await readRegular(path.join(O,relative)))});
const result={kind:'private-complete-retained-exception-algorithm-differential',result:'pass',completeRetainedClasses:4,records:observed.original.trimEnd().split('\n').length,comparison:{originalJvmSha256:sha256(Buffer.from(observed.original)),commonJvmSha256:sha256(Buffer.from(observed.common)),nodeWasmSha256:sha256(Buffer.from(observed.wasm)),rawOutputNormalization:false},localCauseStackTraceContract:true,crossPlatformCauseStackTraceBytesCompared:false,requiredBoundaryRecords:observed.required.trimEnd().split('\n').length,commands,inputs,artifacts,bootstrap:b.artifacts,constructorNullContentCopyPrefixArrayAndLazyThrowExecuted:true,psiMethodExecuted:false,fullPortableAnalysisAndFirWrappersExecuted:false,generalMalformedBinaryFileAttachmentParity:false,externalThrowableDecodeUninstalledAndExplicit:true,fatalHostUninstalled:true,shippingEdits:false,fullCompilerBuilt:false};await writeJson(path.join(O,'result.json'),result);console.log(JSON.stringify({outputRoot:O,result:'pass',records:result.records,requiredBoundaryRecords:result.requiredBoundaryRecords}));
