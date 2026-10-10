import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {verifyBootstrap} from '../../build/bootstrap.mjs';
import {readRegular,sha256,verifyFile,writeJson} from '../../scripts/source.mjs';
import {verifyEvidence} from '../js-ast/verify.mjs';
import {prepareSerializerNullability,verifySerializerNullability} from './prepare.mjs';
import {HELPER} from './transform.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..'),execute=promisify(execFile);
const outputRoot=path.resolve(process.argv[2]);assert(outputRoot.startsWith(path.join(REPO,'out')+path.sep));await mkdir(outputRoot,{mode:0o700});
const lockBytes=await readRegular(path.join(HERE,'sources.lock.json')),lock=JSON.parse(lockBytes),inventory=JSON.parse(await readRegular(path.join(HERE,'inventory.json')));
const bootstrap=await verifyBootstrap(),astReceipt=JSON.parse(await readRegular(path.join(HERE,'../js-ast/evidence/receipt.json')));
const originalCommand=astReceipt.commands.find(x=>x.phase==='actual-original-jvm-observe').command;
const originalClasspath=originalCommand[originalCommand.indexOf('-cp')+1],astRoot=path.dirname(originalClasspath.split(path.delimiter)[0]);
await verifyEvidence(astReceipt,{artifactRoot:astRoot});
const astOutput=path.join(astRoot,'common'),preparedJsAst={outputRoot:astOutput,receipt:astReceipt.preparation,
    receiptPath:path.join(astOutput,'js-ast-inputs.json'),commonSources:astReceipt.preparation.files.map(x=>path.join(astOutput,x.path))};
const sourceRoot=path.join(REPO,'out/kotlin-compiler-port/sources'),options={sourceRoot,outputRoot:path.join(outputRoot,'profile'),preparedJsAst};
const prepared=await prepareSerializerNullability(options);await verifySerializerNullability(options);
const commands=[],artifacts=[];
async function store(name,bytes){const filename=path.join(outputRoot,name);await mkdir(path.dirname(filename),{recursive:true,mode:0o700});await writeFile(filename,bytes,{flag:'wx',mode:0o600});artifacts.push({path:name,bytes:bytes.length,sha256:sha256(bytes)});return filename;}
async function run(phase,command,args){console.log('phase: '+phase);const start=performance.now();
    try{const r=await execute(command,args,{cwd:REPO,timeout:900000,maxBuffer:12*1024*1024});commands.push({phase,command:[command,...args],exitCode:0,elapsedMs:performance.now()-start});if(r.stderr)process.stderr.write(r.stderr);return r.stdout;}
    catch(e){process.stderr.write(String(e.stderr??'').slice(-12000));commands.push({phase,command:[command,...args],exitCode:e.code,signal:e.signal,killed:e.killed,timeoutMs:900000});throw new Error(phase+' failed '+JSON.stringify({code:e.code,signal:e.signal,killed:e.killed,timeoutMs:900000}));}}
