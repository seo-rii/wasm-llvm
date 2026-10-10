import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertNoSymlink,readRegular,sha256,verifyFile,writeJson} from '../../scripts/source.mjs';
import {verifySerializerNullability} from '../serializer-nullability/prepare.mjs';
import {verifyBackendProfilePreparation} from '../backend-profile/prepare.mjs';
import {verifyJsAstOutput} from '../js-ast-consumer-bindings/output-codec/prepare.mjs';
import {verifyJsAstOutputStream} from '../js-ast-consumer-bindings/output-stream/prepare.mjs';
import {verifyCompilerTextPreparation} from '../text/prepare.mjs';
import {applyExact,normalizeRecordedImports,HIERARCHY_PATTERN} from './transform.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
const componentRoot=component=>path.dirname(component.receiptPath);

async function localInputs(sourceRoot){
 const bytes=await readRegular(path.join(HERE,'sources.lock.json')),lock=JSON.parse(bytes);
 assert.equal(lock.kind,'selected-full-serializer-output-bindings');
 assert.equal(sha256(await readRegular(path.join(HERE,'../closure.lock.json'))),lock.primaryClosureSha256);
 for(const pin of lock.tools)verifyFile(await readRegular(path.join(HERE,pin.path)),pin);
 for(const pin of lock.dependencyLocks)assert.equal(sha256(await readRegular(path.join(HERE,pin.path))),pin.sha256);
 for(const pin of lock.originalSources)verifyFile(await readRegular(path.join(sourceRoot,pin.path)),pin);
 return {lock,lockSha256:sha256(bytes),inventory:JSON.parse(await readRegular(path.join(HERE,'inventory.json')))};
}

export async function auditSerializerOutputHierarchy({retainedSources,lock,inventory,phase}){
 assert(['before','after'].includes(phase));assert(Array.isArray(retainedSources)&&retainedSources.length>0);
 const seen=new Set(),found=[],bindings=[];
 for(let offset=0;offset<retainedSources.length;offset+=24){
  const batch=await Promise.allSettled(retainedSources.slice(offset,offset+24).map(async pin=>{
   assert(typeof pin.path==='string'&&pin.path.endsWith('.kt'));assert(path.isAbsolute(pin.filename));
   assert(!seen.has(pin.path),'Duplicate selected logical source');seen.add(pin.path);
   const bytes=await readRegular(pin.filename);assert.equal(bytes.length,pin.bytes);assert.equal(sha256(bytes),pin.sha256);
   return {pin,bytes};
  }));
  for(const result of batch){
   if(result.status!=='fulfilled')throw result.reason;const {pin,bytes}=result.value;
   assert(!lock.sourceSetExclusions.some(key=>pin.path===key||pin.path.endsWith('/'+key)),'Excluded IC source reintroduced');
   const canonical=normalizeRecordedImports(bytes,lock.recordedPropertyImports);
   bindings.push({path:pin.path,filename:pin.filename,bytes:pin.bytes,sha256:pin.sha256});
   if(!HIERARCHY_PATTERN.test(canonical.toString()))continue;
   const expected=lock.consumerBodies.find(row=>row.path===pin.path);assert(expected,'New selected serializer/shared-hierarchy consumer: '+pin.path);
   const transformed=inventory.files.find(row=>row.path===pin.path);
   const expectedPin=phase==='after'&&transformed?transformed.output:expected;
   assert.equal(sha256(canonical),expectedPin.sha256,'Changed selected serializer/shared-hierarchy consumer: '+pin.path);
   assert.equal(canonical.length,expectedPin.bytes);found.push(pin.path);
  }
 }
 assert.deepEqual(found.sort(),lock.consumerBodies.map(x=>x.path).sort(),'Changed selected serializer consumer closure');
 return {phase,inputs:bindings.sort((a,b)=>a.path.localeCompare(b.path)),consumers:found};
}

