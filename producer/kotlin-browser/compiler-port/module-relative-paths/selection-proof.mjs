import assert from 'node:assert/strict';
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRegular,sha256,verifyFile,writeJson} from '../../scripts/source.mjs';
import {normalizeRecordedImports} from '../serializer-output-bindings/transform.mjs';
import {prepareModuleRequirePaths,verifyModuleRequirePaths,reconstructModuleRequirePathPredecessorSelection} from './prepare.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
const draftRoot=path.resolve(process.argv[2]),root=path.resolve(process.argv[3]);assert(root.startsWith(path.join(REPO,'out')+path.sep));await mkdir(root,{mode:0o700});
const draft=JSON.parse(await readRegular(path.join(draftRoot,'receipt.json'),32*1024*1024));assert.equal(draft.whole.actualCompiledSources,3521);assert.equal(draft.early.commentSelected,3522);assert.equal(draft.compilerInvoked,false);
const whole=await readRegular(draft.whole.filename,32*1024*1024);assert.equal(whole.length,draft.whole.bytes);assert.equal(sha256(whole),draft.whole.sha256);
const archived=draft.archivalOptions,oldRoot=path.join(draftRoot,'components/serializerOutputReceipt'),commentOldRoot=path.join(draftRoot,'components/serializerCommentTypeNamesReceipt');
const oldReceiptBytes=await readRegular(path.join(oldRoot,'serializer-output-inputs.json'),32*1024*1024),oldReceipt=JSON.parse(oldReceiptBytes);
const initial=new Map(archived.retainedSources.map(pin=>[pin.path,pin]));for(const graft of draft.canonicalEarlyGrafts)initial.set(graft.path,{path:graft.path,...graft.after});
const oldOptions={...archived,outputRoot:oldRoot,retainedSources:[...initial.values()]};
const preparedSerializerOutput={outputRoot:oldRoot,receipt:oldReceipt,receiptPath:path.join(oldRoot,'serializer-output-inputs.json'),commonSources:oldReceipt.files.map(pin=>path.join(oldRoot,pin.path)),predecessorBindings:oldReceipt.predecessorBindings,sharedDependencies:oldReceipt.dependencies,replacedOriginalPaths:oldReceipt.files.map(pin=>pin.path),finalSelectionGuardRequired:true};
const commentReceiptBytes=await readRegular(path.join(commentOldRoot,'serializer-comment-type-names-inputs.json'),32*1024*1024),commentReceipt=JSON.parse(commentReceiptBytes);
assert.deepEqual(commentReceipt,draft.preparation);
const lock=JSON.parse(await readRegular(path.join(HERE,'../serializer-comment-type-names/sources.lock.json'))),canonicalRoot=path.join(root,'canonical-comment');await mkdir(canonicalRoot);
for(const pin of commentReceipt.files) {
    const bytes=verifyFile(normalizeRecordedImports(await readRegular(path.join(commentOldRoot,pin.path)),lock.recordedPropertyImports),pin),filename=path.join(canonicalRoot,pin.path);
    await mkdir(path.dirname(filename),{recursive:true,mode:0o700});await writeFile(filename,bytes,{flag:'wx',mode:0o600});
    if(pin.path!==lock.helper.outputPath){const f=path.join(canonicalRoot,'reference',pin.path);await mkdir(path.dirname(f),{recursive:true,mode:0o700});await copyFile(path.join(commentOldRoot,'reference',pin.path),f);}
}
await writeFile(path.join(canonicalRoot,'serializer-comment-type-names-inputs.json'),commentReceiptBytes,{flag:'wx',mode:0o600});
const commentOptions={sourceRoot:archived.sourceRoot,outputRoot:canonicalRoot,preparedSerializerOutput,serializerOutputOptions:oldOptions,retainedSources:commentReceipt.hierarchy.inputs};
const preparedCommentTypeNames={outputRoot:canonicalRoot,receipt:commentReceipt,receiptPath:path.join(canonicalRoot,'serializer-comment-type-names-inputs.json'),commonSources:commentReceipt.files.map(pin=>path.join(canonicalRoot,pin.path)),predecessorBindings:commentReceipt.predecessorBindings,replacedOriginalPaths:commentReceipt.files.slice(0,3).map(pin=>pin.path),finalSelectionGuardRequired:true};
const retainedSources=draft.final.final.inputs.map(pin=>{const canonical=commentReceipt.files.find(row=>row.path===pin.path);return canonical?{path:pin.path,filename:path.join(canonicalRoot,pin.path),bytes:canonical.bytes,sha256:canonical.sha256}:pin;});assert.equal(retainedSources.length,3522);
const options={sourceRoot:archived.sourceRoot,outputRoot:path.join(root,'module-profile'),preparedCommentTypeNames,commentTypeNameOptions:commentOptions,retainedSources};
const prepared=await prepareModuleRequirePaths(options);await verifyModuleRequirePaths(options);
const after=retainedSources.map(pin=>{const output=prepared.receipt.files.find(row=>row.path===pin.path);return output?{path:pin.path,filename:path.join(options.outputRoot,pin.path),bytes:output.bytes,sha256:output.sha256}:pin;});
const helper=prepared.receipt.files.at(-1);after.push({path:helper.path,filename:path.join(options.outputRoot,helper.path),bytes:helper.bytes,sha256:helper.sha256});assert.equal(after.length,3523);
const receiptSha=sha256(await readRegular(prepared.receiptPath,32*1024*1024)),sourceLock=JSON.parse(await readRegular(path.join(HERE,'sources.lock.json')));
for(const row of prepared.receipt.files){const pin=after.find(x=>x.path===row.path),text=(await readRegular(pin.filename)).toString(),p=/^package[^\r\n]+/m.exec(text),end=p.index+p[0].length;
    const bytes=Buffer.from(text.slice(0,end)+'\nimport org.jetbrains.kotlin.portable.assertions.compilerAssert as assert\n\n'+sourceLock.recordedPropertyImports.map(x=>'import '+x).join('\n')+'\n\nimport kotlin.jvm.*\n'+text.slice(end));await writeFile(pin.filename,bytes);pin.bytes=bytes.length;pin.sha256=sha256(bytes);
}
assert.equal(sha256(await readRegular(prepared.receiptPath,32*1024*1024)),receiptSha);
const final=await reconstructModuleRequirePathPredecessorSelection({...options,retainedSources:after});assert.equal(final.actualFinalSources,3523);assert.equal(final.commentFinal.actualFinalSources,3522);assert.equal(final.commentFinal.predecessorSelection.inputs.length,3521);
for(const pin of draft.final.final.inputs){const bytes=await readRegular(pin.filename);assert.equal(bytes.length,pin.bytes);assert.equal(sha256(bytes),pin.sha256);}
const fixtureBytes=Buffer.from(JSON.stringify({options,prepared,after,final},null,2)+'\n');await writeFile(path.join(root,'fixture.json'),fixtureBytes,{flag:'wx',mode:0o600});
await writeJson(path.join(root,'selection.json'),{schemaVersion:1,kind:'actual-completed-graph-module-layer-selection-replay',sourceLockSha256:sha256(await readRegular(path.join(HERE,'sources.lock.json'))),artifactRoot:path.relative(REPO,root),observerSha256:sha256(await readRegular(fileURLToPath(import.meta.url))),fixture:{path:'fixture.json',bytes:fixtureBytes.length,sha256:sha256(fixtureBytes)},draftProof:{filename:path.join(draftRoot,'receipt.json'),bytes:(await readRegular(path.join(draftRoot,'receipt.json'),32*1024*1024)).length,sha256:sha256(await readRegular(path.join(draftRoot,'receipt.json'),32*1024*1024))},whole:draft.whole,
    canonicalCommentOutputsReconstructedByExactRecordedHeaderRemoval:4,strictFullPriorPreparationReplayed:true,actualCompletedSources:3521,priorCommentSources:3522,moduleSources:3523,actualOriginalGraphFilesUnchanged:true,rawNewReceiptSha256:receiptSha,
    preparation:prepared.receipt,final,compilerInvoked:false,fullGraphRebuilt:false,fullModuleGraphWasmExecuted:false,fullCompilerBuilt:false,languageReadiness:false});
console.log(JSON.stringify({actualCompletedSources:3521,priorCommentSources:3522,moduleSources:3523,compilerInvoked:false}));
