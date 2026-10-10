import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertNoSymlink,readRegular,sha256,verifyFile,writeJson} from '../../scripts/source.mjs';
import {verifySerializerOutputBindings,verifySerializerOutputSelection} from '../serializer-output-bindings/prepare.mjs';
import {normalizeRecordedImports,HIERARCHY_PATTERN} from '../serializer-output-bindings/transform.mjs';
import {transformCommentTypeNames} from './transform.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
const REPORTER_PATTERN=/\bJsCommentTypeNameReporter\b/;
async function localInputs() {
    const bytes=await readRegular(path.join(HERE,'sources.lock.json')),lock=JSON.parse(bytes),inventory=JSON.parse(await readRegular(path.join(HERE,'inventory.json')));
    assert.equal(lock.kind,'required-serializer-comment-type-name-host-boundary');
    assert.equal(lock.source.commit,'4d78aae1e337cd40f69baa865aed950fe807a775');
    for(const pin of lock.dependencies)verifyFile(await readRegular(path.resolve(HERE,pin.path)),pin);
    verifyFile(await readRegular(path.join(HERE,'JsCommentTypeNameReporter.kt')),lock.helper);
    const previous=JSON.parse(await readRegular(path.join(HERE,'../serializer-output-bindings/sources.lock.json')));
    assert.deepEqual(lock.sourceSetExclusions,previous.sourceSetExclusions);
    assert.deepEqual(lock.recordedPropertyImports,previous.recordedPropertyImports);
    assert.deepEqual(lock.otherConsumers,previous.consumerBodies.filter(x=>!inventory.files.some(row=>row.path===x.path)));
    assert.equal(inventory.files.length,3);assert.equal(lock.otherConsumers.length,4);assert.equal(lock.sourceSetExclusions.length,21);
    return {lock,inventory,lockSha256:sha256(bytes)};
}
async function predecessor(options,i,{replay=true}={}) {
    const p=options.preparedSerializerOutput,o=options.serializerOutputOptions;
    assert(p?.receiptPath&&p?.outputRoot&&Array.isArray(p.commonSources));assert(o);
    assert.equal(path.resolve(o.sourceRoot),path.resolve(options.sourceRoot));assert.equal(path.resolve(o.outputRoot),path.resolve(p.outputRoot));
    assert.equal(path.resolve(p.receiptPath),path.join(path.resolve(p.outputRoot),'serializer-output-inputs.json'));
    // Full ancestry is verified before the build mutates its selected sources.
    // At final selection the root binds this exact earlier receipt SHA; reading
    // old retainedSources filenames would incorrectly treat late imports as the
    // original preparation snapshot.
    const receiptBytes=await readRegular(p.receiptPath),receipt=JSON.parse(receiptBytes);assert.deepEqual(receipt,p.receipt);
    if(replay)assert.deepEqual(await verifySerializerOutputBindings(o),receipt);
    assert.deepEqual(receipt.files,i.inventory.files.map(row=>({path:row.path,...row.input})));
    assert.deepEqual(p.commonSources,receipt.files.map(row=>path.join(path.resolve(p.outputRoot),row.path)));
    const files=[];
    for(const row of i.inventory.files){const filename=path.join(path.resolve(p.outputRoot),row.path),bytes=verifyFile(await readRegular(filename),row.input);
        files.push({row,filename,bytes,output:transformCommentTypeNames(bytes,row)});}
    return {receipt,receiptSha256:sha256(receiptBytes),files,bindings:files.map(({row,filename})=>({component:'serializerOutputReceipt',componentRelativePath:row.path,filename,...row.input,receiptSha256:sha256(receiptBytes)}))};
}
async function audit(options,i,phase) {
    assert(['before','after'].includes(phase));assert(Array.isArray(options.retainedSources)&&options.retainedSources.length>0);
    const seen=new Set(),inputs=[],consumers=[],reporterConsumers=[];
    const helperKey=i.lock.helper.outputPath;
    for(let offset=0;offset<options.retainedSources.length;offset+=24){
        const batch=await Promise.allSettled(options.retainedSources.slice(offset,offset+24).map(async pin=>{
            assert(typeof pin.path==='string'&&pin.path.endsWith('.kt'));assert(!seen.has(pin.path),'Duplicate selected logical source');seen.add(pin.path);
            assert(path.isAbsolute(pin.filename));const bytes=await readRegular(pin.filename);assert.equal(bytes.length,pin.bytes);assert.equal(sha256(bytes),pin.sha256);
            return {pin,bytes};}));
        for(const result of batch){if(result.status!=='fulfilled')throw result.reason;const {pin,bytes}=result.value;
            assert(!i.lock.sourceSetExclusions.some(key=>pin.path===key||pin.path.endsWith('/'+key)),'Excluded actual IC source reintroduced');
            const canonical=normalizeRecordedImports(bytes,i.lock.recordedPropertyImports),text=canonical.toString();inputs.push({path:pin.path,filename:pin.filename,bytes:pin.bytes,sha256:pin.sha256});
            const row=i.inventory.files.find(x=>x.path===pin.path),other=i.lock.otherConsumers.find(x=>x.path===pin.path),helper=pin.path===helperKey;
            if(row){verifyFile(canonical,phase==='after'?row.output:row.input);
                assert.equal(path.resolve(pin.filename),path.join(path.resolve(phase==='after'?options.outputRoot:options.preparedSerializerOutput.outputRoot),row.path),'Noncanonical genuine prepared consumer');}
            if(helper){assert.equal(phase,'after');verifyFile(canonical,i.lock.helper);assert.equal(path.resolve(pin.filename),path.join(path.resolve(options.outputRoot),helperKey));}
            if(HIERARCHY_PATTERN.test(text)){assert(row||other,'Unknown serializer hierarchy consumer');if(other)verifyFile(canonical,other);consumers.push(pin.path);}
            if(REPORTER_PATTERN.test(text)){assert.equal(phase,'after');assert(row||helper,'Unknown host type-name reporter consumer');reporterConsumers.push(pin.path);}
        }
    }
    assert.deepEqual(consumers.sort(),[...i.inventory.files,...i.lock.otherConsumers].map(x=>x.path).sort());
    assert.deepEqual(reporterConsumers.sort(),phase==='after'?[...i.inventory.files.map(x=>x.path),helperKey].sort():[]);
    return {phase,inputs:inputs.sort((a,b)=>a.path.localeCompare(b.path)),consumers,reporterConsumers};
}
function receipt(i,p,hierarchy) {
    return {schemaVersion:1,kind:'required-serializer-comment-type-name-preparation',source:i.lock.source,sourceLockSha256:i.lockSha256,
        files:[...i.inventory.files.map(row=>({path:row.path,...row.output})),{...i.lock.helper,path:i.lock.helper.outputPath}],
        predecessorBindings:p.bindings,predecessorReceiptSha256:p.receiptSha256,sourceSetExclusions:i.lock.sourceSetExclusions,hierarchy,
        requiredCallerOwnedReporter:true,shippingDefaultReporter:false,openCommentImplementationsPreserved:true,
        originalTypeTestsPreserved:true,commentTextWrittenBeforeReporter:true,jvmBinaryNameParity:false,
        newSourceExclusions:false,finalSelectionGuardRequired:true,fullSerializerWasmExecuted:false,fullCompilerBuilt:false,languageReadiness:false};
}
export async function prepareSerializerCommentTypeNames(options) {
    const outputRoot=path.resolve(options.outputRoot);assert(outputRoot.startsWith(path.join(REPO,'out')+path.sep));await assertNoSymlink(outputRoot);
    const i=await localInputs(),p=await predecessor(options,i);
    const hierarchy=await audit(options,i,'before');await verifySerializerOutputSelection({sourceRoot:options.sourceRoot,outputRoot:options.preparedSerializerOutput.outputRoot,retainedSources:options.retainedSources});
    const commonSources=[];
    for(const {row,bytes,output} of p.files)for(const [prefix,b] of [['',output],['reference',bytes]]){
        const filename=path.join(outputRoot,prefix,row.path);await assertNoSymlink(filename);await mkdir(path.dirname(filename),{recursive:true,mode:0o700});await writeFile(filename,b,{flag:'wx',mode:0o600});if(!prefix)commonSources.push(filename);}
    const helper=path.join(outputRoot,i.lock.helper.outputPath);await mkdir(path.dirname(helper),{recursive:true,mode:0o700});await writeFile(helper,await readRegular(path.join(HERE,'JsCommentTypeNameReporter.kt')),{flag:'wx',mode:0o600});commonSources.push(helper);
    const r=receipt(i,p,hierarchy),receiptPath=path.join(outputRoot,'serializer-comment-type-names-inputs.json');await writeJson(receiptPath,r);
    return {outputRoot,receipt:r,receiptPath,commonSources,predecessorBindings:p.bindings,replacedOriginalPaths:i.inventory.files.map(x=>x.path),finalSelectionGuardRequired:true};
}
export async function verifySerializerCommentTypeNames(options) {
    const i=await localInputs(),p=await predecessor(options,i),hierarchy=await audit(options,i,'before'),r=receipt(i,p,hierarchy);
    assert.deepEqual(JSON.parse(await readRegular(path.join(options.outputRoot,'serializer-comment-type-names-inputs.json'))),r);
    for(const {row,bytes,output} of p.files){assert.deepEqual(await readRegular(path.join(options.outputRoot,row.path)),output);assert.deepEqual(await readRegular(path.join(options.outputRoot,'reference',row.path)),bytes);}
    assert.deepEqual(await readRegular(path.join(options.outputRoot,i.lock.helper.outputPath)),await readRegular(path.join(HERE,'JsCommentTypeNameReporter.kt')));
    await verifySerializerOutputSelection({sourceRoot:options.sourceRoot,outputRoot:options.preparedSerializerOutput.outputRoot,retainedSources:options.retainedSources});return r;
}
/** Verify real final bytes first; only then construct the exact authentic earlier view. */
export async function reconstructSerializerCommentTypeNamePredecessorSelection(options) {
    const i=await localInputs(),p=await predecessor(options,i,{replay:false}),r=JSON.parse(await readRegular(path.join(options.outputRoot,'serializer-comment-type-names-inputs.json')));
    assert.equal(r.sourceLockSha256,i.lockSha256);assert.equal(r.predecessorReceiptSha256,p.receiptSha256);assert.deepEqual(r.predecessorBindings,p.bindings);
    // Recorded early metadata is evidence only. Do not reopen mutable early
    // filenames. The caller must bind the raw new receipt SHA before late edits.
    assert.equal(r.hierarchy.phase,'before');assert.deepEqual(r.hierarchy.reporterConsumers,[]);
    assert.deepEqual(r.hierarchy.consumers,[...i.inventory.files,...i.lock.otherConsumers].map(x=>x.path).sort());
    assert(Array.isArray(r.hierarchy.inputs)&&r.hierarchy.inputs.length>0);
    const recorded=new Set();for(const pin of r.hierarchy.inputs){
        assert.deepEqual(Object.keys(pin).sort(),['bytes','filename','path','sha256']);
        assert(typeof pin.path==='string'&&pin.path.endsWith('.kt')&&!recorded.has(pin.path));recorded.add(pin.path);
        assert(path.isAbsolute(pin.filename));assert(Number.isSafeInteger(pin.bytes)&&pin.bytes>0);assert(/^[a-f0-9]{64}$/.test(pin.sha256));
    }
    assert.deepEqual(r.hierarchy.inputs.map(pin=>pin.path),[...recorded].sort((a,b)=>a.localeCompare(b)));
    assert.deepEqual(r,receipt(i,p,r.hierarchy));
    for(const {row,bytes,output} of p.files){assert.deepEqual(normalizeRecordedImports(await readRegular(path.join(options.outputRoot,row.path)),i.lock.recordedPropertyImports),output);assert.deepEqual(await readRegular(path.join(options.outputRoot,'reference',row.path)),bytes);}
    assert.deepEqual(normalizeRecordedImports(await readRegular(path.join(options.outputRoot,i.lock.helper.outputPath)),i.lock.recordedPropertyImports),await readRegular(path.join(HERE,'JsCommentTypeNameReporter.kt')));
    const final=await audit(options,i,'after'),selected=options.retainedSources.filter(x=>x.path!==i.lock.helper.outputPath).map(pin=>{
        const previous=p.bindings.find(x=>x.componentRelativePath===pin.path);return previous?{path:pin.path,filename:previous.filename,bytes:previous.bytes,sha256:previous.sha256}:pin;});
    const predecessorSelection=await verifySerializerOutputSelection({sourceRoot:options.sourceRoot,outputRoot:options.preparedSerializerOutput.outputRoot,retainedSources:selected});
    return {final,retainedSources:selected,predecessorSelection,canonicalReconstruction:true,actualFinalSources:final.inputs.length,
        reconstructedPaths:i.inventory.files.map(x=>x.path),removedHelperPath:i.lock.helper.outputPath,fullGraphRebuilt:false,fullSerializerWasmExecuted:false};
}
