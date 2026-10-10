import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readRegular,sha256,verifyFile} from '../../scripts/source.mjs';
import {verifySerializerOutputBindings,verifySerializerOutputSelection,auditSerializerOutputHierarchy} from './prepare.mjs';
import {projectSerializerTransport} from './project.mjs';
import {verifyEvidence as verifyJsAstEvidence} from '../js-ast/verify.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
export const LOCAL_FILES=['README.md','TransportOracle.java','evidence/guards-status.json','evidence/guards.json','evidence/projection-status.json','evidence/projection.json','evidence/runtime-status.json','evidence/runtime.json','evidence/selection-status.json','evidence/selection.json','fixture.mjs','integrity.test.mjs','inventory.json','prepare.mjs','probe.mjs','project-runtime.mjs','project.mjs','seal.mjs','selection.mjs','sources.lock.json','transform.mjs','typecheck.mjs','verify.mjs'];
async function json(filename){return JSON.parse(await readRegular(filename,32*1024*1024));}
function boundedRoot(relative){assert(!path.isAbsolute(relative));const root=path.resolve(REPO,relative);assert(root.startsWith(path.join(REPO,'out')+path.sep));return root;}
async function pinAt(root,pin){const filename=path.resolve(root,pin.path);assert(filename.startsWith(root+path.sep));const b=await readRegular(filename,32*1024*1024);assert.equal(b.length,pin.bytes);assert.equal(sha256(b),pin.sha256,pin.path);return b;}
export async function verifySerializerOutputEvidence(){
 const manifest=await json(path.join(HERE,'evidence/artifacts.json'));assert.equal(manifest.kind,'serializer-output-bindings-evidence-seal');
 assert.deepEqual(manifest.unitFiles.map(x=>x.path),LOCAL_FILES);
 for(const field of ['fullSerializerWasmExecuted','qualifiedNameHostClosed','fullCompilerBuilt','languageReadiness'])assert.equal(manifest[field],false);
 for(const pin of manifest.unitFiles)await pinAt(HERE,pin);
 const lockBytes=await readRegular(path.join(HERE,'sources.lock.json')),lock=JSON.parse(lockBytes),inventory=await json(path.join(HERE,'inventory.json'));
 const receipts={};for(const name of ['runtime','projection','guards','selection']){
  const receipt=await json(path.join(HERE,'evidence',name+'.json')),status=await json(path.join(HERE,'evidence',name+'-status.json'));
  assert.equal(receipt.sourceLockSha256,sha256(lockBytes));assert.equal(status.state,'exited');assert.equal(status.exitCode,0);assert(Number.isInteger(status.pid)&&status.pid>0);assert(status.durationSeconds>0);
  receipts[name]=receipt;
 }
 const runtime=receipts.runtime,root=boundedRoot(runtime.artifactRoot),fixtureRoot=boundedRoot(runtime.fixtureRoot),fixture=await json(path.join(fixtureRoot,'fixture.json'));
 assert.equal(runtime.kind,'full-genuine-serializer-output-jvm-runtime');assert.equal(runtime.commands.length,5);assert(runtime.commands.every(x=>x.exitCode===0));
 assert.equal(runtime.originalCommonJvmObservations,125);
 const ast=await json(path.join(HERE,'../js-ast/evidence/receipt.json'));assert.equal(runtime.astReceiptSha256,sha256(await readRegular(path.join(HERE,'../js-ast/evidence/receipt.json'))));
 await verifyJsAstEvidence(ast,{artifactRoot:boundedRoot(runtime.astArtifactRoot)});
 for(const field of ['fullSerializerWasmExecuted','qualifiedNameHostClosed','fullCompilerBuilt','languageReadiness'])assert.equal(runtime[field],false);
 for(const pin of runtime.artifacts)await pinAt(root,pin);
 assert.deepEqual(runtime.artifacts.map(x=>x.path),['common/JsIrAstSerializer.kt','common/CacheUpdater.kt','common/JsIrProgramFragment.kt','common/JsAstByteWriter.kt','common/JsAstStreamOutput.kt','common/CompilerUtf8Algorithm.kt','common/CompilerUtf8Api.kt','Constants.kt','original/JsIrAstSerializer.kt','original/CacheUpdater.kt','original/JsIrProgramFragment.kt','common.jar','original.jar','TransportOracle.java','original-observations.txt','common-observations.txt','oracle/TransportOracle.class','oracle/TransportOracle$State.class','oracle/TransportOracle$NativeSink.class','oracle/TransportOracle$CommonSink.class']);
 assert.deepEqual(runtime.artifacts.filter(x=>x.path.startsWith('oracle/')).map(x=>x.path),['oracle/TransportOracle.class','oracle/TransportOracle$State.class','oracle/TransportOracle$NativeSink.class','oracle/TransportOracle$CommonSink.class']);
 assert.deepEqual(await readRegular(path.join(root,'TransportOracle.java')),await readRegular(path.join(HERE,'TransportOracle.java')));
 const originalRecords=await readRegular(path.join(root,'original-observations.txt')),commonRecords=await readRegular(path.join(root,'common-observations.txt'));assert.deepEqual(commonRecords,originalRecords);assert.equal(originalRecords.toString().trimEnd().split('\n').length,125);
 assert.deepEqual(await verifySerializerOutputBindings(fixture.options),runtime.preparation);
 for(const dependency of runtime.preparation.dependencies){const b=await readRegular(path.join(root,'common',path.basename(dependency.filename)));assert.equal(b.length,dependency.bytes);assert.equal(sha256(b),dependency.sha256);}
 assert.deepEqual(await verifySerializerOutputSelection({sourceRoot:fixture.options.sourceRoot,outputRoot:fixture.options.outputRoot,retainedSources:fixture.selected}),runtime.finalSelection);
 for(const row of inventory.files){
  verifyFile(await readRegular(path.join(root,'common',path.basename(row.path))),row.output);
  verifyFile(await readRegular(path.join(root,'original',path.basename(row.path))),row.kind==='carrier'?row.input:lock.originalSources.find(x=>x.path===row.path));
 }
 const closure=await json(path.join(HERE,'../closure.lock.json'));verifyFile(await readRegular(path.join(root,'Constants.kt')),closure.files.find(x=>x.path==='compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/utils/serialization/Constants.kt'));
 const projection=receipts.projection,pr=boundedRoot(projection.artifactRoot);
 assert.equal(projection.kind,'exact-selected-serializer-output-statements');assert.equal(projection.commands.length,14);assert(projection.commands.every(x=>x.exitCode===0));
 assert.equal(projection.flagsSha256,sha256(await readRegular(path.join(HERE,'../build-flags.json'))));assert.equal(runtime.flagsSha256,projection.flagsSha256);
 for(const field of ['fullSerializerWasmExecuted','qualifiedNameHostClosed','fullCompilerBuilt','languageReadiness'])assert.equal(projection[field],false);
 for(const pin of projection.artifacts)await pinAt(pr,pin);
 for(const dependency of runtime.preparation.dependencies){const b=await readRegular(path.join(pr,'dependencies',path.basename(dependency.filename)));assert.equal(b.length,dependency.bytes);assert.equal(sha256(b),dependency.sha256);}
 const serializer=inventory.files.find(x=>x.kind==='serializer'),original=await readRegular(path.join(fixture.options.sourceRoot,serializer.path)),prepared=await readRegular(path.join(fixture.options.outputRoot,serializer.path));
 assert.deepEqual(projection.source,{original:lock.originalSources.find(x=>x.path===serializer.path),prepared:serializer.output});
 for(const mode of ['writer','save']){
  const previous=path.join(HERE,'../js-ast-consumer-bindings',mode==='writer'?'output-codec':'output-stream'),previousLock=await json(path.join(previous,'sources.lock.json'));
  const observer=verifyFile(await readRegular(path.join(previous,'Probe.kt')),previousLock.observers.find(x=>x.path==='Probe.kt'));
  for(const variant of ['original','common']){
   const supportPin=previousLock.observers.find(x=>x.path===(variant==='original'?'OriginalSupport.kt':'CommonSupport.kt')),support=supportPin?verifyFile(await readRegular(path.join(previous,supportPin.path)),supportPin):undefined;
   const regenerated=projectSerializerTransport({original,prepared,inventory:{...serializer,inputOriginal:projection.source.original},observer,support,variant,mode}),pin=projection.projections.find(x=>x.mode===mode&&x.variant===variant);
   assert.deepEqual(regenerated.bytes,await readRegular(path.join(pr,mode,variant+'.kt')));assert.deepEqual(regenerated.spans,pin.spans);assert.equal(pin.fullSerializer,false);assert.equal(pin.shippingSource,false);
  }
  const observations={};for(const name of ['original-jvm','common-jvm','common-node-wasm'])observations[name]=await json(path.join(pr,mode,name+'.txt'));
  assert.deepEqual(observations['common-jvm'].records,observations['original-jvm'].records);assert.deepEqual(observations['common-node-wasm'].records,observations['original-jvm'].records);
  const comparison=projection.comparisons.find(x=>x.mode===mode);assert.equal(comparison.observations,mode==='writer'?68020:448);assert.equal(comparison.normalization,false);assert.equal(comparison.skipped,0);assert.equal(comparison.originalJvmEqualsCommonJvm,true);assert.equal(comparison.originalJvmEqualsNodeWasm,true);
  assert.equal(comparison.recordsSha256,sha256(Buffer.from(JSON.stringify(observations['original-jvm'].records))));
  if(mode==='save'){assert.notDeepEqual(observations['original-jvm'].backings,observations['common-jvm'].backings);assert.deepEqual(observations['common-node-wasm'].backings,observations['common-jvm'].backings);}
 }
 const guards=receipts.guards;assert.equal(guards.kind,'serializer-output-preparation-and-final-selection-guards');assert.equal(guards.fixturesSelectedSources,3513);assert.equal(guards.guards.length,13);assert(guards.guards.every(x=>x.rejected));
 assert.deepEqual(guards.guards.map(x=>x.name),['new-hierarchy-consumer-before','new-hierarchy-consumer-after','new-member-callable-reference','changed-known-consumer-body','unrecorded-ast-class-import','excluded-real-wasm-override-reintroduced','missing-known-consumer','duplicate-logical-source','noncanonical-prepared-output-filename','wrong-nullable-predecessor-component','noncanonical-nullable-predecessor-sources','changed-exact-recipe-span','false-full-wasm-receipt-claim']);
 const rawGuardBytes=await readRegular(path.join(REPO,guards.rawGuardReceipt.path),32*1024*1024);assert.equal(rawGuardBytes.length,guards.rawGuardReceipt.bytes);assert.equal(sha256(rawGuardBytes),guards.rawGuardReceipt.sha256);
 const rawGuards=JSON.parse(rawGuardBytes);assert.deepEqual(rawGuards.guards,guards.guards);assert.deepEqual(rawGuards.options,fixture.options);assert.deepEqual(rawGuards.selected,fixture.selected);
 const selection=receipts.selection;assert.equal(selection.kind,'actual-completed-compiler-selected-serializer-output-guard-replay');assert.equal(selection.actualCompilerSelectedSources,3515);assert.equal(selection.threeSourcesReplacedForGuardOnly,true);
 for(const field of ['newSourceExclusions','fullGraphRebuilt','fullSerializerWasmExecuted','fullCompilerBuilt','languageReadiness'])assert.equal(selection[field],false);
 for(const pin of [selection.wholeReceipt,selection.wholeArguments]){const b=await readRegular(path.join(REPO,pin.path),32*1024*1024);assert.equal(b.length,pin.bytes);assert.equal(sha256(b),pin.sha256);}
 const whole=await json(path.join(REPO,selection.wholeReceipt.path)),arguments_=(await readRegular(path.join(REPO,selection.wholeArguments.path))).toString().trimEnd().split('\n').map(line=>JSON.parse(line));
 const genuineSelected=arguments_.filter(x=>!x.startsWith('-')&&x.endsWith('.kt')).map(filename=>{const matches=whole.compileSources.filter(pin=>filename.endsWith('/'+pin.path));assert.equal(matches.length,1);return {...matches[0],filename};}).sort((a,b)=>a.path.localeCompare(b.path));
 assert.equal(genuineSelected.length,3515);assert.deepEqual(genuineSelected,selection.before.inputs);
 assert.deepEqual(await auditSerializerOutputHierarchy({retainedSources:selection.before.inputs,lock,inventory,phase:'before'}),selection.before);
 assert.deepEqual(await verifySerializerOutputSelection({sourceRoot:fixture.options.sourceRoot,outputRoot:fixture.options.outputRoot,retainedSources:selection.after.inputs}),selection.after);
 return {unitFiles:manifest.unitFiles.length+1,originalCommonJvmObservations:125,selectedStatementsJvmWasmObservations:68468,guardsPassed:13,latestActualSelectedSources:3515,fullSerializerWasmExecuted:false,fullCompilerBuilt:false,languageReadiness:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)console.log(JSON.stringify(await verifySerializerOutputEvidence()));
