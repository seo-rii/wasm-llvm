import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir,writeFile,readdir} from 'node:fs/promises';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readRegular,sha256,writeJson} from '../../scripts/source.mjs';
import {verifyBootstrap} from '../../build/bootstrap.mjs';
import {moduleRequirePathFixture} from './fixture.mjs';
import {prepareModuleRequirePaths,verifyModuleRequirePaths,reconstructModuleRequirePathPredecessorSelection} from './prepare.mjs';
import {modulePathReferences} from './references.mjs';
import {projectRequireMethod} from './project.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..'),execute=promisify(execFile);
const root=path.resolve(process.argv[2]);assert(root.startsWith(path.join(REPO,'out')+path.sep));await mkdir(root,{mode:0o700});
const options=await moduleRequirePathFixture(path.join(root,'profile')),component=await prepareModuleRequirePaths(options);await verifyModuleRequirePaths(options);
const after=options.retainedSources.map(pin=>{const output=component.receipt.files.find(x=>x.path===pin.path);return output?{path:pin.path,filename:path.join(component.outputRoot,pin.path),bytes:output.bytes,sha256:output.sha256}:pin;});
const helper=component.receipt.files.at(-1);after.push({path:helper.path,filename:path.join(component.outputRoot,helper.path),bytes:helper.bytes,sha256:helper.sha256});
const final=await reconstructModuleRequirePathPredecessorSelection({...options,retainedSources:after});await writeJson(path.join(root,'fixture.json'),{options,component,after,final});
const bootstrap=await verifyBootstrap(),flagsBytes=await readRegular(path.join(HERE,'../build-flags.json')),flags=JSON.parse(flagsBytes),ast=JSON.parse(await readRegular(path.join(HERE,'../js-ast/evidence/receipt.json')));
const originalCmd=ast.commands.find(x=>x.phase==='actual-original-jvm-observe').command,commonCmd=ast.commands.find(x=>x.phase==='portable-common-jvm-observe').command;
const originalAst=originalCmd[originalCmd.indexOf('-cp')+1],commonAst=commonCmd[commonCmd.indexOf('-cp')+1];
const previous=JSON.parse(await readRegular(path.join(HERE,'../serializer-output-bindings/evidence/runtime.json'))),previousRoot=path.join(REPO,previous.artifactRoot);
const commands=[];async function put(name,b){const f=path.join(root,name);await mkdir(path.dirname(f),{recursive:true,mode:0o700});await writeFile(f,b,{flag:'wx',mode:0o600});return f;}
async function run(phase,exe,args){console.log('phase:'+phase);const start=performance.now();try{const r=await execute(exe,args,{cwd:REPO,timeout:900000,maxBuffer:48*1024*1024});commands.push({phase,command:[exe,...args],exitCode:0,elapsedMs:performance.now()-start});await put('commands/'+commands.length+'-stderr.txt',Buffer.from(r.stderr));if(r.stderr)process.stderr.write(r.stderr);return r.stdout;}catch(e){process.stderr.write(String(e.stderr??'').slice(-18000));throw new Error(phase+' '+JSON.stringify({code:e.code,signal:e.signal,killed:e.killed}));}}
const version=await run('genuine-jvm-runtime-version','java',['--version']);assert(version.startsWith('openjdk 17.0.20.1 '));await put('JvmVersion.txt',Buffer.from(version));
const java=['-Xmx768m','-cp',bootstrap.classPath],jvm=[...java,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,...flags.compilerFlags];
const observer=await put('ModuleProbe.kt',await readRegular(path.join(HERE,'ModuleProbe.kt'))),corpusText=(await readRegular(path.join(HERE,'Probe.kt'))).toString();
const corpus=await put('ModuleCorpus.kt',Buffer.from(corpusText.slice(0,corpusText.indexOf('fun pathRaw()'))));
const originalObserver=path.join(root,'original-observer.jar');await run('genuine-original-full-module-observer-jvm-build','java',[...jvm,'-classpath',[path.join(previousRoot,'original.jar'),originalAst,bootstrap.classPath].join(path.delimiter),'-d',originalObserver,observer,corpus]);
const genuine=[];for(const f of options.preparedCommentTypeNames.commonSources){const selected=component.commonSources.find(x=>x.endsWith('/'+path.basename(f)))??f;genuine.push(await put('common/'+path.basename(f),await readRegular(selected)));}
const actualHelper=await put('common/ModuleRequirePaths.kt',await readRegular(component.commonSources.at(-1)));genuine.push(actualHelper);
const priorOptions=options.commentTypeNameOptions.serializerOutputOptions;
for(const f of [...priorOptions.preparedOutputCodec.commonSources,...priorOptions.preparedOutputStream.commonSources,...priorOptions.preparedText.commonSources.filter(x=>/CompilerUtf8(?:Api|Algorithm)\.kt$/.test(x))])genuine.push(await put('common/'+path.basename(f),await readRegular(f)));
const constants=await put('Constants.kt',await readRegular(path.join(previousRoot,'Constants.kt'))),commonJar=path.join(root,'common.jar');
await run('genuine-complete-three-source-common-module-serializer-jvm-build','java',[...jvm,'-classpath',[commonAst,bootstrap.classPath].join(path.delimiter),'-d',commonJar,...genuine,constants,observer,corpus]);
const observations={};for(const [variant,cp]of [['original',[originalObserver,path.join(previousRoot,'original.jar'),originalAst,bootstrap.classPath]],['common',[commonJar,commonAst,bootstrap.classPath]]]) {
    const raw=await run(variant+'-genuine-full-cross-module-resolver-jvm-observe','java',['-ea','-cp',cp.join(path.delimiter),'org.jetbrains.kotlin.js.modulepathprobe.ModuleProbeKt']);await put(variant+'-full-module.txt',Buffer.from(raw));observations[variant]=raw;
}
assert.equal(observations.common,observations.original,'Complete module resolver/export/reference behavior differs');
const i=JSON.parse(await readRegular(path.join(HERE,'inventory.json'))),projections=[];
for(const common of [false,true]) {
    const variant=common?'common':'original',source=await readRegular(common?component.commonSources[0]:path.join(options.preparedCommentTypeNames.outputRoot,i.path));
    const p=projectRequireMethod({inventory:i,source,common,observer:await readRegular(path.join(HERE,'Probe.kt'))});const {bytes,...details}=p;
    const projection=await put(variant+'-projection.kt',bytes);projections.push({...details,path:variant+'-projection.kt',bytes:bytes.length,sha256:sha256(bytes)});
    const entry=await put(variant.replace(/^./,x=>x.toUpperCase())+'JvmEntry.kt',Buffer.from('package org.jetbrains.kotlin.js.modulepathprobe\nfun main(){print(pathRaw())}\n')),jar=path.join(root,variant+'-projection.jar');
    await run(variant+'-exact-relative-method-jvm-build','java',[...jvm,'-classpath',bootstrap.classPath,'-d',jar,projection,entry,...(common?[actualHelper]:[])]);
    const raw=await run(variant+'-exact-relative-method-jvm-observe','java',['-ea','-cp',[jar,bootstrap.classPath].join(path.delimiter),'org.jetbrains.kotlin.js.modulepathprobe.'+variant.replace(/^./,x=>x.toUpperCase())+'JvmEntryKt']);await put(variant+'-method-jvm.txt',Buffer.from(raw));observations[variant+'Method']=raw;
}
assert.equal(observations.commonMethod,observations.originalMethod,'Exact method String/exception outcomes differ');
const wasmEntry=await put('WasmEntry.kt',Buffer.from('@file:OptIn(kotlin.js.ExperimentalJsExport::class)\npackage org.jetbrains.kotlin.js.modulepathprobe\n@kotlin.js.JsExport fun modulePaths():String=pathRaw()\n'));
const wasm=[...java,'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler','-Xwasm-target=wasm-js','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,...flags.compilerFlags,'-Xwasm-kclass-fqn','-libraries',bootstrap.wasmJsStdlib];
await mkdir(path.join(root,'klib'));await mkdir(path.join(root,'wasm'));
await run('actual-helper-exact-method-common-wasm-klib','java',[...wasm,'-ir-output-dir',path.join(root,'klib'),'-ir-output-name','module-paths',path.join(root,'common-projection.kt'),actualHelper,wasmEntry]);
await run('actual-helper-exact-method-common-wasm-link','java',[...wasm,'-Xir-produce-js','-Xinclude='+path.join(root,'klib/module-paths.klib'),'-ir-output-dir',path.join(root,'wasm'),'-ir-output-name','module-paths','-main','noCall','-Xwasm-enable-array-range-checks','-Xwasm-enable-asserts']);
const wasmRaw=await run('actual-helper-exact-method-node-wasm-observe',process.execPath,['--experimental-wasm-exnref','--input-type=module','-e','const m=await import(process.argv[1]);process.stdout.write(m.modulePaths());',pathToFileURL(path.join(root,'wasm/module-paths.mjs')).href]);await put('common-node-wasm.txt',Buffer.from(wasmRaw));assert.equal(wasmRaw,observations.commonMethod,'Raw JVM/Node-Wasm outcomes differ');
const refs=await modulePathReferences(),artifacts=[];async function collect(prefix=''){for(const entry of await readdir(path.join(root,prefix),{withFileTypes:true})){const key=prefix?prefix+'/'+entry.name:entry.name;if(entry.isDirectory())await collect(key);else {const b=await readRegular(path.join(root,key),32*1024*1024);artifacts.push({path:key,bytes:b.length,sha256:sha256(b)});}}}await collect();
const rows=s=>s.trimEnd().split('\n');await writeJson(path.join(root,'runtime.json'),{schemaVersion:1,kind:'genuine-full-module-posix-path-jvm-and-exact-method-wasm',sourceLockSha256:sha256(await readRegular(path.join(HERE,'sources.lock.json'))),sourceFlagsSha256:sha256(flagsBytes),artifactRoot:path.relative(REPO,root),nodeVersion:process.version,commands,artifacts,projections,references:refs.files,
    preparation:component.receipt,final,originalCommonFullModuleRecords:rows(observations.original).length,exactMethodOriginalCommonJvmWasmRecords:rows(wasmRaw).length,
    genuineThreeSourceJVMCompiled:true,rawTextCompared:true,exceptionMessagesCompared:true,fullModuleGraphWasmExecuted:false,fullCompilerBuilt:false,languageReadiness:false});
console.log(JSON.stringify({originalCommonFullModuleRecords:rows(observations.original).length,exactMethodOriginalCommonJvmWasmRecords:rows(wasmRaw).length,fullModuleGraphWasmExecuted:false}));
