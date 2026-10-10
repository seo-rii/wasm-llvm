import assert from 'node:assert/strict';
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readRegular,sha256,verifyFile} from '../../scripts/source.mjs';
import {verifyBootstrap} from '../../build/bootstrap.mjs';
import {verifySerializerOutputEvidence} from '../serializer-output-bindings/verify.mjs';
import {verifySerializerCommentTypeNames,reconstructSerializerCommentTypeNamePredecessorSelection} from './prepare.mjs';
import {projectCommentMethods} from './project.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
export const LOCAL_FILES=['CommentFixtures.kt','JsCommentTypeNameReporter.kt','MethodProbe.kt','Oracle.java','README.md',
 'evidence/guards-status.json','evidence/guards.json','evidence/projection-status.json','evidence/projection.json','evidence/runtime-status.json','evidence/runtime.json',
 'fixture.mjs','integrity.test.mjs','inventory.json','prepare.mjs','probe.mjs','project-runtime.mjs','project.mjs','seal.mjs','sources.lock.json','transform.mjs','verify.mjs'];
const FALSE_FIELDS=['shippingDefaultReporter','fullSerializerWasmExecuted','fullCompilerBuilt','languageReadiness'];
async function json(filename){return JSON.parse(await readRegular(filename,32*1024*1024));}
function boundedRoot(relative){assert(!path.isAbsolute(relative));const root=path.resolve(REPO,relative);assert(root.startsWith(path.join(REPO,'out')+path.sep));return root;}
async function pinAt(root,pin){const filename=path.resolve(root,pin.path);assert(filename.startsWith(root+path.sep));const bytes=await readRegular(filename,32*1024*1024);
 assert.equal(bytes.length,pin.bytes);assert.equal(sha256(bytes),pin.sha256,pin.path);if(pin.gitBlob)verifyFile(bytes,pin);return bytes;}
function rawRows(bytes){const text=bytes.toString();assert(text.endsWith('\n'));return text.slice(0,-1).split('\n');}
function core(rows){return rows.filter(row=>row.startsWith('core\t'));}
function ids(prefix=''){const out=[];for(let k=-2;k<=6;k++)for(let n=0;n<6;n++)out.push(prefix+'direct:'+k+':'+n);
 for(let k=0;k<=6;k++)out.push(prefix+'text-failure:'+k);for(let position=0;position<3;position++)for(let k=-2;k<=6;k++)out.push(prefix+'node:'+position+':'+k);return out;}
function expectsReporter(id){return !id.includes('text-failure:')&&!/:-(?:1|2)(?::|$)/.test(id);}
function falseFields(value,fields=FALSE_FIELDS){for(const field of fields)assert.equal(value[field],false,field);}
async function artifacts(root,receipt,receiptName,required){
 assert(Array.isArray(receipt.artifacts));const names=receipt.artifacts.map(pin=>pin.path);assert.equal(new Set(names).size,names.length);
 for(const name of required)assert(names.includes(name),'Missing actual artifact: '+name);
 for(const pin of receipt.artifacts)await pinAt(root,pin);
 const found=[];async function scan(prefix=''){for(const item of await readdir(path.join(root,prefix),{withFileTypes:true})){
  const key=prefix?prefix+'/'+item.name:item.name;if(item.isDirectory())await scan(key);else {assert(item.isFile());if(key!==receiptName)found.push(key);}}}
 await scan();assert.deepEqual(found.sort(),names.slice().sort(),'Incomplete artifact inventory');
}
function commands(receipt,phases,bootstrap){assert.deepEqual(receipt.commands.map(x=>x.phase),phases);assert(receipt.commands.every(x=>x.exitCode===0&&x.elapsedMs>0));
 for(const entry of receipt.commands.filter(x=>x.command[0]==='java')){const cp=entry.command.indexOf('-cp');assert(cp>=0);if(entry.phase.endsWith('build')||entry.phase.endsWith('klib')||entry.phase.endsWith('module'))assert.equal(entry.command[cp+1],bootstrap.classPath);}}