async function inputs(options){
 const i=await localInputs(options.sourceRoot),{lock,inventory}=i;
 const nullable=options.preparedSerializerNullability;assert(nullable?.receiptPath&&nullable.commonSources.length===1);
 assert.equal(path.basename(nullable.receiptPath),'serializer-nullability-inputs.json');
 const nr=await verifySerializerNullability({sourceRoot:options.sourceRoot,outputRoot:componentRoot(nullable),preparedJsAst:options.preparedJsAst});assert.deepEqual(nr,nullable.receipt);
 assert.deepEqual(nullable.commonSources,[path.join(componentRoot(nullable),nr.consumer.path)],'Noncanonical nullable predecessor sources');
 const profile=options.preparedBackendProfile;assert.equal(path.basename(profile.receiptPath),'receipt.json');
 const bp=await verifyBackendProfilePreparation(componentRoot(profile));assert.deepEqual(bp.receipt,profile.receipt);
 assert.deepEqual(bp.commonSources,profile.commonSources);assert.deepEqual(bp.sourceSetExclusions,lock.sourceSetExclusions);
 assert.equal(bp.receipt.sourceLockSha256,lock.backendProfileSourceLockSha256);
 const dependencies=[];
 for(const [name,component,verify]of [['jsAstOutputReceipt',options.preparedOutputCodec,verifyJsAstOutput],['jsAstOutputStreamReceipt',options.preparedOutputStream,verifyJsAstOutputStream]]){
  const receipt=await verify({sourceRoot:options.sourceRoot,outputRoot:componentRoot(component),receiptPath:component.receiptPath});assert.deepEqual(receipt,component.receipt);
  assert.equal(path.resolve(component.receiptPath),path.join(componentRoot(component),name==='jsAstOutputReceipt'?'output-inputs.json':'output-stream-inputs.json'));
  assert.deepEqual(component.commonSources,[path.join(componentRoot(component),receipt.file.path)]);
  dependencies.push({component:name,componentRelativePath:receipt.file.path,filename:component.commonSources[0],path:receipt.file.path,bytes:receipt.file.bytes,sha256:receipt.file.sha256,receiptSha256:sha256(await readRegular(component.receiptPath))});
 }
 const text=options.preparedText;const tv=await verifyCompilerTextPreparation(componentRoot(text));assert.deepEqual(tv.receipt,text.receipt);assert.deepEqual(tv.commonSources,text.commonSources);
 assert.equal(path.basename(tv.root),'compiler-port-text');
 for(const filename of tv.commonSources.filter(x=>/CompilerUtf8(?:Api|Algorithm)\.kt$/.test(x))){
  const bytes=await readRegular(filename),logicalPath='compiler-port-text/'+path.relative(tv.root,filename).split(path.sep).join('/');
  dependencies.push({component:'textReceipt',componentRelativePath:logicalPath,filename,path:logicalPath,bytes:bytes.length,sha256:sha256(bytes),receiptSha256:tv.receiptSha256});
 }
 assert.equal(dependencies.length,4);
 const carrier=inventory.files.find(x=>x.kind==='carrier');const carrierKey=carrier.path.slice('compiler-port-backend-profile/'.length);
 const cf=bp.commonSources.find(x=>x.endsWith('/'+carrierKey));assert(cf);const carrierBytes=verifyFile(await readRegular(cf),carrier.input);
 const sf=nullable.commonSources[0],serializerBytes=verifyFile(await readRegular(sf),inventory.files.find(x=>x.kind==='serializer').input);
 const fragment=inventory.files.find(x=>x.kind==='fragments'),jf=path.join(options.sourceRoot,fragment.path),fragmentBytes=verifyFile(await readRegular(jf),fragment.input);
 const predecessors=[{component:'serializerNullabilityReceipt',componentRelativePath:nr.consumer.path,filename:sf,...nr.prepared,receiptSha256:sha256(await readRegular(nullable.receiptPath))},
  {component:'backendProfileReceipt',componentRelativePath:carrier.path,filename:cf,...carrier.input,receiptSha256:bp.receiptSha256}];
 const files=inventory.files.map(row=>{const source=row.kind==='serializer'?serializerBytes:row.kind==='carrier'?carrierBytes:fragmentBytes;const output=verifyFile(applyExact(source,row.changes),row.output);return {row,source,output};});
 return {...i,files,predecessors,dependencies,hierarchy:await auditSerializerOutputHierarchy({retainedSources:options.retainedSources,lock,inventory,phase:'before'}),backendProfileReceiptSha256:bp.receiptSha256};
}
function receiptFor(i){return {schemaVersion:1,kind:'selected-full-serializer-output-preparation',source:i.lock.source,sourceLockSha256:i.lockSha256,
 files:i.files.map(x=>({path:x.row.path,...x.row.output})),predecessorBindings:i.predecessors,dependencies:i.dependencies,
 sourceSetExclusions:i.lock.sourceSetExclusions,backendProfileReceiptSha256:i.backendProfileReceiptSha256,hierarchy:i.hierarchy,
 serializerTransportSpans:16,carrierSignatureSpans:2,fragmentSignatureSpans:2,nullableChecksPreserved:true,newSourceExclusions:false,
 requestWorkerSerialProfile:true,backingArrayIdentityParity:false,threadDeathPrecedence:false,qualifiedNameHostClosed:false,
 finalSelectionGuardRequired:true,fullSerializerWasmExecuted:false,fullCompilerBuilt:false,languageReadiness:false};}
