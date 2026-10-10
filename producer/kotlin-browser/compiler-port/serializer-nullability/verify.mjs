import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readRegular,sha256} from '../../scripts/source.mjs';
import {verifyEvidence} from '../js-ast/verify.mjs';
import {verifySerializerNullability} from './prepare.mjs';
import {HELPER} from './transform.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
export async function verifySerializerNullabilityEvidence(){
 const manifest=JSON.parse(await readRegular(path.join(HERE,'evidence/artifacts.json')));
 assert.equal(manifest.kind,'serializer-nullability-evidence-seal');
 assert.deepEqual(manifest.unitFiles.map(x=>x.path),[
  'GetterProbe.kt','Oracle.java','README.md','evidence/bootstrap-negative.json','evidence/guards-status.json',
  'evidence/runtime-status.json','evidence/runtime.json','integrity.test.mjs','inventory.json','prepare.mjs',
  'probe.mjs','sources.lock.json','transform.mjs','verify.mjs']);
 for(const field of ['fullSerializerWasmExecuted','fullCompilerBuilt','languageReadiness'])assert.equal(manifest[field],false);
 for(const pin of manifest.unitFiles){const b=await readRegular(path.join(HERE,pin.path));assert.equal(b.length,pin.bytes);assert.equal(sha256(b),pin.sha256,pin.path);}
 const runtime=JSON.parse(await readRegular(path.join(HERE,'evidence/runtime.json'))),root=path.join(REPO,runtime.artifactRoot);
 assert.equal(runtime.sourceLockSha256,sha256(await readRegular(path.join(HERE,'sources.lock.json'))));
 assert.equal(runtime.flagsSha256,sha256(await readRegular(path.join(HERE,'../build-flags.json'))));
 assert.equal(runtime.commands.length,10);assert(runtime.commands.every(x=>x.exitCode===0));
 assert.equal(runtime.fullSerializerWasmExecuted,false);assert.equal(runtime.fullCompilerBuilt,false);assert.equal(runtime.languageReadiness,false);
 assert.equal(runtime.qualifiedNameHostClosed,false);assert.equal(runtime.bootstrapNotNullInstrumentationParity,false);
 assert.equal(manifest.guardsPassed,6);
 for(const filename of ['runtime-status.json','guards-status.json']){
  const status=JSON.parse(await readRegular(path.join(HERE,'evidence',filename)));assert.equal(status.state,'exited');assert.equal(status.exitCode,0);assert(Number.isInteger(status.pid)&&status.pid>0);assert(status.durationSeconds>0);
 }
 for(const pin of runtime.artifacts){const b=await readRegular(path.join(root,pin.path));assert.equal(b.length,pin.bytes);assert.equal(sha256(b),pin.sha256,pin.path);}
 assert.deepEqual(manifest.observerClasses.map(x=>x.path),['oracle/Oracle$Build.class','oracle/Oracle.class']);
 for(const pin of manifest.observerClasses){const b=await readRegular(path.join(root,pin.path));assert.equal(b.length,pin.bytes);assert.equal(sha256(b),pin.sha256,pin.path);}
 const original=await readRegular(path.join(root,'original-observations.txt')),common=await readRegular(path.join(root,'common-observations.txt'));
 assert.deepEqual(common,original);assert.equal(original.toString().trimEnd().split('\n').length,runtime.originalCommonJvmObservations);
 const jvm=await readRegular(path.join(root,'getter-jvm-observations.txt')),wasm=await readRegular(path.join(root,'getter-wasm-observations.txt'));
 assert.deepEqual(wasm,jvm);assert.equal(jvm.toString().trimEnd().split('\n').length,runtime.getterCommonJvmWasmObservations);
 const ast=JSON.parse(await readRegular(path.join(HERE,'../js-ast/evidence/receipt.json')));assert.equal(runtime.astReceiptSha256,sha256(await readRegular(path.join(HERE,'../js-ast/evidence/receipt.json'))));
 await verifyEvidence(ast,{artifactRoot:path.join(REPO,runtime.astArtifactRoot)});
 const astOutput=path.join(REPO,runtime.astArtifactRoot,'common'),preparedJsAst={outputRoot:astOutput,receipt:ast.preparation,receiptPath:path.join(astOutput,'js-ast-inputs.json'),commonSources:ast.preparation.files.map(x=>path.join(astOutput,x.path))};
 const options={sourceRoot:path.join(REPO,'out/kotlin-compiler-port/sources'),outputRoot:path.join(root,'profile'),preparedJsAst};
 assert.deepEqual(await verifySerializerNullability(options),runtime.prepared);
 const originalSource=await readRegular(path.join(root,'original/JsIrAstSerializer.kt'));
 assert.equal(sha256(originalSource),runtime.prepared.consumer.sha256);
 const sourceLock=JSON.parse(await readRegular(path.join(HERE,'sources.lock.json')));
 const closure=JSON.parse(await readRegular(path.join(HERE,'../closure.lock.json')));
 const constantPin=closure.files.find(x=>x.path==='compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/utils/serialization/Constants.kt');
 assert.equal(sha256(await readRegular(path.join(root,'Constants.kt'))),constantPin.sha256);
 const originalRecords=original.toString().trimEnd().split('\n');
 for(const binding of runtime.prepared.bindings.filter(x=>x.getter&&x.fixture)){
  const row=originalRecords.find(x=>x.startsWith(binding.fixture+'\t')).split('\t');assert.equal(row[1],'java.lang.NullPointerException');
  assert.equal(row[2],Buffer.from(binding.getter+' must not be null','utf16le').swap16().toString('hex'));
 }
 assert.equal(sha256(await readRegular(path.join(options.outputRoot,sourceLock.consumer.path))),sourceLock.prepared.sha256);
 const prepared=await readRegular(path.join(options.outputRoot,runtime.prepared.consumer.path)),imports=ast.preparation.propertyAliasImports;
 let text=prepared.toString();const p=/^package[^\r\n]+/m.exec(text),end=p.index+p[0].length;
 text=text.slice(0,end)+'\n'+imports.map(x=>'import '+x).join('\n')+'\n'+text.slice(end);
 assert.equal((await readRegular(path.join(root,'common/JsIrAstSerializer.kt'))).toString(),text);
 const inventory=JSON.parse(await readRegular(path.join(HERE,'inventory.json'))),signatures=inventory.bindings.filter(x=>x.getter).map((row,index)=>{
  const variable=row.expression.split('.')[0],type=variable==='it'?'JsCase':variable==='c'?'JsCatch':variable==='function'?'JsFunction':/\(\w+: (\w+)\)/.exec(row.owner)[1];
  const expression='requiredSerializerAstValue('+row.expression+', '+JSON.stringify(row.getter)+')';
  return {index,owner:row.owner,expression,source:'fun projection'+index+'('+variable+': '+type+') = '+expression};
 });
 assert.deepEqual(signatures,runtime.projectionSignatures);
 const projection='package org.jetbrains.kotlin.ir.backend.js.utils.serialization\nimport org.jetbrains.kotlin.js.backend.ast.*\n'+imports.map(x=>'import '+x).join('\n')+'\n'+HELPER+'\n'+signatures.map(x=>x.source).join('\n')+'\nfun namedProjection(n: JsDeclarable.Named) = n.getName()\nfun metadataNullProjection(value: Any?) = requiredSerializerMetadataValue(value)\n';
 assert.equal((await readRegular(path.join(root,'GetterProjection.kt'))).toString(),projection);
 for(const record of jvm.toString().trimEnd().split('\n')){
  const [id,kind,message]=record.split('\t');if(kind!=='NullPointerException')continue;
  const whole=original.toString().split('\n').find(x=>x.startsWith(id+'\t'));assert(whole);assert.equal(whole.split('\t')[2],message);
 }
 const negative=JSON.parse(await readRegular(path.join(HERE,'evidence/bootstrap-negative.json')));assert.equal(negative.bootstrapNotNullInstrumentationParity,false);
 assert.equal(negative.differences.length,2);
 for(const pin of [negative.compiler,negative.fullOriginalSerializerJar,negative.observer]){
  const b=await readRegular(path.join(REPO,pin.path),pin.bytes);assert.equal(b.length,pin.bytes);assert.equal(sha256(b),pin.sha256);
 }
 assert.equal(negative.bootstrapStatus.exitCode,0);assert.equal(negative.bootstrapStatus.state,'exited');
 for(const difference of negative.differences){
  assert.equal(difference.originalPinnedSource,original.toString().split('\n').find(x=>x.startsWith(difference.id+'\t')));
  assert.equal(difference.bootstrapBinary.split('\t')[1],'java.lang.IllegalStateException');
 }
 return {unitFiles:manifest.unitFiles.length+1,artifacts:runtime.artifacts.length+manifest.observerClasses.length,originalCommonJvmObservations:runtime.originalCommonJvmObservations,getterCommonJvmWasmObservations:runtime.getterCommonJvmWasmObservations,guardsPassed:6,fullSerializerWasmExecuted:false,fullCompilerBuilt:false,languageReadiness:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)console.log(JSON.stringify(await verifySerializerNullabilityEvidence()));