const flagsBytes=await readRegular(path.join(HERE,'../build-flags.json')),flags=JSON.parse(flagsBytes);
const java=['-Xmx768m','-cp',bootstrap.classPath],jvm=[...java,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,'-jvm-target','17',...flags.compilerFlags];
const constantsPath='compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/utils/serialization/Constants.kt';
const closure=JSON.parse(await readRegular(path.join(HERE,'../closure.lock.json'))),constantPin=closure.files.find(x=>x.path===constantsPath);assert(constantPin);
const constants=await store('Constants.kt',verifyFile(await readRegular(path.join(sourceRoot,constantsPath)),constantPin));
const oracle=await store('Oracle.java',await readRegular(path.join(HERE,'Oracle.java'))),classes=path.join(outputRoot,'oracle');await mkdir(classes);
const portableClasspath=astReceipt.commands.find(x=>x.phase==='portable-common-jvm-observe').command[3];
assert(portableClasspath.includes('portable.jar'));
const imports=preparedJsAst.receipt.propertyAliasImports;
const original=await store('original/JsIrAstSerializer.kt',verifyFile(await readRegular(path.join(sourceRoot,lock.consumer.path)),lock.consumer));
let commonText=(await readRegular(prepared.commonSources[0])).toString();const p=/^package[^\r\n]+/m.exec(commonText),end=p.index+p[0].length;
commonText=commonText.slice(0,end)+'\n'+imports.map(x=>'import '+x).join('\n')+'\n'+commonText.slice(end);
const common=await store('common/JsIrAstSerializer.kt',Buffer.from(commonText));
await run('original-genuine-ast-oracle-java-build','javac',['-cp',originalClasspath+path.delimiter+bootstrap.classPath,'-d',classes,oracle]);
const variants={};
for(const [variant,source,astClasspath] of [['original',original,originalClasspath],['common',common,portableClasspath]]){
    const jar=path.join(outputRoot,variant+'.jar'),cp=astClasspath+path.delimiter+bootstrap.classPath;
    await run(variant+'-full-serializer-jvm-build','java',[...jvm,'-classpath',cp,'-d',jar,source,constants]);
    const bytes=await readRegular(jar);artifacts.push({path:variant+'.jar',bytes:bytes.length,sha256:sha256(bytes)});
    variants[variant]=await run(variant+'-full-serializer-real-ast-observe','java',['-ea','-cp',[classes,jar,cp].join(path.delimiter),'Oracle']);
    await store(variant+'-observations.txt',Buffer.from(variants[variant]));
}
assert.equal(variants.original,variants.common,'Full Serializer failure/message/partial writer bytes differ');
const records=variants.original.trimEnd().split('\n');
for(const row of inventory.bindings.filter(x=>x.getter && x.fixture)){
    const actual=records.find(x=>x.startsWith(row.fixture+'\t')).split('\t');assert.equal(actual[1],'java.lang.NullPointerException');
    assert.equal(actual[2],Buffer.from(row.getter+' must not be null','utf16le').swap16().toString('hex'));
}
const metadata=records.find(x=>x.startsWith('metadata:null\t')).split('\t');assert.equal(metadata[1],'java.lang.NullPointerException');
assert.equal(metadata[2],Buffer.from(prepared.receipt.metadataNullMessage,'utf16le').swap16().toString('hex'));
const signatures=inventory.bindings.filter(x=>x.getter).map((row,index)=>{
    const variable=row.expression.split('.')[0];let type=variable==='it'?'JsCase':variable==='c'?'JsCatch':variable==='function'?'JsFunction':/\(\w+: (\w+)\)/.exec(row.owner)[1];
    const expression='requiredSerializerAstValue('+row.expression+', '+JSON.stringify(row.getter)+')';
    return {index,owner:row.owner,expression,source:'fun projection'+index+'('+variable+': '+type+') = '+expression};
});
const projection=await store('GetterProjection.kt',Buffer.from('package org.jetbrains.kotlin.ir.backend.js.utils.serialization\nimport org.jetbrains.kotlin.js.backend.ast.*\n'+imports.map(x=>'import '+x).join('\n')+'\n'+HELPER+'\n'+signatures.map(x=>x.source).join('\n')+'\nfun namedProjection(n: JsDeclarable.Named) = n.getName()\nfun metadataNullProjection(value: Any?) = requiredSerializerMetadataValue(value)\n'));
const getterProbe=await store('GetterProbe.kt',await readRegular(path.join(HERE,'GetterProbe.kt')));
const jvmEntry=await store('JvmEntry.kt',Buffer.from('package org.jetbrains.kotlin.ir.backend.js.utils.serialization\nfun main() { print(getterProbeRaw()) }\n'));
const wasmEntry=await store('WasmEntry.kt',Buffer.from('@file:OptIn(kotlin.js.ExperimentalJsExport::class)\npackage org.jetbrains.kotlin.ir.backend.js.utils.serialization\n@kotlin.js.JsExport fun serializerGetterProbe(): String = getterProbeRaw()\n'));
const joinSupport=path.join(astRoot,'probe-support/JoinToWithBuffer.kt');
const commonSources=[...preparedJsAst.commonSources,...preparedJsAst.receipt.commonDependencies.map(x=>x.filename),joinSupport,projection,getterProbe];
const projectionJar=path.join(outputRoot,'getters.jar');
await run('actual-common-getter-statements-jvm-build','java',[...jvm,'-classpath',portableClasspath+path.delimiter+bootstrap.classPath,'-d',projectionJar,projection,getterProbe,jvmEntry]);
let getterJvm=await run('actual-common-getter-statements-jvm-observe','java',['-cp',[projectionJar,portableClasspath,bootstrap.classPath].join(path.delimiter),'org.jetbrains.kotlin.ir.backend.js.utils.serialization.JvmEntryKt']);
await store('getter-jvm-observations.txt',Buffer.from(getterJvm));
const wasm=[...java,'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler','-Xwasm-target=wasm-js','-libraries',bootstrap.wasmJsStdlib,'-language-version',flags.languageVersion,'-api-version',flags.apiVersion,...flags.compilerFlags];
await mkdir(path.join(outputRoot,'klib'));await mkdir(path.join(outputRoot,'wasm'));
await run('actual-common-getter-statements-wasm-klib','java',[...wasm,'-Xmulti-platform','-Xcommon-sources='+commonSources.join(','),'-ir-output-dir',path.join(outputRoot,'klib'),'-ir-output-name','serializer-getters',...commonSources,wasmEntry]);
await run('actual-common-getter-statements-wasm-module','java',[...wasm,'-Xir-produce-js','-Xinclude='+path.join(outputRoot,'klib/serializer-getters.klib'),'-ir-output-dir',path.join(outputRoot,'wasm'),'-ir-output-name','serializer-getters','-main','noCall']);
const getterWasm=await run('actual-common-getter-statements-node-wasm-observe',process.execPath,['--experimental-wasm-exnref','--input-type=module','-e','const m=await import(process.argv[1]);process.stdout.write(m.serializerGetterProbe());',pathToFileURL(path.join(outputRoot,'wasm/serializer-getters.mjs')).href]);
await store('getter-wasm-observations.txt',Buffer.from(getterWasm));assert.equal(getterJvm,getterWasm,'Actual getter expression raw observations differ');
for(const record of getterJvm.trimEnd().split('\n')){
    const [id,kind,message]=record.split('\t');if(kind!=='NullPointerException')continue;
    const whole=records.find(x=>x.startsWith(id+'\t'));assert(whole);assert.equal(whole.split('\t')[2],message,'Projected NPE differs from full original source');
}
for(const name of ['getters.jar','klib/serializer-getters.klib','wasm/serializer-getters.wasm','wasm/serializer-getters.mjs','wasm/serializer-getters.import-object.mjs','wasm/serializer-getters.js-builtins.mjs']){
    const bytes=await readRegular(path.join(outputRoot,name));artifacts.push({path:name,bytes:bytes.length,sha256:sha256(bytes)});
}
await verifySerializerNullability(options);
await writeJson(path.join(outputRoot,'runtime.json'),{schemaVersion:1,kind:'serializer-selected-nullability-runtime',sourceLockSha256:sha256(lockBytes),flagsSha256:sha256(flagsBytes),source:lock.source,
    prepared:prepared.receipt,artifactRoot:path.relative(REPO,outputRoot),astArtifactRoot:path.relative(REPO,astRoot),astReceiptSha256:sha256(await readRegular(path.join(HERE,'../js-ast/evidence/receipt.json'))),
    commands,artifacts,originalCommonJvmObservations:records.length,getterCommonJvmWasmObservations:getterJvm.trimEnd().split('\n').length,projectionSignatures:signatures,
    evaluationOrder:'exact selected expressions in full original/checked Serializer; all four writer buffers and map counts observed before/after failure',
    inaccessibleComputedNameSecondReadNull:'genuine final JsFunction pure getter in selected serial single-worker profile; no fabricated concurrent receiver',
    bootstrapNotNullInstrumentationParity:false,qualifiedNameHostClosed:false,fullSerializerWasmExecuted:false,fullCompilerBuilt:false,languageReadiness:false});
console.log(JSON.stringify({originalCommonJvmObservations:records.length,getterCommonJvmWasmObservations:getterJvm.trimEnd().split('\n').length,fullSerializerWasmExecuted:false,fullCompilerBuilt:false,languageReadiness:false}));
