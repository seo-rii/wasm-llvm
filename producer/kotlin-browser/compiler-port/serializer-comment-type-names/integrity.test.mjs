import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRegular,sha256,writeJson} from '../../scripts/source.mjs';
import {commentTypeNameFixture} from './fixture.mjs';
import {prepareSerializerCommentTypeNames,verifySerializerCommentTypeNames,reconstructSerializerCommentTypeNamePredecessorSelection} from './prepare.mjs';
import {transformCommentTypeNames} from './transform.mjs';
import {normalizeRecordedImports} from '../serializer-output-bindings/transform.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
const root=path.resolve(process.argv[2]);assert(root.startsWith(path.join(REPO,'out')+path.sep));await mkdir(root,{mode:0o700});
const options=await commentTypeNameFixture(path.join(root,'profile')),component=await prepareSerializerCommentTypeNames(options);await verifySerializerCommentTypeNames(options);
const lockBytes=await readRegular(path.join(HERE,'sources.lock.json')),lock=JSON.parse(lockBytes),inventory=JSON.parse(await readRegular(path.join(HERE,'inventory.json')));
const after=options.retainedSources.map(pin=>{const row=component.receipt.files.find(x=>x.path===pin.path);return row?{path:pin.path,filename:path.join(component.outputRoot,pin.path),bytes:row.bytes,sha256:row.sha256}:pin;});
const helper=component.receipt.files.at(-1);after.push({path:helper.path,filename:path.join(component.outputRoot,helper.path),bytes:helper.bytes,sha256:helper.sha256});
await reconstructSerializerCommentTypeNamePredecessorSelection({...options,retainedSources:after});
const guards=[];
async function reject(name,action){await assert.rejects(action);guards.push({name,rejected:true});}
async function source(name,text){const filename=path.join(root,name+'.kt'),bytes=Buffer.from(text);await writeFile(filename,bytes,{flag:'wx',mode:0o600});return {path:'probe/'+name+'.kt',filename,bytes:bytes.length,sha256:sha256(bytes)};}
for(const [name,body] of [['new-hierarchy-consumer','package probe\nimport org.jetbrains.kotlin.ir.backend.js.ic.IrICProgramFragments\nfun use(value:IrICProgramFragments)=value\n'],['new-reporter-consumer','package probe\nimport org.jetbrains.kotlin.js.portable.JsCommentTypeNameReporter\nfun use(value:JsCommentTypeNameReporter)=value\n']]){
    const pin=await source(name,body);await reject(name+'-before',()=>prepareSerializerCommentTypeNames({...options,outputRoot:path.join(root,name+'-bad'),retainedSources:[...options.retainedSources,pin]}));
    await reject(name+'-after',()=>reconstructSerializerCommentTypeNamePredecessorSelection({...options,retainedSources:[...after,pin]}));
}
await reject('duplicate-logical-final-source',()=>reconstructSerializerCommentTypeNamePredecessorSelection({...options,retainedSources:[...after,after[0]]}));
const exclusion=lock.sourceSetExclusions.find(x=>x.endsWith('.kt')),excludedFile=path.join(options.sourceRoot,exclusion),excluded=await readRegular(excludedFile);
await reject('actual-excluded-wasm-override-reintroduced',()=>reconstructSerializerCommentTypeNamePredecessorSelection({...options,retainedSources:[...after,{path:exclusion,filename:excludedFile,bytes:excluded.length,sha256:sha256(excluded)}]}));
const other=lock.otherConsumers[0],known=after.find(x=>x.path===other.path),changed=await source('changed-known',(await readRegular(known.filename)).toString()+'\n// changed\n');
await reject('changed-known-caller-body',()=>reconstructSerializerCommentTypeNamePredecessorSelection({...options,retainedSources:after.map(x=>x.path===known.path?{...changed,path:x.path}:x)}));
await reject('missing-required-helper',()=>reconstructSerializerCommentTypeNamePredecessorSelection({...options,retainedSources:after.filter(x=>x.path!==helper.path)}));
const copied=await source('noncanonical-helper',(await readRegular(path.join(component.outputRoot,helper.path))).toString());
await reject('noncanonical-final-helper-filename',()=>reconstructSerializerCommentTypeNamePredecessorSelection({...options,retainedSources:after.map(x=>x.path===helper.path?{...copied,path:x.path}:x)}));
await reject('noncanonical-prior-source-list',()=>verifySerializerCommentTypeNames({...options,preparedSerializerOutput:{...options.preparedSerializerOutput,commonSources:options.preparedSerializerOutput.commonSources.slice(1)}}));
await reject('changed-exact-predecessor-transform-span',async()=>{const row=inventory.files[0];transformCommentTypeNames(await readRegular(path.join(options.preparedSerializerOutput.outputRoot,row.path)),{...row,changes:row.changes.map((x,n)=>n?x:{...x,start:x.start+1})});});
const finalFile=path.join(component.outputRoot,inventory.files[0].path),saved=await readRegular(finalFile);await writeFile(finalFile,Buffer.concat([saved,Buffer.from('\n// altered final\n')]));
await reject('changed-real-final-output',()=>reconstructSerializerCommentTypeNamePredecessorSelection({...options,retainedSources:after}));await writeFile(finalFile,saved);
const r=component.receipt;await writeFile(component.receiptPath,JSON.stringify({...r,fullCompilerBuilt:true},null,2)+'\n');
await reject('false-complete-compiler-receipt',()=>reconstructSerializerCommentTypeNamePredecessorSelection({...options,retainedSources:after}));await writeFile(component.receiptPath,JSON.stringify(r,null,2)+'\n');
// The protocol stays open: a genuine delegated external comment implementation is permitted.
const open=await source('open-external-comment','package probe\nimport org.jetbrains.kotlin.js.backend.ast.JsComment\nclass AdditionalComment(private val original:JsComment):JsComment by original\n');
const positive={...options,outputRoot:path.join(root,'open-profile'),retainedSources:[...options.retainedSources,open]},accepted=await prepareSerializerCommentTypeNames(positive);
const acceptedAfter=positive.retainedSources.map(pin=>{const row=accepted.receipt.files.find(x=>x.path===pin.path);return row?{path:pin.path,filename:path.join(accepted.outputRoot,pin.path),bytes:row.bytes,sha256:row.sha256}:pin;});
const acceptedHelper=accepted.receipt.files.at(-1);acceptedAfter.push({path:acceptedHelper.path,filename:path.join(accepted.outputRoot,acceptedHelper.path),bytes:acceptedHelper.bytes,sha256:acceptedHelper.sha256});
await reconstructSerializerCommentTypeNamePredecessorSelection({...positive,retainedSources:acceptedAfter});
await verifySerializerCommentTypeNames(options);const final=await reconstructSerializerCommentTypeNamePredecessorSelection({...options,retainedSources:after});
// Reproduce the real build's late import mutation without editing any prior
// evidence or source cache. The early recorded filename genuinely changes.
const fir=options.retainedSources.find(pin=>pin.path.endsWith('/FirElementSerializer.kt'));assert(fir);
const originalFir=normalizeRecordedImports(await readRegular(fir.filename),lock.recordedPropertyImports);
const mirror=await source('late-fir-mirror',originalFir.toString()),earlyFir={...mirror,path:fir.path};
const lateOptions={...options,outputRoot:path.join(root,'late-profile'),retainedSources:options.retainedSources.map(pin=>pin.path===fir.path?earlyFir:pin)};
const lateComponent=await prepareSerializerCommentTypeNames(lateOptions);await verifySerializerCommentTypeNames(lateOptions);
const earlyReceiptSha256=sha256(await readRegular(lateComponent.receiptPath));
function imports(bytes){const text=bytes.toString(),p=/^package[^\r\n]+/m.exec(text);assert(p);const end=p.index+p[0].length;
 return Buffer.from(text.slice(0,end)+'\nimport org.jetbrains.kotlin.portable.assertions.compilerAssert as assert\n'+
  '\n'+lock.recordedPropertyImports.map(name=>'import '+name).join('\n')+'\n'+'\nimport kotlin.jvm.*\n'+text.slice(end));}