export async function prepareSerializerOutputBindings(options){
 const outputRoot=path.resolve(options.outputRoot);assert(outputRoot.startsWith(path.join(REPO,'out')+path.sep));await assertNoSymlink(outputRoot);
 const i=await inputs(options),receipt=receiptFor(i),commonSources=[];
 for(const {row,source,output}of i.files){for(const [prefix,bytes]of [['',output],['reference',source]]){
  const filename=path.join(outputRoot,prefix,row.path);await assertNoSymlink(filename);await mkdir(path.dirname(filename),{recursive:true,mode:0o700});await writeFile(filename,bytes,{flag:'wx',mode:0o600});if(!prefix)commonSources.push(filename);
 }}
 const receiptPath=path.join(outputRoot,'serializer-output-inputs.json');await writeJson(receiptPath,receipt);
 return {outputRoot,commonSources,receipt,receiptPath,predecessorBindings:i.predecessors,sharedDependencies:i.dependencies,replacedOriginalPaths:receipt.files.map(x=>x.path),finalSelectionGuardRequired:true};
}
export async function verifySerializerOutputBindings(options){
 const i=await inputs(options),receipt=receiptFor(i);assert.deepEqual(JSON.parse(await readRegular(path.join(options.outputRoot,'serializer-output-inputs.json'))),receipt);
 for(const {row,source}of i.files){verifyFile(await readRegular(path.join(options.outputRoot,row.path)),row.output);assert.deepEqual(await readRegular(path.join(options.outputRoot,'reference',row.path)),source);}return receipt;
}
export async function verifySerializerOutputSelection({sourceRoot,outputRoot,retainedSources}){
 const i=await localInputs(sourceRoot),receipt=JSON.parse(await readRegular(path.join(outputRoot,'serializer-output-inputs.json')));
 assert.equal(receipt.schemaVersion,1);assert.equal(receipt.kind,'selected-full-serializer-output-preparation');
 assert.deepEqual(receipt.source,i.lock.source);assert.equal(receipt.sourceLockSha256,i.lockSha256);
 assert.deepEqual(receipt.files,i.inventory.files.map(row=>({path:row.path,...row.output})));
 assert.deepEqual(receipt.sourceSetExclusions,i.lock.sourceSetExclusions);
 assert.equal(receipt.backendProfileReceiptSha256,receipt.predecessorBindings[1].receiptSha256);
 assert.equal(receipt.serializerTransportSpans,16);assert.equal(receipt.carrierSignatureSpans,2);assert.equal(receipt.fragmentSignatureSpans,2);
 for(const flag of ['nullableChecksPreserved','requestWorkerSerialProfile','finalSelectionGuardRequired'])assert.equal(receipt[flag],true);
 for(const flag of ['newSourceExclusions','backingArrayIdentityParity','threadDeathPrecedence','qualifiedNameHostClosed','fullSerializerWasmExecuted','fullCompilerBuilt','languageReadiness'])assert.equal(receipt[flag],false);
 assert.deepEqual(receipt.hierarchy.consumers.slice().sort(),i.lock.consumerBodies.map(row=>row.path).sort());
 assert.equal(receipt.predecessorBindings.length,2);
 for(const [index,kind,component]of [[0,'serializer','serializerNullabilityReceipt'],[1,'carrier','backendProfileReceipt']]){
  const row=i.inventory.files.find(x=>x.kind===kind),binding=receipt.predecessorBindings[index];
  assert.equal(binding.component,component);assert.equal(binding.componentRelativePath,row.path);
  for(const key of ['bytes','sha256','gitBlob'])assert.equal(binding[key],row.input[key]);
 }
 for(const row of i.inventory.files){
  const pin=retainedSources.find(x=>x.path===row.path);assert(pin,'Missing final serializer output');
  assert.equal(path.resolve(pin.filename),path.join(path.resolve(outputRoot),row.path));
  verifyFile(await readRegular(path.join(outputRoot,'reference',row.path)),row.input);
 }
 return auditSerializerOutputHierarchy({retainedSources,lock:i.lock,inventory:i.inventory,phase:'after'});
}
