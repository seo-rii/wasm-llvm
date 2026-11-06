import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL,fileURLToPath} from 'node:url';
const R=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..'),scope=JSON.parse(await readFile(process.argv[2],'utf8')),O=path.join(scope.outputRoot,'string-contract');
const {verifyBootstrap}=await import(pathToFileURL(path.join(R,'producer/kotlin-browser/build/bootstrap.mjs')));
const {readRegular,sha256,writeJson}=await import(pathToFileURL(path.join(R,'producer/kotlin-browser/scripts/source.mjs')));
const execute=promisify(execFile),bootstrap=await verifyBootstrap(),flagsBytes=await readRegular(path.join(R,'producer/kotlin-browser/compiler-port/build-flags.json')),flags=JSON.parse(flagsBytes),commands=[],inputs=[],artifacts=[],observed={};await mkdir(O,{mode:0o700});
const id=b=>({bytes:b.length,sha256:sha256(b)});
async function put(relative,bytes){const filename=path.join(O,relative);await mkdir(path.dirname(filename),{recursive:true,mode:0o700});await writeFile(filename,bytes,{flag:'wx',mode:0o600});artifacts.push({filename,...id(bytes)});return filename;}
async function run(phase,cmd,args){const start=performance.now();try{const r=await execute(cmd,args,{cwd:O,maxBuffer:2*1024*1024,timeout:180000});commands.push({phase,argv:[cmd,...args],exitCode:0,elapsedMs:performance.now()-start});if(r.stderr)process.stderr.write(r.stderr);return r.stdout;}catch(e){await writeJson(path.join(O,'failure.json'),{phase,commands,exitCode:e.code,stderr:String(e.stderr??'').slice(-12000)});throw e;}}
const jvm=['-Xmx512m','-cp',bootstrap.classPath,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,...flags.compilerFlags],stdlib=bootstrap.artifacts.find(r=>r.id==='stdlib-jvm').path;
for(const variant of ['original','common']){
 const original=variant==='original',imports=original?'import org.jetbrains.kotlin.com.intellij.openapi.diagnostic.Attachment\nimport java.nio.charset.StandardCharsets':'import org.jetbrains.kotlin.portable.exceptions.*';
 const code=String.raw`package attachmentprobe
${imports}
fun units(value:String):String=value.map{it.code}.joinToString(",")
fun snapshot():String {
 val out=StringBuilder()
 val strings=listOf("","ascii","한글","😀","\uD800","\uDC00","a\uD800b","\uDC00\uD800","\uD800\uD800\uDC00","\uD800\uDC00","\uD800x\uDC00")
 strings.forEachIndexed{i,s->
  val attachment=${original?'Attachment("p/한글.txt",s)':'newCompilerStringAttachment("p/한글.txt",s)'}
  check(attachment.path=="p/한글.txt");check(attachment.displayText==s)
  val first=attachment.bytes;val expected=first.copyOf();if(first.isNotEmpty())first[0]=1
  check(attachment.bytes.contentEquals(expected));check(first!==attachment.bytes)
  val copiedText=${original?'String(attachment.bytes,StandardCharsets.UTF_8)':'decodeCompilerAttachmentUtf8(attachment)'}
  val copied=${original?'Attachment("case_"+attachment.path,copiedText)':'newCompilerStringAttachment("case_"+attachment.path,copiedText)'}
  out.append("string/").append(i).append('\t').append(units(attachment.displayText)).append('\t').append(attachment.bytes.joinToString(",")).append('\t').append(units(copied.displayText)).append('\t').append(copied.bytes.joinToString(",")).append('\t').append(copied.path).append('\t').append(attachment.toString()).append('\n')
 }
 val large=${original?'Attachment("large","a".repeat(100000))':'newCompilerStringAttachment("large","a".repeat(100000))'};check(large.bytes.size==100000);out.append("large\t").append(large.bytes.size).append('\n')
 return out.toString()
}
${original?'':String.raw`fun requiredBoundarySnapshot():String {
 check(!compilerExceptionHostInstalled())
 var bytesRead=0
 val external=object:CompilerExceptionAttachment{
  override val path="external"
  override val displayText="external bytes"
  override val bytes:ByteArray get(){bytesRead++;return byteArrayOf(-19,-96,-128)}
 }
 fun denied(action:()->Unit):Boolean=try{action();false}catch(e:CompilerExceptionHostRequired){true}
 check(denied{decodeCompilerAttachmentUtf8(external)});check(bytesRead==0)
 check(denied{isVirtualMachineError(IllegalStateException("x"))})
 check(denied{isControlFlowException(IllegalStateException("x"))})
 check(denied{isIndexNotReadyException(IllegalStateException("x"))})
 check(!compilerExceptionHostInstalled())
 return "external-decoder-required-before-byte-read\ttrue\nfatal-control-index-host-required\ttrue\nno-host-installed\ttrue\n"
}`}
`;
 const source=await put(variant+'/Probe.kt',Buffer.from(code)),sources=[source];
 if(!original)for(const name of ['CompilerExceptionAttachments.kt','CompilerExceptionHost.kt']){const filename=path.join(scope.outputRoot,'draft',name),bytes=await readRegular(filename);inputs.push({filename,...id(bytes)});sources.push(await put('common/'+name,bytes));}
 const jvmEntry=await put(variant+'/JvmEntry.kt',Buffer.from('package attachmentprobe\nfun main(){print(snapshot())}\n')),jar=path.join(O,variant+'.jar');
 await run(variant+'-string-contract-jvm-build','java',[...jvm,'-classpath',original?bootstrap.classPath:stdlib,...(!original?['-Xmulti-platform','-Xcommon-sources='+sources.join(',')]:[]),'-d',jar,...sources,jvmEntry]);
 observed[variant]=await run(variant+'-string-contract-jvm-observe','java',['-ea','-cp',jar+path.delimiter+(original?bootstrap.classPath:stdlib),'attachmentprobe.JvmEntryKt']);await put(variant+'-observations.txt',Buffer.from(observed[variant]));
 if(!original){
  assert.equal(observed.common,observed.original);const entry=await put('WasmEntry.kt',Buffer.from('@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class)\npackage attachmentprobe\n@kotlin.js.JsExport fun attachmentSnapshot():String=snapshot()\n@kotlin.js.JsExport fun requiredSnapshot():String=requiredBoundarySnapshot()\n'));
  await mkdir(path.join(O,'klib'));await mkdir(path.join(O,'wasm'));
  const wasm=['-Xmx512m','-cp',bootstrap.classPath,'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler','-Xwasm-target=wasm-js','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,'-libraries',bootstrap.wasmJsStdlib,...flags.compilerFlags];
  await run('common-string-contract-wasm-klib','java',[...wasm,'-Xmulti-platform','-Xcommon-sources='+sources.join(','),'-Xir-produce-klib-file','-ir-output-dir',path.join(O,'klib'),'-ir-output-name','attachments',...sources,entry]);
  await run('common-string-contract-wasm-binary','java',[...wasm,'-Xir-produce-js','-Xinclude='+path.join(O,'klib/attachments.klib'),'-ir-output-dir',path.join(O,'wasm'),'-ir-output-name','attachments','-main','noCall']);
  const url=pathToFileURL(path.join(O,'wasm/attachments.mjs')).href;
  observed.wasm=await run('actual-node-wasm-string-contract-observe',process.execPath,['--experimental-wasm-exnref','--input-type=module','-e','const m=await import(process.argv[1]);process.stdout.write(m.attachmentSnapshot());',url]);assert.equal(observed.wasm,observed.original);await put('wasm-observations.txt',Buffer.from(observed.wasm));
  observed.required=await run('actual-node-wasm-uninstalled-required-boundaries',process.execPath,['--experimental-wasm-exnref','--input-type=module','-e','const m=await import(process.argv[1]);process.stdout.write(m.requiredSnapshot());',url]);await put('required-boundary-observations.txt',Buffer.from(observed.required));
 }
}
for(const relative of ['original.jar','common.jar','klib/attachments.klib',...(await readdir(path.join(O,'wasm'))).map(n=>'wasm/'+n)])artifacts.push({filename:path.join(O,relative),...id(await readRegular(path.join(O,relative)))});
const result={kind:'private-selected-string-attachment-contract-differential',result:'pass',records:observed.original.trimEnd().split('\n').length,comparison:{originalJvmSha256:sha256(Buffer.from(observed.original)),commonJvmSha256:sha256(Buffer.from(observed.common)),nodeWasmSha256:sha256(Buffer.from(observed.wasm)),rawOutputNormalization:false},requiredBoundaryRecords:observed.required.trimEnd().split('\n').length,commands,inputs,artifacts,bootstrap:bootstrap.artifacts,preservedPathDisplayFreshBytesAndCopy:true,generalMalformedBinaryFileAttachmentParity:false,externalDecodeUninstalledAndExplicit:true,fatalHostUninstalled:true,shippingEdits:false,fullCompilerBuilt:false};await writeJson(path.join(O,'result.json'),result);console.log(JSON.stringify({outputRoot:O,result:'pass',records:result.records,requiredBoundaryRecords:result.requiredBoundaryRecords}));
