import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir,writeFile,readdir} from 'node:fs/promises';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readRegular,sha256,verifyFile,writeJson} from '../../scripts/source.mjs';
import {verifyBootstrap} from '../../build/bootstrap.mjs';
import {projectCommentMethods} from './project.mjs';
import {verifySerializerCommentTypeNames} from './prepare.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..'),execute=promisify(execFile);
const fixtureRoot=path.resolve(process.argv[2]),root=path.resolve(process.argv[3]);assert(root.startsWith(path.join(REPO,'out')+path.sep));await mkdir(root,{mode:0o700});
const fixture=JSON.parse(await readRegular(path.join(fixtureRoot,'fixture.json'),32*1024*1024));await verifySerializerCommentTypeNames(fixture.options);
const inventory=JSON.parse(await readRegular(path.join(HERE,'inventory.json'))),row=inventory.files.find(x=>x.kind==='serializer');
const previous=JSON.parse(await readRegular(path.join(HERE,'../serializer-output-bindings/sources.lock.json'))),originalPin=previous.originalSources.find(x=>x.path===row.path);
const original=verifyFile(await readRegular(path.join(fixture.options.sourceRoot,row.path)),originalPin),prepared=verifyFile(await readRegular(path.join(fixture.component.outputRoot,row.path)),row.output);
const ast=JSON.parse(await readRegular(path.join(HERE,'../js-ast/evidence/receipt.json'))),nativeCmd=ast.commands.find(x=>x.phase==='actual-original-jvm-observe').command,commonCmd=ast.commands.find(x=>x.phase==='portable-common-jvm-observe').command;
const originalAst=nativeCmd[nativeCmd.indexOf('-cp')+1],commonAst=commonCmd[commonCmd.indexOf('-cp')+1],astRoot=path.dirname(commonAst.split(path.delimiter)[0]);
const bootstrap=await verifyBootstrap(),flagsBytes=await readRegular(path.join(HERE,'../build-flags.json')),flags=JSON.parse(flagsBytes),registry=JSON.parse(await readRegular(path.join(HERE,'../registry/registry-evidence.json')));
assert.deepEqual(registry.requiredFlags,['-Xwasm-kclass-fqn']);
const commands=[],projections=[];
async function put(name,b){const f=path.join(root,name);await mkdir(path.dirname(f),{recursive:true,mode:0o700});await writeFile(f,b,{flag:'wx',mode:0o600});return f;}
async function run(phase,exe,args){console.log('phase:'+phase);const started=performance.now();try{const r=await execute(exe,args,{cwd:REPO,timeout:900000,maxBuffer:16*1024*1024});commands.push({phase,command:[exe,...args],exitCode:0,elapsedMs:performance.now()-started});if(r.stderr)process.stderr.write(r.stderr);return r.stdout;}catch(e){process.stderr.write(String(e.stderr??'').slice(-18000));throw new Error(phase+' '+JSON.stringify({code:e.code,signal:e.signal,killed:e.killed}));}}
const observer=await readRegular(path.join(HERE,'MethodProbe.kt')),sources={};
for(const variant of ['original','common']){const p=projectCommentMethods({original,prepared,originalPin,preparedPin:row.output,variant,observer}),{bytes,...details}=p;sources[variant]=await put(variant+'.kt',bytes);projections.push({...details,path:variant+'.kt',bytes:bytes.length,sha256:sha256(bytes)});}
const fixtures=await put('CommentFixtures.kt',await readRegular(path.join(HERE,'CommentFixtures.kt'))),helper=await put('JsCommentTypeNameReporter.kt',await readRegular(path.join(HERE,'JsCommentTypeNameReporter.kt')));
const dependencies=[];for(const f of [...fixture.options.serializerOutputOptions.preparedOutputCodec.commonSources,...fixture.options.serializerOutputOptions.preparedOutputStream.commonSources,...fixture.options.serializerOutputOptions.preparedText.commonSources.filter(x=>/CompilerUtf8(?:Api|Algorithm)\.kt$/.test(x))])dependencies.push(await put('dependencies/'+path.basename(f),await readRegular(f)));
const jvmSupport=await put('JvmNames.kt',Buffer.from('package org.jetbrains.kotlin.js.commentprobe\nimport org.jetbrains.kotlin.js.backend.ast.JsComment\nfun hostCommentName(comment:JsComment):String=comment.javaClass.name\n'));
const wasmSupport=await put('WasmNames.kt',Buffer.from('package org.jetbrains.kotlin.js.commentprobe\nimport org.jetbrains.kotlin.js.backend.ast.JsComment\nfun hostCommentName(comment:JsComment):String=comment::class.toString()\n'));
const jvmEntry=await put('JvmEntry.kt',Buffer.from('package org.jetbrains.kotlin.js.commentprobe\nfun main(){print(commentMethodRaw())}\n'));
const wasmEntry=await put('WasmEntry.kt',Buffer.from('@file:OptIn(kotlin.js.ExperimentalJsExport::class)\npackage org.jetbrains.kotlin.js.commentprobe\n@kotlin.js.JsExport fun commentProbe():String=commentMethodRaw()\n'));
const java=['-Xmx768m','-cp',bootstrap.classPath],jvm=[...java,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,...flags.compilerFlags],observations={};
for(const [variant,cp] of [['original',originalAst],['common',commonAst]]){const jar=path.join(root,variant+'.jar'),selected=[sources[variant],fixtures,helper,jvmSupport,jvmEntry,...(variant==='common'?dependencies:[])];
    await run(variant+'-exact-comment-methods-genuine-ast-jvm-build','java',[...jvm,'-classpath',cp,'-d',jar,...selected]);
    observations[variant]=await run(variant+'-exact-comment-methods-genuine-ast-jvm-observe','java',['-ea','-cp',[jar,cp].join(path.delimiter),'org.jetbrains.kotlin.js.commentprobe.JvmEntryKt']);await put(variant+'-jvm.txt',Buffer.from(observations[variant]));}
