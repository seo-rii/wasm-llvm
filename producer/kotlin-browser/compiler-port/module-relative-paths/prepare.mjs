import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertNoSymlink,readRegular,sha256,verifyFile,writeJson} from '../../scripts/source.mjs';
import {verifySerializerCommentTypeNames,reconstructSerializerCommentTypeNamePredecessorSelection} from '../serializer-comment-type-names/prepare.mjs';
import {normalizeRecordedImports} from '../serializer-output-bindings/transform.mjs';
import {bindModuleRequirePaths} from './transform.mjs';
import {modulePathReferences} from './references.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
const HELPER_USE=/\b(?:relativeModuleRequirePath|org\.jetbrains\.kotlin\.js\.portable\.modules)\b/;
async function localInputs() {
    const bytes=await readRegular(path.join(HERE,'sources.lock.json')),lock=JSON.parse(bytes);
    assert.equal(lock.kind,'genuine-posix-module-relative-require-path');
    assert.equal(lock.source.commit,'4d78aae1e337cd40f69baa865aed950fe807a775');
    for(const pin of [...lock.tools,...lock.observers,lock.helper,...lock.licenses])verifyFile(await readRegular(path.join(HERE,pin.path)),pin);
    for(const pin of lock.dependencies)verifyFile(await readRegular(path.resolve(HERE,pin.path)),pin);
    const inventory=JSON.parse(verifyFile(await readRegular(path.join(HERE,'inventory.json')),lock.inventory));
    const previous=JSON.parse(await readRegular(path.join(HERE,'../serializer-comment-type-names/inventory.json')));
    assert.deepEqual(inventory.input,previous.files.find(row=>row.path===inventory.path).output);
    const p=JSON.parse(await readRegular(path.join(HERE,'../serializer-comment-type-names/sources.lock.json')));
    assert.deepEqual(lock.source,p.source);assert.deepEqual(lock.recordedPropertyImports,p.recordedPropertyImports);
    assert.deepEqual(lock.sourceSetExclusions,p.sourceSetExclusions);
    assert.equal(lock.hostProfile,'POSIX single-string File lexical normalization and Kotlin normalized-component toRelativeString; no cwd or filesystem access.');
    const references=await modulePathReferences();assert.deepEqual(references.files.map(({filename,...pin})=>pin),lock.references);
    return {lock,inventory,lockSha256:sha256(bytes)};
}
async function prior(options,i,replay) {
    const p=options.preparedCommentTypeNames,o=options.commentTypeNameOptions;
    assert(p?.outputRoot&&p?.receiptPath&&Array.isArray(p.commonSources));assert(o);
    assert.equal(path.resolve(options.sourceRoot),path.resolve(o.sourceRoot));
    assert.equal(path.resolve(p.outputRoot),path.resolve(o.outputRoot));
    assert.equal(path.resolve(p.receiptPath),path.join(path.resolve(p.outputRoot),'serializer-comment-type-names-inputs.json'));
    const receiptBytes=await readRegular(p.receiptPath,32*1024*1024),receipt=JSON.parse(receiptBytes);assert.deepEqual(receipt,p.receipt);
    if(replay)assert.deepEqual(await verifySerializerCommentTypeNames(o),receipt);
    const previous=JSON.parse(await readRegular(path.join(HERE,'../serializer-comment-type-names/inventory.json'))),pl=JSON.parse(await readRegular(path.join(HERE,'../serializer-comment-type-names/sources.lock.json')));
    assert.deepEqual(receipt.files,[...previous.files.map(row=>({path:row.path,...row.output})),{...pl.helper,path:pl.helper.outputPath}]);
    assert.deepEqual(p.commonSources,receipt.files.map(row=>path.join(path.resolve(p.outputRoot),row.path)));
    const filename=path.join(path.resolve(p.outputRoot),i.inventory.path),source=verifyFile(await readRegular(filename),i.inventory.input);
    const binding={component:'serializerCommentTypeNamesReceipt',componentRelativePath:i.inventory.path,filename,...i.inventory.input,receiptSha256:sha256(receiptBytes)};
    return {receipt,receiptSha256:sha256(receiptBytes),filename,source,output:bindModuleRequirePaths(source,i.inventory),binding};
}
async function audit(options,i,phase) {
    assert(['before','after'].includes(phase));assert(Array.isArray(options.retainedSources)&&options.retainedSources.length>0);
    const seen=new Set(),inputs=[],helperConsumers=[];
    for(let offset=0;offset<options.retainedSources.length;offset+=24) {
        const batch=await Promise.allSettled(options.retainedSources.slice(offset,offset+24).map(async pin=>{
            assert(typeof pin.path==='string'&&pin.path.endsWith('.kt'));assert(!seen.has(pin.path),'Duplicate selected logical source');seen.add(pin.path);
            assert(path.isAbsolute(pin.filename));const bytes=await readRegular(pin.filename);assert.equal(bytes.length,pin.bytes);assert.equal(sha256(bytes),pin.sha256);return {pin,bytes};
        }));
        for(const result of batch) {
            if(result.status!=='fulfilled')throw result.reason;
            const {pin,bytes}=result.value;assert(!i.lock.sourceSetExclusions.some(key=>pin.path===key||pin.path.endsWith('/'+key)),'Excluded native IC source reintroduced');
            const canonical=normalizeRecordedImports(bytes,i.lock.recordedPropertyImports);
            if(pin.path===i.inventory.path) {
                verifyFile(canonical,phase==='before'?i.inventory.input:i.inventory.output);
                const root=phase==='before'?options.preparedCommentTypeNames.outputRoot:options.outputRoot;
                assert.equal(path.resolve(pin.filename),path.join(path.resolve(root),pin.path),'Noncanonical genuine module consumer');
            }
            if(pin.path===i.lock.helper.outputPath) {
                assert.equal(phase,'after');verifyFile(canonical,i.lock.helper);
                assert.equal(path.resolve(pin.filename),path.join(path.resolve(options.outputRoot),pin.path));
            }
            if(HELPER_USE.test(canonical.toString())) {
                assert.equal(phase,'after');assert([i.inventory.path,i.lock.helper.outputPath].includes(pin.path),'Unknown module-relative-path helper consumer');helperConsumers.push(pin.path);
            }
            inputs.push({path:pin.path,filename:pin.filename,bytes:pin.bytes,sha256:pin.sha256});
        }
    }
    assert(seen.has(i.inventory.path),'Missing genuine module consumer');
    assert.deepEqual(helperConsumers.sort(),phase==='after'?[i.inventory.path,i.lock.helper.outputPath].sort():[]);
    return {phase,inputs:inputs.sort((a,b)=>a.path.localeCompare(b.path)),helperConsumers};
}
function receipt(i,p,selection) {
    return {schemaVersion:1,kind:'genuine-module-relative-path-preparation',source:i.lock.source,sourceLockSha256:i.lockSha256,
        files:[{path:i.inventory.path,...i.inventory.output},{...i.lock.helper,path:i.lock.helper.outputPath}],
        predecessorBindings:[p.binding],predecessorReceiptSha256:p.receiptSha256,selection,sourceSetExclusions:i.lock.sourceSetExclusions,
        hostProfile:i.lock.hostProfile,exactSourceSpans:2,parentNullRawTargetPreserved:true,completeModuleConsumerPreserved:true,
        rootAndUnmatchedParentFailuresPreserved:true,newSourceExclusions:false,javaFileFacadeIntroduced:false,
        finalSelectionGuardRequired:true,windowsHostParity:false,fullModuleGraphWasmExecuted:false,fullCompilerBuilt:false,languageReadiness:false};
}
function outputRoot(options) {
    const root=path.resolve(options.outputRoot);assert(root.startsWith(path.join(REPO,'out')+path.sep));
    assert(!root.startsWith(path.resolve(options.sourceRoot)+path.sep));assert.notEqual(root,path.resolve(options.preparedCommentTypeNames.outputRoot));return root;
}
export async function prepareModuleRequirePaths(options) {
    const root=outputRoot(options);await assertNoSymlink(root);const i=await localInputs(),p=await prior(options,i,true),selection=await audit(options,i,'before');
    await reconstructSerializerCommentTypeNamePredecessorSelection({...options.commentTypeNameOptions,retainedSources:options.retainedSources});
    const commonSources=[];
    for(const [key,bytes,compile]of [[i.inventory.path,p.output,true],['reference/'+i.inventory.path,p.source,false],[i.lock.helper.outputPath,await readRegular(path.join(HERE,i.lock.helper.path)),true]]) {
        const filename=path.join(root,key);await assertNoSymlink(filename);await mkdir(path.dirname(filename),{recursive:true,mode:0o700});await writeFile(filename,bytes,{flag:'wx',mode:0o600});if(compile)commonSources.push(filename);
    }
    const r=receipt(i,p,selection),receiptPath=path.join(root,'module-relative-path-inputs.json');await writeJson(receiptPath,r);
    return {outputRoot:root,commonSources,receipt:r,receiptPath,predecessorBindings:[p.binding],replacedOriginalPaths:[i.inventory.path],finalSelectionGuardRequired:true};
}
export async function verifyModuleRequirePaths(options) {
    const root=outputRoot(options),i=await localInputs(),p=await prior(options,i,true),selection=await audit(options,i,'before'),r=receipt(i,p,selection);
    assert.deepEqual(JSON.parse(await readRegular(path.join(root,'module-relative-path-inputs.json'),32*1024*1024)),r);
    assert.deepEqual(await readRegular(path.join(root,i.inventory.path)),p.output);assert.deepEqual(await readRegular(path.join(root,'reference',i.inventory.path)),p.source);
    assert.deepEqual(await readRegular(path.join(root,i.lock.helper.outputPath)),await readRegular(path.join(HERE,i.lock.helper.path)));
    await reconstructSerializerCommentTypeNamePredecessorSelection({...options.commentTypeNameOptions,retainedSources:options.retainedSources});return r;
}
/** Root binds the raw new receipt SHA early and verifies it before this late API. */
export async function reconstructModuleRequirePathPredecessorSelection(options) {
    const root=outputRoot(options),i=await localInputs(),p=await prior(options,i,false),r=JSON.parse(await readRegular(path.join(root,'module-relative-path-inputs.json'),32*1024*1024));
    assert.equal(r.selection.phase,'before');assert.deepEqual(r.selection.helperConsumers,[]);
    assert(Array.isArray(r.selection.inputs)&&r.selection.inputs.length>0);const seen=new Set();
    for(const pin of r.selection.inputs) {
        assert.deepEqual(Object.keys(pin).sort(),['bytes','filename','path','sha256']);assert(typeof pin.path==='string'&&pin.path.endsWith('.kt')&&!seen.has(pin.path));seen.add(pin.path);
        assert(path.isAbsolute(pin.filename));assert(Number.isSafeInteger(pin.bytes)&&pin.bytes>0);assert(/^[a-f0-9]{64}$/.test(pin.sha256));
    }
    assert.deepEqual(r.selection.inputs.map(x=>x.path),[...seen].sort((a,b)=>a.localeCompare(b)));
    assert.deepEqual(r,receipt(i,p,r.selection));
    assert.deepEqual(normalizeRecordedImports(await readRegular(path.join(root,i.inventory.path)),i.lock.recordedPropertyImports),p.output);
    assert.deepEqual(await readRegular(path.join(root,'reference',i.inventory.path)),p.source);
    assert.deepEqual(normalizeRecordedImports(await readRegular(path.join(root,i.lock.helper.outputPath)),i.lock.recordedPropertyImports),await readRegular(path.join(HERE,i.lock.helper.path)));
    const final=await audit(options,i,'after'),selected=options.retainedSources.filter(x=>x.path!==i.lock.helper.outputPath).map(pin=>pin.path===i.inventory.path?{path:pin.path,filename:p.binding.filename,bytes:p.binding.bytes,sha256:p.binding.sha256}:pin);
    const commentFinal=await reconstructSerializerCommentTypeNamePredecessorSelection({...options.commentTypeNameOptions,retainedSources:selected});
    return {final,retainedSources:selected,commentFinal,canonicalReconstruction:true,actualFinalSources:final.inputs.length,
        reconstructedPath:i.inventory.path,removedHelperPath:i.lock.helper.outputPath,fullGraphRebuilt:false,fullModuleGraphWasmExecuted:false};
}
