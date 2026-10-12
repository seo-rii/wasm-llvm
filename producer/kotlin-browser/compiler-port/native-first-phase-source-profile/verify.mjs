import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular,sha256,verifyFile } from '../../scripts/source.mjs';
import { TARGET } from './references.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const identity=bytes=>({bytes:bytes.length,sha256:sha256(bytes)});
async function content(pin){const bytes=await readRegular(pin.filename,64*1024*1024);assert.deepEqual(identity(bytes),{bytes:pin.bytes,sha256:pin.sha256});return bytes;}
export async function verifyNativeFirstPhaseEvidence(){
    const e=JSON.parse(await readRegular(path.join(HERE,'evidence/selection.json'))),lockBytes=await readRegular(path.join(HERE,'sources.lock.json')),lock=JSON.parse(lockBytes);
    assert.equal(e.result,'pass');assert.equal(e.sourceLockSha256,sha256(lockBytes));assert.deepEqual(e.source,lock.source);
    for(const pin of lock.dependencies)verifyFile(await readRegular(path.resolve(HERE,pin.path)),pin);
    const status=JSON.parse(await content(e.execution.status));assert.equal(status.state,'exited');assert.equal(status.exitCode,0);assert.equal(status.pid,e.execution.pid);assert.deepEqual(status.argv,e.execution.argv);
    for(const pin of [e.execution.manifest,e.execution.log,e.execution.runner,e.execution.executedScript,e.execution.scriptSnapshot,e.execution.configuration,e.execution.configurationSnapshot,...e.shippingInputs])await content(pin);
    assert.equal(e.execution.executedScript.sha256,e.execution.preLaunchScriptSha256);assert.equal(e.execution.configuration.sha256,e.execution.preLaunchConfigurationSha256);
    const p=JSON.parse(await content(e.proof));assert.equal(p.result,'pass');assert.equal(p.actualBefore,3550);assert.equal(p.actualAfter,3549);
    assert.deepEqual(p.actualSources,p.historicalSources.filter(row=>row.path!==TARGET));assert.equal(p.profileFinal.actualSelectedPhaseOutputs,5);assert.equal(p.profileFinal.restoredExcludedPhaseOutputs,1);assert.equal(p.profileFinal.fullCanonicalOutputsVerified,6);assert.equal(p.profileFinal.phaseFinal.checked.length,6);
    const restored=[...p.actualSources];restored.splice(p.profileFinal.excludedIndex,0,p.profileFinal.restoredExcludedRow);assert.deepEqual(restored,p.historicalSources);
    assert.equal(p.nativeFinal.inspectedFiles,3549);assert.equal(p.nativeFinal.loweringPhaseFactoryBinding.checked.length,6);assert.equal(p.nativeFinal.loweringPhaseFactoryBinding.mappings.length,2);assert.equal(p.nativeFinal.loweringPhaseFactoryBinding.actualSelectedPhaseOutputs,5);assert.equal(p.nativeFinal.loweringPhaseFactoryBinding.restoredExcludedPhaseOutputs,1);assert.equal(p.nativeFinal.loweringPhaseFactoryBinding.fullCanonicalOutputsVerified,6);
    assert.equal(p.nativeFinal.retainedBoundaryBindings.length,21);assert.equal(p.nativeFinal.existingSplitBindings.length,4);assert.deepEqual(p.nativeFinal.incoming,[]);
    assert.equal(p.moduleFinal.actualFinalSources,3549);assert.deepEqual(p.moduleFinal.final.inputs,p.actualSources.map(({path,filename,bytes,sha256})=>({path,filename,bytes,sha256})).sort((a,b)=>a.path.localeCompare(b.path)));
    assert.equal(p.guards.guards,10);assert.equal(p.guards.records.length,10);assert.equal(p.guards.skipped,0);assert(p.guards.restoredPositivePassed);for(const row of p.guards.records){assert(new RegExp(row.expectedReason).test(row.error.message));assert(!/ENOENT|EEXIST/.test(row.error.message));assert(row.reasonMatched);}
    for(const row of p.historicalSources)await content(row);await content(p.profilePreparation);await content(p.testExecution.output);
    const archive=JSON.parse(await content(e.archivedNativePhase.manifest));assert.equal(archive.sourceLockSha256,e.archivedNativePhase.sourceLockSha256);assert.equal(archive.files.length,43);for(const row of archive.files)await content({...row,filename:row.archivedFilename});
    for(const row of e.archivedNativePhase.evidencePins)await content(row);
    const failed=JSON.parse(await content(e.failedAttempt.status));assert.equal(failed.exitCode,1);assert.equal(failed.pid,e.failedAttempt.pid);await content(e.failedAttempt.log);await content(e.failedAttempt.testSnapshot);
    for(const key of ['newCompilerOrRuntimeExecuted','fullCompilerBuilt','languageReadiness'])assert.equal(p[key],false);
    return {result:'pass',actualSources:3549,originalSources:3550,actualPhaseOutputs:5,restoredPhaseOutputs:1,canonicalPhaseOutputs:6,jsWasmBindings:2,guards:10,oldPhaseProofArchived:true,failedAttemptExcluded:true,fullCompilerBuilt:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await verifyNativeFirstPhaseEvidence()));
