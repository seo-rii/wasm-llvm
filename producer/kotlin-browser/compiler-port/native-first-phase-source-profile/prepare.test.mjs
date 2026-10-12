import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { readFile,writeFile } from 'node:fs/promises';
import { sha256,writeJson } from '../../scripts/source.mjs';
import { TARGET,ENTRY,FACADE,phaseReferences } from './references.mjs';
import { verifyNativeFirstPhaseFinalSources } from './prepare.mjs';

test('native entry and facade remain visible through conservative lexical spellings',()=>{
    for(const text of ['import p.'+ENTRY+' as Alias','val x=p.`'+ENTRY+'`','val x="nativeLoweringsOfThe" + "FirstPhase"','val x="NativeFirstPhaseLowering" + "PhasesKt"','val x="nativeLoweringsOfTheFirstPhas\\u0065"','val x="${'+ENTRY+'}"'])assert(phaseReferences(text).length,text);
    assert.deepEqual(phaseReferences('package unrelated\nfun loweringsOfTheFirstPhase() {}'),[]);
});

test('one exact native phase exclusion preserves metadata and rejects precise malformed inputs',{skip:!process.env.NATIVE_FIRST_PHASE_FIXTURE},async()=>{
    const f=JSON.parse(await readFile(process.env.NATIVE_FIRST_PHASE_FIXTURE,'utf8')),options=f.options,rows=f.rows,records=[];
    const baseOptions={...options,retainedSources:rows};
    const call=changes=>verifyNativeFirstPhaseFinalSources(changes?{...baseOptions,...changes}:baseOptions);
    async function rejects(name,run,reason){let error;try{await run();}catch(caught){error=caught;}assert(error,'Negative accepted: '+name);assert(reason.test(error.message),'Wrong failure reason: '+name+': '+error.message);assert(!/ENOENT|EEXIST/.test(error.message));records.push({name,error:{name:error.name,code:error.code??null,operator:error.operator??null,message:error.message},expectedReason:reason.source,reasonMatched:true});}
    const initial=await call();assert.deepEqual(initial.predecessorRetainedSources,f.beforeRows);
    const originalReceipt=await readFile(path.join(options.outputRoot,'receipt.json')),originalSnapshot=await readFile(path.join(options.outputRoot,'excluded-source.kt'));
    await rejects('external receipt digest',()=>call({expectedReceiptSha256:'0'.repeat(64)}),/Native first-phase preparation receipt digest changed/);
    async function receiptMutation(name,edit,reason){const r=JSON.parse(originalReceipt);edit(r);const bytes=Buffer.from(JSON.stringify(r,null,2)+'\n');await writeFile(path.join(options.outputRoot,'receipt.json'),bytes);try{await rejects(name,()=>call({expectedReceiptSha256:sha256(bytes)}),reason);}finally{await writeFile(path.join(options.outputRoot,'receipt.json'),originalReceipt);}}
    await receiptMutation('honest-digest malformed schema',r=>{r.schemaVersion=2;},/Native first-phase preparation receipt content changed/);
    const wrongOwner=path.join(path.dirname(process.env.NATIVE_FIRST_PHASE_FIXTURE),'wrong-native-owner.kt'),body=await readFile(f.excluded.filename);await writeFile(wrongOwner,body);
    await receiptMutation('honest-digest identical body under wrong owner',r=>{r.excluded.filename=wrongOwner;r.selection.sources.find(row=>row.path===TARGET).filename=wrongOwner;},/Native first-phase canonical owner changed/);
    await writeFile(path.join(options.outputRoot,'excluded-source.kt'),Buffer.concat([originalSnapshot,Buffer.from('\n// changed retained full source\n')]));try{await rejects('complete excluded snapshot body',()=>call(),/Native first-phase excluded snapshot body changed/);}finally{await writeFile(path.join(options.outputRoot,'excluded-source.kt'),originalSnapshot);}
    await rejects('inactive row cannot count as actual phase output',()=>call({retainedSources:rows.map((row,index)=>index===0?{...row,compile:false}:row)}),/Native first-phase selection requires active compiler inputs/);
    await rejects('opaque metadata must remain exact',()=>call({retainedSources:rows.map((row,index)=>index===0?{...row,metadata:{changed:true}}:row)}),/Native first-phase final changed beyond one exact exclusion/);
    await rejects('selected order must remain exact',()=>call({retainedSources:[rows[1],rows[0],...rows.slice(2)]}),/Native first-phase final changed beyond one exact exclusion/);
    await rejects('native target reintroduction',()=>call({retainedSources:[...rows,f.excluded]}),/Exactly one native first-phase target required before selection and absent afterwards/);
    for(const [label,text] of [['entry alias','package injected\nimport org.jetbrains.kotlin.ir.inline.konan.'+ENTRY+' as Alias\n'],['facade concatenation','package injected\nval name="NativeFirstPhaseLowering" + "PhasesKt"\n']]){
        const filename=path.join(path.dirname(process.env.NATIVE_FIRST_PHASE_FIXTURE),label.replaceAll(' ','-')+'.kt'),bytes=Buffer.from(text);await writeFile(filename,bytes);
        await rejects('actual incoming '+label,()=>call({retainedSources:[...rows,{path:'injected/Incoming.kt',filename,bytes:bytes.length,sha256:sha256(bytes)}]}),/Actual incoming native first-phase reference: injected\/Incoming.kt/);
    }
    const restored=await call();assert.deepEqual(restored.predecessorRetainedSources,f.beforeRows);assert.equal(restored.receipt.actualSelectedPhaseOutputs,5);assert.equal(restored.receipt.restoredExcludedPhaseOutputs,1);assert.equal(restored.receipt.fullCanonicalOutputsVerified,6);
    await writeJson(path.join(path.dirname(process.env.NATIVE_FIRST_PHASE_FIXTURE),'guards.json'),{schemaVersion:1,kind:'native-first-phase-reason-matched-public-guards',result:'pass',records,guards:records.length,skipped:0,restoredPositivePassed:true,fullMetadataAndOrderRestored:true,fullCompilerBuilt:false});
});
