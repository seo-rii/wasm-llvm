import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir,writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink,readRegular,relativePath,sha256,verifyFile,writeJson } from '../../scripts/source.mjs';
import { normalizeTowerImports } from '../tower-group/transform.mjs';
import { verifyFinalLoweringPhaseFactories } from '../lowering-phase-factories/prepare.mjs';
import { transformLoweringPhaseSource } from '../lowering-phase-factories/transform.mjs';
import { TARGET,ENTRY,FACADE,MISSING_PROVIDERS,phaseReferences,phaseDeclarations } from './references.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
const identity=bytes=>({bytes:bytes.length,sha256:sha256(bytes)}),limit=64*1024*1024;
function owner(filename){assert(path.isAbsolute(filename)&&filename===path.resolve(filename)&&filename.startsWith(path.join(REPO,'out')+path.sep),'Canonical native first-phase owner under out/ required');}
function boundary(options,sourceRoot){
    assert(options&&path.resolve(options.sourceRoot)===sourceRoot,'Native first-phase canonical source root differs');
    owner(options.outputRoot);assert.match(options.expectedReceiptSha256??'',/^[a-f0-9]{64}$/,'External lowering phase receipt digest required');
    return {sourceRoot,outputRoot:options.outputRoot,expectedReceiptSha256:options.expectedReceiptSha256};
}
async function input(sourceRoot){
    const lockBytes=await readRegular(path.join(HERE,'sources.lock.json')),lock=JSON.parse(lockBytes),primaryBytes=await readRegular(path.join(HERE,'../closure.lock.json')),primary=JSON.parse(primaryBytes);
    assert.equal(lock.schemaVersion,1);assert.equal(lock.kind,'unreachable-native-first-phase-source-profile');assert.deepEqual(lock.source,primary.source);assert.equal(lock.primaryClosureSha256,sha256(primaryBytes));
    assert.deepEqual(lock.target,primary.files.find(row=>row.path===TARGET));assert.equal(lock.entry,ENTRY);assert.equal(lock.facade,FACADE);assert.deepEqual(lock.missingProviders,MISSING_PROVIDERS);
    assert(MISSING_PROVIDERS.every(name=>!primary.files.some(row=>row.path.endsWith('/'+name+'.kt')||row.path.endsWith('/'+name+'.java'))),'Native provider added to primary closure');
    const phaseLockBytes=await readRegular(path.join(HERE,'../lowering-phase-factories/sources.lock.json')),phaseLock=JSON.parse(phaseLockBytes);assert.equal(lock.loweringPhaseSourceLockSha256,sha256(phaseLockBytes));
    assert.deepEqual(lock.phaseOutput,phaseLock.outputs.find(row=>row.path===TARGET));
    for(const pin of lock.dependencies)verifyFile(await readRegular(path.join(HERE,pin.path)),pin);
    const original=verifyFile(await readRegular(path.join(sourceRoot,TARGET)),lock.target);phaseDeclarations(original.toString(),lock.declarations);
    const common=verifyFile(transformLoweringPhaseSource(TARGET,original),lock.phaseOutput);
    return {lock,lockBytes,primary,original,common};
}
async function audit(sourceRoot,i){
    const pins=i.primary.files.filter(row=>['kotlin','java'].includes(row.language)),references=[];
    for(let n=0;n<pins.length;n+=24){const results=await Promise.allSettled(pins.slice(n,n+24).map(async pin=>({pin,bytes:verifyFile(await readRegular(path.join(sourceRoot,pin.path)),pin)})));
        for(const result of results){if(result.status!=='fulfilled')throw result.reason;const {pin,bytes}=result.value,found=phaseReferences(bytes.toString());if(found.length){references.push({path:pin.path,references:found});assert.equal(pin.path,TARGET,'Primary incoming native first-phase reference: '+pin.path);}}
    }
    return {inspectedFiles:pins.length,inventorySha256:sha256(Buffer.from(JSON.stringify(pins))),references};
}
async function selection(rows,i,before){
    assert(Array.isArray(rows)&&rows.length>0&&rows.length<=20000,'Actual native first-phase selection required');const paths=new Set(),filenames=new Set(),sources=[];let total=0;
    for(const row of rows){assert(row.compile!==false,'Native first-phase selection requires active compiler inputs');relativePath(row.path);assert(/\.(kt|java)$/.test(row.path));assert(!paths.has(row.path),'Duplicate native first-phase logical path');paths.add(row.path);owner(row.filename);assert(!filenames.has(row.filename),'Duplicate native first-phase physical owner');filenames.add(row.filename);assert.deepEqual(JSON.parse(JSON.stringify(row)),row,'Complete row metadata must be JSON-compatible');}
    assert.equal(paths.has(TARGET),before,'Exactly one native first-phase target required before selection and absent afterwards');
    for(let n=0;n<rows.length;n+=24){const results=await Promise.allSettled(rows.slice(n,n+24).map(async row=>({row,bytes:await readRegular(row.filename)})));
        for(const result of results){if(result.status!=='fulfilled')throw result.reason;const {row,bytes}=result.value;assert.deepEqual(identity(bytes),{bytes:row.bytes,sha256:row.sha256},'Native first-phase selected source bytes changed: '+row.path);total+=bytes.length;assert(total<=512*1024*1024);
            if(row.path!==TARGET)assert.deepEqual(phaseReferences(bytes.toString()),[],'Actual incoming native first-phase reference: '+row.path);sources.push(structuredClone(row));}
    }
    return {sources,inspectedBytes:total};
}
async function excluded(row,i,phase,imports){
    assert.equal(row.path,TARGET);assert.equal(row.filename,path.join(phase.outputRoot,TARGET),'Native first-phase canonical owner changed');
    const bytes=await readRegular(row.filename);assert.deepEqual(identity(bytes),{bytes:row.bytes,sha256:row.sha256},'Excluded native first-phase full body changed');
    verifyFile(normalizeTowerImports(bytes,i.common,imports),i.lock.phaseOutput);return bytes;
}
function receiptFor(i,{sourceRoot,phase,imports,originalAudit,selected,excludedRow}){
    return {schemaVersion:1,kind:'unreachable-native-first-phase-preparation',source:i.lock.source,sourceRoot,sourceLockSha256:sha256(i.lockBytes),
        loweringPhaseBoundary:phase,recordedPropertyImports:imports,originalAudit,selection:selected,excluded:excludedRow,excludedIndex:selected.sources.findIndex(row=>row.path===TARGET),
        sourceSetExclusions:[TARGET],commonSources:[],fullOriginalPin:i.lock.target,canonicalPhaseOutput:i.lock.phaseOutput,declarations:i.lock.declarations,entry:ENTRY,facade:FACADE,
        fullCanonicalPhaseOutputsVerified:6,actualSelectedPhaseOutputsBefore:6,missingNativeProviders:MISSING_PROVIDERS,
        nativeBackendImplemented:false,fullIrLoweringExecuted:false,fullCompilerBuilt:false,languageReadiness:false};
}
export async function prepareNativeFirstPhaseSourceProfile({sourceRoot,outputRoot,retainedSources,preparedLoweringPhaseFactories,recordedPropertyImports=[]}){
    sourceRoot=path.resolve(sourceRoot);outputRoot=path.resolve(outputRoot);owner(outputRoot);await assertNoSymlink(sourceRoot);await assertNoSymlink(outputRoot);
    assert(sourceRoot!==outputRoot&&!sourceRoot.startsWith(outputRoot+path.sep)&&!outputRoot.startsWith(sourceRoot+path.sep),'Native first-phase profile roots overlap');
    const i=await input(sourceRoot),phase=boundary(preparedLoweringPhaseFactories,sourceRoot);assert(Array.isArray(recordedPropertyImports));
    const phaseFinal=await verifyFinalLoweringPhaseFactories({...phase,retainedSources,recordedPropertyImports});assert.equal(phaseFinal.checked.length,6);
    const originalAudit=await audit(sourceRoot,i),selected=await selection(retainedSources,i,true),row=selected.sources.find(row=>row.path===TARGET),bytes=await excluded(row,i,phase,recordedPropertyImports);
    await mkdir(path.join(outputRoot,'original'),{recursive:true,mode:0o700});await writeFile(path.join(outputRoot,'original/NativeFirstPhaseLoweringPhases.kt'),i.original,{flag:'wx',mode:0o600});await writeFile(path.join(outputRoot,'excluded-source.kt'),bytes,{flag:'wx',mode:0o600});
    const receipt=receiptFor(i,{sourceRoot,phase,imports:recordedPropertyImports,originalAudit,selected,excludedRow:row}),receiptPath=path.join(outputRoot,'receipt.json');await writeJson(receiptPath,receipt);
    return {outputRoot,receiptPath,receipt,receiptSha256:sha256(await readRegular(receiptPath)),commonSources:[],sourceSetExclusions:[TARGET]};
}
export async function verifyNativeFirstPhaseFinalSources({sourceRoot,outputRoot,retainedSources,expectedReceiptSha256,loweringPhaseBoundary,recordedPropertyImports=[]}){
    sourceRoot=path.resolve(sourceRoot);outputRoot=path.resolve(outputRoot);owner(outputRoot);await assertNoSymlink(outputRoot);assert.match(expectedReceiptSha256??'',/^[a-f0-9]{64}$/,'External native first-phase preparation digest required');
    const receiptBytes=await readRegular(path.join(outputRoot,'receipt.json'),limit);assert.equal(sha256(receiptBytes),expectedReceiptSha256,'Native first-phase preparation receipt digest changed');const receipt=JSON.parse(receiptBytes),i=await input(sourceRoot),phase=boundary(loweringPhaseBoundary,sourceRoot);
    assert.deepEqual(receipt.loweringPhaseBoundary,phase,'Native first-phase lowering boundary changed');assert.deepEqual(receipt.recordedPropertyImports,recordedPropertyImports,'Native first-phase assembly imports changed');
    verifyFile(await readRegular(path.join(outputRoot,'original/NativeFirstPhaseLoweringPhases.kt')),i.lock.target);
    const originalAudit=await audit(sourceRoot,i),prior=await selection(receipt.selection.sources,i,true),excludedRow=prior.sources.find(row=>row.path===TARGET),excludedBytes=await excluded(excludedRow,i,phase,recordedPropertyImports);
    assert.deepEqual(await readRegular(path.join(outputRoot,'excluded-source.kt')),excludedBytes,'Native first-phase excluded snapshot body changed');
    assert.deepEqual(receipt,receiptFor(i,{sourceRoot,phase,imports:recordedPropertyImports,originalAudit,selected:prior,excludedRow}),'Native first-phase preparation receipt content changed');
    const final=await selection(retainedSources,i,false),expected=prior.sources.filter(row=>row.path!==TARGET);
    assert.deepEqual(final.sources,expected,'Native first-phase final changed beyond one exact exclusion');
    const predecessorRetainedSources=final.sources.map(row=>structuredClone(row));predecessorRetainedSources.splice(receipt.excludedIndex,0,structuredClone(excludedRow));assert.deepEqual(predecessorRetainedSources,prior.sources,'Native first-phase complete predecessor metadata/order changed');
    const phaseFinal=await verifyFinalLoweringPhaseFactories({...phase,retainedSources:predecessorRetainedSources,recordedPropertyImports});assert.equal(phaseFinal.checked.length,6,'All six canonical phase outputs must remain verified');
    return {receipt:{schemaVersion:1,kind:'unreachable-native-first-phase-final',source:i.lock.source,sourceLockSha256:sha256(i.lockBytes),preparationReceiptSha256:expectedReceiptSha256,
        actualSelectedSources:final.sources.length,actualSelectionSha256:sha256(Buffer.from(JSON.stringify(final.sources))),restoredExcludedRow:excludedRow,excludedIndex:receipt.excludedIndex,
        sourceSetExclusions:[TARGET],actualSelectedPhaseOutputs:5,restoredExcludedPhaseOutputs:1,fullCanonicalOutputsVerified:6,phaseFinal,exactOneRowReverseVerified:true,completeMetadataAndOrderPreserved:true,
        nativeBackendImplemented:false,fullIrLoweringExecuted:false,fullCompilerBuilt:false,languageReadiness:false},predecessorRetainedSources};
}
