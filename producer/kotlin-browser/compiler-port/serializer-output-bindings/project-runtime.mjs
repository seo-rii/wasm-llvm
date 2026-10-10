import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir,writeFile,readdir} from 'node:fs/promises';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readRegular,sha256,verifyFile,writeJson} from '../../scripts/source.mjs';
import {verifyBootstrap} from '../../build/bootstrap.mjs';
import {verifyJsAstOutput} from '../js-ast-consumer-bindings/output-codec/prepare.mjs';
import {verifyJsAstOutputStream} from '../js-ast-consumer-bindings/output-stream/prepare.mjs';
import {verifyCompilerTextPreparation} from '../text/prepare.mjs';
import {projectSerializerTransport} from './project.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..'),execute=promisify(execFile);
const fixtureRoot=path.resolve(process.argv[2]),root=path.resolve(process.argv[3]);assert(root.startsWith(path.join(REPO,'out')+path.sep));await mkdir(root,{mode:0o700});
const fixture=JSON.parse(await readRegular(path.join(fixtureRoot,'fixture.json'),8*1024*1024)),options=fixture.options;
const inventory=JSON.parse(await readRegular(path.join(HERE,'inventory.json'))),row=inventory.files.find(x=>x.kind==='serializer'),lockBytes=await readRegular(path.join(HERE,'sources.lock.json')),lock=JSON.parse(lockBytes);
const original=verifyFile(await readRegular(path.join(options.sourceRoot,row.path)),lock.originalSources.find(x=>x.path===row.path)),prepared=verifyFile(await readRegular(path.join(options.outputRoot,row.path)),row.output);
const outputCodec=await verifyJsAstOutput({sourceRoot:options.sourceRoot,outputRoot:path.dirname(options.preparedOutputCodec.receiptPath),receiptPath:options.preparedOutputCodec.receiptPath});assert.deepEqual(outputCodec,options.preparedOutputCodec.receipt);
const outputStream=await verifyJsAstOutputStream({sourceRoot:options.sourceRoot,outputRoot:path.dirname(options.preparedOutputStream.receiptPath),receiptPath:options.preparedOutputStream.receiptPath});assert.deepEqual(outputStream,options.preparedOutputStream.receipt);
const text=await verifyCompilerTextPreparation(path.dirname(options.preparedText.receiptPath));assert.deepEqual(text.receipt,options.preparedText.receipt);
const bootstrap=await verifyBootstrap(),stdlib=bootstrap.artifacts.find(x=>x.id==='stdlib-jvm').path,flagsBytes=await readRegular(path.join(HERE,'../build-flags.json')),flags=JSON.parse(flagsBytes);
const commonDependencies=[...options.preparedOutputCodec.commonSources,...options.preparedOutputStream.commonSources,...options.preparedText.commonSources.filter(x=>/CompilerUtf8(?:Api|Algorithm)\.kt$/.test(x))],commands=[],projections=[],comparisons=[];
async function put(name,bytes){const filename=path.join(root,name);await mkdir(path.dirname(filename),{recursive:true,mode:0o700});await writeFile(filename,bytes,{mode:0o600,flag:'wx'});return filename;}
async function run(phase,exe,args){console.log('phase:'+phase);const start=performance.now();try{const r=await execute(exe,args,{cwd:REPO,timeout:900000,maxBuffer:32*1024*1024});if(r.stderr)process.stderr.write(r.stderr);commands.push({phase,command:[exe,...args],exitCode:0,elapsedMs:performance.now()-start});return r.stdout;}catch(e){process.stderr.write(String(e.stderr??'').slice(-18000));throw new Error(phase+' '+JSON.stringify({code:e.code,signal:e.signal,killed:e.killed}));}}
const deps=[];for(const filename of commonDependencies)deps.push(await put('dependencies/'+path.basename(filename),await readRegular(filename)));
const java=['-Xmx768m','-cp',bootstrap.classPath],jvm=[...java,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,...flags.compilerFlags,'-classpath',stdlib],wasm=[...java,'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler','-Xwasm-target=wasm-js','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,...flags.compilerFlags,'-libraries',bootstrap.wasmJsStdlib];
for(const mode of ['writer','save']){
 const previousRoot=path.join(HERE,'../js-ast-consumer-bindings',mode==='writer'?'output-codec':'output-stream'),previousLock=JSON.parse(await readRegular(path.join(previousRoot,'sources.lock.json')));
 const observerPin=previousLock.observers.find(x=>x.path==='Probe.kt'),observer=verifyFile(await readRegular(path.join(previousRoot,'Probe.kt')),observerPin),sources={};
 for(const variant of ['original','common']){
  const supportPin=previousLock.observers.find(x=>x.path===(variant==='common'?'CommonSupport.kt':'OriginalSupport.kt'));
  const support=supportPin?verifyFile(await readRegular(path.join(previousRoot,supportPin.path)),supportPin):undefined;
  const projection=projectSerializerTransport({original,prepared,inventory:{...row,inputOriginal:lock.originalSources.find(x=>x.path===row.path)},observer,support,variant,mode});
  const name=mode+'/'+variant+'.kt';sources[variant]=await put(name,projection.bytes);
  const {bytes:projectedBytes,...metadata}=projection;
  projections.push({path:name,bytes:projectedBytes.length,sha256:sha256(projectedBytes),...metadata});
 }
 const jvmEntry=await put(mode+'/JvmEntry.kt',Buffer.from('package org.jetbrains.kotlin.js.outputprobe\nfun main() { println(observation()) }\n')),
 wasmEntry=await put(mode+'/WasmEntry.kt',Buffer.from('package org.jetbrains.kotlin.js.outputprobe\nimport kotlin.js.JsExport\n@JsExport fun transportRecords(): String = observation()\n'));
 const observations={};
 for(const variant of ['original','common']){
  const jar=path.join(root,mode,variant+'.jar'),selected=variant==='common'?[sources[variant],...deps]:[sources[variant]];
  await run(mode+'-'+variant+'-exact-selected-statements-jvm-build','java',[...jvm,'-d',jar,...selected,jvmEntry]);
  const raw=await run(mode+'-'+variant+'-exact-selected-statements-jvm-observe','java',['-ea','-cp',[jar,stdlib].join(path.delimiter),'org.jetbrains.kotlin.js.outputprobe.JvmEntryKt']);
  await put(mode+'/'+variant+'-jvm.txt',Buffer.from(raw));observations[variant]=JSON.parse(raw);
 }
 assert.deepEqual(observations.common.records,observations.original.records);
 const common=[sources.common,...deps];await mkdir(path.join(root,mode,'klib'));await mkdir(path.join(root,mode,'wasm'));
 await run(mode+'-common-exact-selected-statements-wasm-klib','java',[...wasm,'-Xmulti-platform','-Xcommon-sources='+common.join(','),'-ir-output-dir',path.join(root,mode,'klib'),'-ir-output-name','serializer-transport',...common,wasmEntry]);
 await run(mode+'-common-exact-selected-statements-wasm-module','java',[...wasm,'-Xir-produce-js','-Xinclude='+path.join(root,mode,'klib/serializer-transport.klib'),'-ir-output-dir',path.join(root,mode,'wasm'),'-ir-output-name','serializer-transport','-main','noCall','-Xwasm-enable-array-range-checks','-Xwasm-enable-asserts']);
 const raw=await run(mode+'-common-exact-selected-statements-node-wasm-observe',process.execPath,['--experimental-wasm-exnref','--input-type=module','-e','const module=await import(process.argv[1]);console.log(module.transportRecords());',pathToFileURL(path.join(root,mode,'wasm/serializer-transport.mjs')).href]);
 await put(mode+'/common-node-wasm.txt',Buffer.from(raw));observations.wasm=JSON.parse(raw);assert.deepEqual(observations.wasm.records,observations.original.records);
 if(mode==='save'){assert.notDeepEqual(observations.common.backings,observations.original.backings);assert.deepEqual(observations.wasm.backings,observations.common.backings);}
 comparisons.push({mode,observations:observations.original.records.length,originalJvmEqualsCommonJvm:true,originalJvmEqualsNodeWasm:true,normalization:false,skipped:0,recordsSha256:sha256(Buffer.from(JSON.stringify(observations.original.records))),backingArrayIdentityParity:false});
}
const artifacts=[];async function collect(prefix=''){for(const item of await readdir(path.join(root,prefix),{withFileTypes:true})){const name=prefix?prefix+'/'+item.name:item.name;if(item.isDirectory())await collect(name);else{const b=await readRegular(path.join(root,name),32*1024*1024);artifacts.push({path:name,bytes:b.length,sha256:sha256(b)});}}}await collect();
await writeJson(path.join(root,'projection-runtime.json'),{schemaVersion:1,kind:'exact-selected-serializer-output-statements',sourceLockSha256:sha256(lockBytes),flagsSha256:sha256(flagsBytes),artifactRoot:path.relative(REPO,root),fixtureRoot:path.relative(REPO,fixtureRoot),source:{original:lock.originalSources.find(x=>x.path===row.path),prepared:row.output},projections,comparisons,commands,artifacts,
 fullSerializerWasmExecuted:false,qualifiedNameHostClosed:false,fullCompilerBuilt:false,languageReadiness:false});console.log(JSON.stringify({comparisons,fullSerializerWasmExecuted:false}));