function fullReporters(rows,cores){const reports=rows.filter(row=>row.startsWith('reporter\t'));assert.equal(reports.length,88);
 for(let n=0;n<reports.length;n++){const r=reports[n].split('\t'),c=cores[n].split('\t');assert.equal(r[1],c[1]);const expected=expectsReporter(c[1]);assert.equal(r[2],expected?'1':'0');
  assert.equal(r.slice(3).join('\t'),expected?'receiver-identical:'+c.slice(4,9).join('\t'):'');}
}
export async function verifySerializerCommentTypeNameEvidence(){
 const manifest=await json(path.join(HERE,'evidence/artifacts.json'));assert.equal(manifest.kind,'serializer-comment-type-names-evidence-seal');
 assert.deepEqual(manifest.unitFiles.map(pin=>pin.path),LOCAL_FILES);falseFields(manifest);assert.equal(manifest.jvmBinaryNameParity,false);
 for(const pin of manifest.unitFiles)await pinAt(HERE,pin);
 await verifySerializerOutputEvidence();const bootstrap=await verifyBootstrap();
 const lockBytes=await readRegular(path.join(HERE,'sources.lock.json')),lock=JSON.parse(lockBytes),inventory=await json(path.join(HERE,'inventory.json'));
 const flagsHash=sha256(await readRegular(path.join(HERE,'../build-flags.json'))),receipts={};
 for(const name of ['runtime','projection','guards']){const receipt=await json(path.join(HERE,'evidence',name+'.json')),status=await json(path.join(HERE,'evidence',name+'-status.json'));
  assert.equal(status.state,'exited');assert.equal(status.exitCode,0);assert(Number.isInteger(status.pid)&&status.pid>0);assert(status.durationSeconds>0);
  assert.equal(receipt.sourceLockSha256,sha256(lockBytes));receipts[name]=receipt;}
 const runtime=receipts.runtime,root=boundedRoot(runtime.artifactRoot),fixture=await json(path.join(root,'fixture.json'));
 assert.equal(runtime.kind,'full-genuine-serializer-required-comment-reporter-jvm');falseFields(runtime);assert.equal(runtime.sourceFlagsSha256,flagsHash);
 commands(runtime,['genuine-original-ast-extension-receivers-jvm-build','full-genuine-common-serializer-required-reporter-jvm-build','full-genuine-serializer-comment-observer-java-build',
  'full-genuine-original-serializer-comment-observe','full-genuine-common-serializer-comment-observe','full-genuine-common-serializer-reporter-failure-observe'],bootstrap);
 await artifacts(root,runtime,'runtime.json',['original-fixtures.jar','common.jar','oracle/Oracle.class','Oracle.java','CommentFixtures.kt','Constants.kt','fixture.json',
  'original-observations.txt','common-observations.txt','reporter-failure-observations.txt',...inventory.files.map(row=>'common/'+path.basename(row.path)),'common/JsCommentTypeNameReporter.kt']);
 assert.equal(runtime.priorRuntimeSha256,sha256(await readRegular(path.join(HERE,'../serializer-output-bindings/evidence/runtime.json'))));
 assert.deepEqual(await verifySerializerCommentTypeNames(fixture.options),runtime.preparation);
 assert.deepEqual(fixture.component.receipt,runtime.preparation);
 assert.deepEqual(await reconstructSerializerCommentTypeNamePredecessorSelection({...fixture.options,retainedSources:fixture.after}),runtime.final);assert.deepEqual(fixture.final,runtime.final);
 assert.equal(runtime.actualSelectedSourcesBefore,3515);assert.equal(runtime.actualSelectedSourcesAfter,3516);
 assert.equal(runtime.originalCommonCoreRecords,88);assert.equal(runtime.commonReporterRecords,88);assert.equal(runtime.reporterFailureRecords,88);
 for(const field of ['originalCommonJvmExact','reporterReceiverIdentityAndPartialWriteOrder'])assert.equal(runtime[field],true);
 assert.equal(runtime.jvmBinaryNameHost,'actual java.lang.Object.getClass().getName()');
 for(const name of ['Oracle.java','CommentFixtures.kt'])assert.deepEqual(await readRegular(path.join(root,name)),await readRegular(path.join(HERE,name)));
 for(const pin of runtime.preparation.files)verifyFile(await readRegular(path.join(root,'common',path.basename(pin.path))),pin);
 const closure=await json(path.join(HERE,'../closure.lock.json'));verifyFile(await readRegular(path.join(root,'Constants.kt')),closure.files.find(pin=>pin.path.endsWith('/serialization/Constants.kt')));
 const dependencies=fixture.options.serializerOutputOptions.preparedOutputCodec.commonSources.concat(fixture.options.serializerOutputOptions.preparedOutputStream.commonSources,
  fixture.options.serializerOutputOptions.preparedText.commonSources.filter(filename=>/CompilerUtf8(?:Api|Algorithm)\.kt$/.test(filename)));
 assert.equal(dependencies.length,4);for(const filename of dependencies)assert.deepEqual(await readRegular(path.join(root,'common',path.basename(filename))),await readRegular(filename));
 const originals=rawRows(await readRegular(path.join(root,'original-observations.txt'))),common=rawRows(await readRegular(path.join(root,'common-observations.txt'))),failures=rawRows(await readRegular(path.join(root,'reporter-failure-observations.txt')));
 const originalCore=core(originals),commonCore=core(common),failureCore=core(failures);assert.equal(originals.length,88);assert.equal(common.length,176);assert.equal(failures.length,176);
 assert.deepEqual(originalCore.map(row=>row.split('\t')[1]),ids());assert.deepEqual(commonCore,originalCore);assert.deepEqual(failureCore.map(row=>row.split('\t')[1]),ids());
 fullReporters(common,commonCore);fullReporters(failures,failureCore);
 for(let n=0;n<commonCore.length;n++){const normal=commonCore[n].split('\t'),failure=failureCore[n].split('\t');assert.equal(normal.length,10);assert.deepEqual(failure.slice(4),normal.slice(4));
  if(expectsReporter(normal[1])){assert.equal(normal[2],'java.lang.IllegalStateException');assert.equal(failure[2],'java.lang.IllegalArgumentException');assert.equal(failure[3],Buffer.from('reporter Ω','utf16le').swap16().toString('hex'));}
  else assert.deepEqual(failure,normal);
  assert.equal(normal[9],/:-(?:1|2)(?::|$)/.test(normal[1])?'':'getText');}
 const projection=receipts.projection,pr=boundedRoot(projection.artifactRoot);assert.equal(projection.kind,'exact-comment-methods-required-real-host-names');falseFields(projection);
 assert.equal(projection.sourceFlagsSha256,flagsHash);assert.equal(projection.fixtureRoot,runtime.artifactRoot);
 commands(projection,['original-exact-comment-methods-genuine-ast-jvm-build','original-exact-comment-methods-genuine-ast-jvm-observe','common-exact-comment-methods-genuine-ast-jvm-build',
  'common-exact-comment-methods-genuine-ast-jvm-observe','common-exact-comment-methods-genuine-ast-wasm-klib','common-exact-comment-methods-genuine-ast-wasm-module','common-exact-comment-methods-node-wasm-observe'],bootstrap);
 await artifacts(pr,projection,'projection.json',['original.jar','common.jar','original.kt','common.kt','CommentFixtures.kt','JsCommentTypeNameReporter.kt','JvmNames.kt','WasmNames.kt','JvmEntry.kt','WasmEntry.kt',
  'original-jvm.txt','common-jvm.txt','common-node-wasm.txt','raw-host-name-differences.json','klib/comment-methods.klib','wasm/comment-methods.mjs','wasm/comment-methods.wasm']);
 const registry=await json(path.join(HERE,'../registry/registry-evidence.json'));assert.deepEqual(projection.existingRequiredFlags,registry.requiredFlags);assert.deepEqual(registry.requiredFlags,['-Xwasm-kclass-fqn']);
 for(const name of ['CommentFixtures.kt','JsCommentTypeNameReporter.kt'])assert.deepEqual(await readRegular(path.join(pr,name)),await readRegular(path.join(HERE,name)));
 assert.equal((await readRegular(path.join(pr,'JvmNames.kt'))).toString(),'package org.jetbrains.kotlin.js.commentprobe\nimport org.jetbrains.kotlin.js.backend.ast.JsComment\nfun hostCommentName(comment:JsComment):String=comment.javaClass.name\n');
 assert.equal((await readRegular(path.join(pr,'WasmNames.kt'))).toString(),'package org.jetbrains.kotlin.js.commentprobe\nimport org.jetbrains.kotlin.js.backend.ast.JsComment\nfun hostCommentName(comment:JsComment):String=comment::class.toString()\n');
 const row=inventory.files.find(x=>x.kind==='serializer'),previous=await json(path.join(HERE,'../serializer-output-bindings/sources.lock.json')),originalPin=previous.originalSources.find(x=>x.path===row.path);
 const original=verifyFile(await readRegular(path.join(fixture.options.sourceRoot,row.path)),originalPin),prepared=verifyFile(await readRegular(path.join(fixture.component.outputRoot,row.path)),row.output),observer=await readRegular(path.join(HERE,'MethodProbe.kt'));
 assert.deepEqual(projection.originalPin,originalPin);assert.deepEqual(projection.preparedPin,row.output);assert.equal(projection.projections.length,2);
 for(const variant of ['original','common']){const regenerated=projectCommentMethods({original,prepared,originalPin,preparedPin:row.output,variant,observer}),pin=projection.projections.find(x=>x.variant===variant);
  assert.deepEqual(regenerated.bytes,await readRegular(path.join(pr,variant+'.kt')));assert.deepEqual(regenerated.spans,pin.spans);assert.equal(pin.fullSerializer,false);assert.equal(pin.shippingSource,false);}
 for(const filename of dependencies)assert.deepEqual(await readRegular(path.join(pr,'dependencies',path.basename(filename))),await readRegular(filename));
 const po=rawRows(await readRegular(path.join(pr,'original-jvm.txt'))),pj=rawRows(await readRegular(path.join(pr,'common-jvm.txt'))),pw=rawRows(await readRegular(path.join(pr,'common-node-wasm.txt')));
 assert.equal(po.length,352);assert.equal(pj.length,352);assert.equal(pw.length,352);
 const normalProjection=rows=>core(rows).filter(line=>!line.startsWith('core\tthrow:'));assert.deepEqual(normalProjection(pj),normalProjection(po));assert.deepEqual(core(pj).map(line=>line.split('\t')[1]),ids().concat(ids('throw:')));
 assert.equal(projection.originalCommonJvmCoreRecords,88);assert.equal(projection.commonJvmWasmRecords,352);
 for(const line of normalProjection(po).filter(x=>x.startsWith('core\tdirect:')||x.startsWith('core\ttext-failure:'))){const m=line.split('\t'),f=originalCore.find(x=>x.split('\t')[1]===m[1]).split('\t');assert.equal(m[3],f[3]);assert.equal(m[4],f[4]);assert.equal(m[5],f[9]);}
 const differences=[];for(let n=0;n<pj.length;n++){const a=pj[n].split('\t'),b=pw[n].split('\t');assert.deepEqual(a.slice(0,3),b.slice(0,3));
  if(a[0]==='core')assert.deepEqual(a.slice(4),b.slice(4));else assert.deepEqual(a,b);
  if(pj[n]!==pw[n]){assert.equal(a[0],'core');assert.equal(a[2],'IllegalStateException');assert(!a[1].startsWith('throw:'));differences.push({index:n,commonJvm:pj[n],nodeWasm:pw[n]});}}
 assert.equal(differences.length,63);assert.deepEqual(differences,projection.nodeWasmRawNameDifferences);assert.deepEqual(differences,await json(path.join(pr,'raw-host-name-differences.json')));
 for(const rows of [pj,pw]){for(let n=0;n<rows.length;n+=2){const c=rows[n].split('\t'),r=rows[n+1].split('\t');assert.equal(c[0],'core');assert.equal(r[0],'reporter');assert.equal(c[1],r[1]);assert.equal(r[2],expectsReporter(c[1])?'1':'0');assert.equal(r[3],expectsReporter(c[1])?'receiver-identical:'+c[4]:'');}}
 for(const field of ['bytesAndTextGetterOrderJvmWasmEqual','reporterIdentityCountAndPartialBytesVerified'])assert.equal(projection[field],true);
 const guards=receipts.guards;assert.equal(guards.kind,'required-comment-type-name-source-and-selection-guards');falseFields(guards,['fullGraphRebuilt','fullCompilerBuilt','languageReadiness']);
 const guardBytes=await pinAt(REPO,guards.rawReceipt),rawGuard=JSON.parse(guardBytes);assert.deepEqual(guards.guards,rawGuard.guards);
 assert.deepEqual(guards.guards.map(x=>x.name),['new-hierarchy-consumer-before','new-hierarchy-consumer-after','new-reporter-consumer-before','new-reporter-consumer-after',
  'duplicate-logical-final-source','actual-excluded-wasm-override-reintroduced','changed-known-caller-body','missing-required-helper','noncanonical-final-helper-filename',
  'noncanonical-prior-source-list','changed-exact-predecessor-transform-span','changed-real-final-output','false-complete-compiler-receipt',
  'early-replay-rejects-late-mutated-snapshot','unrecorded-ast-class-import-after','noncanonical-prior-source-list-after']);assert(guards.guards.every(x=>x.rejected));
 for(const field of ['openExternalCommentAccepted','lateRecordedImportsAccepted','earlyMutableSnapshotNotReopened']){assert.equal(guards[field],true);assert.equal(rawGuard[field],true);}
 assert.equal(guards.selectedBefore,3515);assert.equal(guards.selectedAfter,3516);const gr=boundedRoot(guards.artifactRoot);
 for(const [subroot,result] of [['profile',rawGuard.final],['late-profile',rawGuard.lateFinal]]){
  const options={...fixture.options,outputRoot:path.join(gr,subroot),retainedSources:result.final.inputs};assert.deepEqual(await reconstructSerializerCommentTypeNamePredecessorSelection(options),result);}
 assert.equal(sha256(await readRegular(path.join(gr,'late-profile/serializer-comment-type-names-inputs.json'))),rawGuard.earlyReceiptSha256);
 // A second exact snapshot is from the most recent preparation failure, whose
 // final source-map guard recorded the real selection before compiler launch.
 // Substitute only our three verified outputs and helper for this guard replay.
 const latestPin={path:'out/kotlin-serializer-final-root-validation-1791649280681598418/serializer-final.json',bytes:1638202,sha256:'ebdec5ff3459e9da6499d05a3a0f0cdb6f95918d910430c8cf74da1d5a3d379d'},
  latestReceiptPin={path:'out/kotlin-serializer-final-root-validation-1791649280681598418/receipt.json',bytes:1664,sha256:'bfe8a3f3c1bc1b4d7b70e034ecf0a6187f6e99caa45d2e6118d0aa877f48756e'};
 const latest=JSON.parse(await pinAt(REPO,latestPin)),latestReceipt=JSON.parse(await pinAt(REPO,latestReceiptPin));
 assert.equal(latest.phase,'after');assert.equal(latest.inputs.length,3520);assert.equal(latestReceipt.selectedSources,3520);falseFields(latestReceipt,['compilerInvoked','fullCompilerBuilt','languageReadiness']);
 const failedPin=latestReceipt.failedReceipt;assert(failedPin.filename.startsWith(path.join(REPO,'out')+path.sep));
 const failedBytes=await readRegular(failedPin.filename,32*1024*1024);assert.equal(failedBytes.length,failedPin.bytes);assert.equal(sha256(failedBytes),failedPin.sha256);
 const failed=JSON.parse(failedBytes);assert.deepEqual(failed.commands,[]);
 assert.deepEqual(latest.inputs,failed.sourceMapRuntimeFinalReceipt.inspected.slice().sort((a,b)=>a.path.localeCompare(b.path)));
 const latestAfter=latest.inputs.map(pin=>{const output=fixture.component.receipt.files.find(x=>x.path===pin.path);return output?
  {path:pin.path,filename:path.join(fixture.component.outputRoot,pin.path),bytes:output.bytes,sha256:output.sha256}:pin;});
 const helper=fixture.component.receipt.files.at(-1);latestAfter.push({path:helper.path,filename:path.join(fixture.component.outputRoot,helper.path),bytes:helper.bytes,sha256:helper.sha256});
 const latestFinal=await reconstructSerializerCommentTypeNamePredecessorSelection({...fixture.options,retainedSources:latestAfter});assert.equal(latestFinal.actualFinalSources,3521);
 return {unitFiles:manifest.unitFiles.length+1,originalCommonJvmCoreRecords:88,commonReporterRecords:88,reporterFailureRecords:88,commonJvmWasmRecords:352,rawHostNameDifferences:63,
  guardsPassed:16,lateRecordedImportsAccepted:true,latestActualSourcesBefore:3520,latestActualSourcesAfterGuardSubstitution:3521,
  fullSerializerWasmExecuted:false,fullCompilerBuilt:false,languageReadiness:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)console.log(JSON.stringify(await verifySerializerCommentTypeNameEvidence()));