const records=raw=>raw.trimEnd().split('\n'),core=raw=>records(raw).filter(x=>x.startsWith('core\t')&&!x.startsWith('core\tthrow:'));
assert.deepEqual(core(observations.common),core(observations.original));
const full=(await readRegular(path.join(fixtureRoot,'original-observations.txt'))).toString().trimEnd().split('\n');
for(const method of core(observations.original).filter(x=>x.startsWith('core\tdirect:')||x.startsWith('core\ttext-failure:'))){const m=method.split('\t'),actual=full.find(x=>x.split('\t')[1]===m[1]).split('\t');assert.equal(m[3],actual[3]);assert.equal(m[4],actual[4]);assert.equal(m[5],actual[9]);}
const commonSources=[...ast.preparation.files.map(x=>path.join(astRoot,'common',x.path)),...ast.preparation.commonDependencies.map(x=>x.filename),path.join(astRoot,'probe-support/JoinToWithBuffer.kt'),sources.common,fixtures,helper,wasmSupport,...dependencies];
const wasm=[...java,'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler','-Xwasm-target=wasm-js','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,...flags.compilerFlags,...registry.requiredFlags,'-libraries',bootstrap.wasmJsStdlib];
await mkdir(path.join(root,'klib'));await mkdir(path.join(root,'wasm'));
await run('common-exact-comment-methods-genuine-ast-wasm-klib','java',[...wasm,'-Xmulti-platform','-Xcommon-sources='+commonSources.join(','),'-ir-output-dir',path.join(root,'klib'),'-ir-output-name','comment-methods',...commonSources,wasmEntry]);
await run('common-exact-comment-methods-genuine-ast-wasm-module','java',[...wasm,'-Xir-produce-js','-Xinclude='+path.join(root,'klib/comment-methods.klib'),'-ir-output-dir',path.join(root,'wasm'),'-ir-output-name','comment-methods','-main','noCall','-Xwasm-enable-array-range-checks','-Xwasm-enable-asserts']);
observations.wasm=await run('common-exact-comment-methods-node-wasm-observe',process.execPath,['--experimental-wasm-exnref','--input-type=module','-e','const m=await import(process.argv[1]);process.stdout.write(m.commentProbe());',pathToFileURL(path.join(root,'wasm/comment-methods.mjs')).href]);await put('common-node-wasm.txt',Buffer.from(observations.wasm));
const j=records(observations.common),w=records(observations.wasm);assert.equal(w.length,j.length);const differences=[];
for(let n=0;n<j.length;n++){const a=j[n].split('\t'),b=w[n].split('\t');assert.deepEqual(a.slice(0,3),b.slice(0,3));if(a[0]==='core')assert.deepEqual(a.slice(4),b.slice(4),'Bytes/getter order differ across genuine host type representations');if(j[n]!==w[n]){assert.equal(a[0],'core');assert.equal(a[2],'IllegalStateException');assert.equal(a[1].startsWith('throw:'),false);differences.push({index:n,commonJvm:j[n],nodeWasm:w[n]});}}
await put('raw-host-name-differences.json',Buffer.from(JSON.stringify(differences,null,2)+'\n'));
const commonReporters=j.filter(x=>x.startsWith('reporter\t'));for(const record of commonReporters){const r=record.split('\t'),expected=/text-failure/.test(r[1])||/:-(?:1|2)(?::|$)/.test(r[1])?0:1;assert.equal(Number(r[2]),expected);}
const artifacts=[];async function collect(prefix=''){for(const item of await readdir(path.join(root,prefix),{withFileTypes:true})){const name=prefix?prefix+'/'+item.name:item.name;if(item.isDirectory())await collect(name);else{const b=await readRegular(path.join(root,name),32*1024*1024);artifacts.push({path:name,bytes:b.length,sha256:sha256(b)});}}}await collect();
await writeJson(path.join(root,'projection.json'),{schemaVersion:1,kind:'exact-comment-methods-required-real-host-names',sourceLockSha256:sha256(await readRegular(path.join(HERE,'sources.lock.json'))),sourceFlagsSha256:sha256(flagsBytes),artifactRoot:path.relative(REPO,root),fixtureRoot:path.relative(REPO,fixtureRoot),commands,artifacts,projections,
    originalPin,preparedPin:row.output,originalCommonJvmCoreRecords:core(observations.original).length,commonJvmWasmRecords:j.length,nodeWasmRawNameDifferences:differences,
    actualWasmReporter:'caller-owned actual public KClass.toString(); native diagnostic representation, no Java binary-name parity',existingRequiredFlags:registry.requiredFlags,
    bytesAndTextGetterOrderJvmWasmEqual:true,reporterIdentityCountAndPartialBytesVerified:true,shippingDefaultReporter:false,fullSerializerWasmExecuted:false,fullCompilerBuilt:false,languageReadiness:false});
console.log(JSON.stringify({originalCommonJvmCoreRecords:core(observations.original).length,commonJvmWasmRecords:j.length,rawHostNameDifferences:differences.length,fullSerializerWasmExecuted:false}));