const changedFir=imports(originalFir);await writeFile(mirror.filename,changedFir);
const lateAfter=[];for(const pin of lateOptions.retainedSources){const row=lateComponent.receipt.files.find(x=>x.path===pin.path);
 if(row){const filename=path.join(lateComponent.outputRoot,pin.path),bytes=imports(await readRegular(filename));await writeFile(filename,bytes);lateAfter.push({path:pin.path,filename,bytes:bytes.length,sha256:sha256(bytes)});}
 else if(pin.path===fir.path)lateAfter.push({path:pin.path,filename:mirror.filename,bytes:changedFir.length,sha256:sha256(changedFir)});
 else lateAfter.push(pin);}
const lateHelper=lateComponent.receipt.files.at(-1),lateHelperFile=path.join(lateComponent.outputRoot,lateHelper.path),helperBytes=imports(await readRegular(lateHelperFile));await writeFile(lateHelperFile,helperBytes);
lateAfter.push({path:lateHelper.path,filename:lateHelperFile,bytes:helperBytes.length,sha256:sha256(helperBytes)});
await reject('early-replay-rejects-late-mutated-snapshot',()=>verifySerializerCommentTypeNames(lateOptions));
const lateFinal=await reconstructSerializerCommentTypeNamePredecessorSelection({...lateOptions,retainedSources:lateAfter});
assert.equal(sha256(await readRegular(lateComponent.receiptPath)),earlyReceiptSha256);
const unrecorded=Buffer.from(helperBytes.toString().replace(/^package[^\r\n]+/m,value=>value+'\nimport org.jetbrains.kotlin.js.backend.ast.JsExport'));await writeFile(lateHelperFile,unrecorded);
await reject('unrecorded-ast-class-import-after',()=>reconstructSerializerCommentTypeNamePredecessorSelection({...lateOptions,retainedSources:lateAfter.map(pin=>pin.path===lateHelper.path?{...pin,bytes:unrecorded.length,sha256:sha256(unrecorded)}:pin)}));await writeFile(lateHelperFile,helperBytes);
await reject('noncanonical-prior-source-list-after',()=>reconstructSerializerCommentTypeNamePredecessorSelection({...options,preparedSerializerOutput:{...options.preparedSerializerOutput,commonSources:options.preparedSerializerOutput.commonSources.slice(1)},retainedSources:after}));
await writeJson(path.join(root,'integrity.json'),{schemaVersion:1,kind:'required-comment-type-name-source-and-selection-guards',sourceLockSha256:sha256(lockBytes),artifactRoot:path.relative(REPO,root),guards,
    openExternalCommentAccepted:true,lateRecordedImportsAccepted:true,earlyMutableSnapshotNotReopened:true,lateFinal,earlyReceiptSha256,
    selectedBefore:options.retainedSources.length,selectedAfter:after.length,final,fullGraphRebuilt:false,fullCompilerBuilt:false,languageReadiness:false});
console.log(JSON.stringify({guardsPassed:guards.length,openExternalCommentAccepted:true}));
