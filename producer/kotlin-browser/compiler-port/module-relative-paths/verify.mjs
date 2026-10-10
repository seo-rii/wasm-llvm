import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRegular,sha256,verifyFile} from '../../scripts/source.mjs';
import {verifySerializerCommentTypeNameEvidence} from '../serializer-comment-type-names/verify.mjs';
import {verifyModuleRequirePaths,reconstructModuleRequirePathPredecessorSelection} from './prepare.mjs';
import {projectRequireMethod} from './project.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
async function content(filename,pin){const b=await readRegular(filename,32*1024*1024);assert.equal(b.length,pin.bytes);assert.equal(sha256(b),pin.sha256);return b;}
export async function verifyModuleRequirePathEvidence() {
    const manifest=JSON.parse(await readRegular(path.join(HERE,'evidence/artifacts.json')));assert.equal(manifest.kind,'sealed-genuine-module-relative-path-artifacts');
    const names=new Set();for(const pin of manifest.files){assert(!names.has(pin.path));names.add(pin.path);verifyFile(await readRegular(path.join(HERE,pin.path),32*1024*1024),pin);}
    assert.deepEqual([...names].sort(),['LICENSE.Kotlin','LICENSE.OpenJDK','ModuleProbe.kt','ModuleRequirePaths.kt','Probe.kt','README.md','fixture.mjs','integrity.test.mjs','inventory.json','prepare.mjs','probe.mjs','project.mjs','references.mjs','seal.mjs','selection-proof.mjs','sources.lock.json','transform.mjs','update-recipe.mjs','verify.mjs','evidence/runtime.json','evidence/runtime-status.json','evidence/guards.json','evidence/guards-status.json','evidence/selection.json','evidence/selection-status.json'].sort());
    await verifySerializerCommentTypeNameEvidence();
    const runtime=JSON.parse(await readRegular(path.join(HERE,'evidence/runtime.json'),32*1024*1024)),guards=JSON.parse(await readRegular(path.join(HERE,'evidence/guards.json')));
    const lockBytes=await readRegular(path.join(HERE,'sources.lock.json')),lock=JSON.parse(lockBytes),i=JSON.parse(await readRegular(path.join(HERE,'inventory.json')));
    assert.equal(runtime.sourceLockSha256,sha256(lockBytes));assert.equal(guards.sourceLockSha256,sha256(lockBytes));
    assert.equal(runtime.sourceFlagsSha256,sha256(await readRegular(path.join(HERE,'../build-flags.json'))));
    for(const name of ['runtime','guards','selection']){const status=JSON.parse(await readRegular(path.join(HERE,'evidence/'+name+'-status.json')));assert.equal(status.state,'exited');assert.equal(status.exitCode,0);assert(Number.isSafeInteger(status.pid));}
    assert.equal(runtime.commands.length,12);for(const command of runtime.commands){assert.equal(command.exitCode,0);assert(command.elapsedMs>=0);}
    assert.equal(guards.checks.length,14);assert(guards.checks.every(x=>x.passed===true));assert.equal(guards.composedSourcesEdited,false);
    const root=path.join(REPO,runtime.artifactRoot);assert(root.startsWith(path.join(REPO,'out')+path.sep));
    for(const pin of runtime.artifacts)await content(path.join(root,pin.path),pin);
    for(const pin of runtime.references)verifyFile(await readRegular(pin.filename,pin.bytes),pin);
    assert.deepEqual(runtime.references.map(({filename,...pin})=>pin),lock.references);
    const fixture=JSON.parse(await readRegular(path.join(root,'fixture.json'),32*1024*1024));
    assert.deepEqual(await verifyModuleRequirePaths(fixture.options),fixture.component.receipt);
    assert.deepEqual(await reconstructModuleRequirePathPredecessorSelection({...fixture.options,retainedSources:fixture.after}),fixture.final);
    const original=(await readRegular(path.join(root,'original-full-module.txt'),32*1024*1024)).toString(),common=(await readRegular(path.join(root,'common-full-module.txt'),32*1024*1024)).toString();
    assert.equal(original,common);assert.equal(original.trimEnd().split('\n').length,runtime.originalCommonFullModuleRecords);assert(runtime.originalCommonFullModuleRecords>50000);
    const a=(await readRegular(path.join(root,'original-method-jvm.txt'),32*1024*1024)).toString(),b=(await readRegular(path.join(root,'common-method-jvm.txt'),32*1024*1024)).toString(),w=(await readRegular(path.join(root,'common-node-wasm.txt'),32*1024*1024)).toString();
    assert.equal(a,b);assert.equal(b,w);assert.equal(w.trimEnd().split('\n').length,runtime.exactMethodOriginalCommonJvmWasmRecords);assert(runtime.exactMethodOriginalCommonJvmWasmRecords>10000);
    for(const common of [false,true]){
        const key=common?'common':'original',source=await readRegular(path.join(root,'profile',common?'':'reference',i.path));
        const projected=projectRequireMethod({inventory:i,source,common,observer:await readRegular(path.join(HERE,'Probe.kt'))});
        assert.deepEqual(projected.bytes,await readRegular(path.join(root,key+'-projection.kt')));
        const {bytes,...details}=projected;assert.deepEqual(runtime.projections.find(x=>x.common===common),{...details,path:key+'-projection.kt',bytes:bytes.length,sha256:sha256(bytes)});
    }
    const fullBuild=runtime.commands.find(x=>x.phase==='genuine-complete-three-source-common-module-serializer-jvm-build');
    for(const name of ['JsIrAstSerializer.kt','CacheUpdater.kt','JsIrProgramFragment.kt','JsCommentTypeNameReporter.kt','ModuleRequirePaths.kt'])assert(fullBuild.command.some(x=>x===path.join(root,'common',name)));
    assert.equal(runtime.genuineThreeSourceJVMCompiled,true);assert.equal(runtime.rawTextCompared,true);assert.equal(runtime.exceptionMessagesCompared,true);
    for(const field of ['fullModuleGraphWasmExecuted','fullCompilerBuilt','languageReadiness'])assert.equal(runtime[field],false);
    const selection=JSON.parse(await readRegular(path.join(HERE,'evidence/selection.json'),32*1024*1024)),selectedRoot=path.join(REPO,selection.artifactRoot);
    assert(selectedRoot.startsWith(path.join(REPO,'out')+path.sep));assert.equal(selection.sourceLockSha256,sha256(lockBytes));
    assert.equal(selection.observerSha256,sha256(await readRegular(path.join(HERE,'selection-proof.mjs'))));
    const selectedFixture=JSON.parse(await content(path.join(selectedRoot,selection.fixture.path),selection.fixture));
    assert.deepEqual(await reconstructModuleRequirePathPredecessorSelection({...selectedFixture.options,retainedSources:selectedFixture.after}),selectedFixture.final);
    assert.deepEqual(selection.final,selectedFixture.final);assert.deepEqual(selection.preparation,selectedFixture.prepared.receipt);
    await content(selection.draftProof.filename,selection.draftProof);await content(selection.whole.filename,selection.whole);
    assert.equal(selection.actualCompletedSources,3521);assert.equal(selection.priorCommentSources,3522);assert.equal(selection.moduleSources,3523);
    assert.equal(selection.strictFullPriorPreparationReplayed,true);assert.equal(selection.canonicalCommentOutputsReconstructedByExactRecordedHeaderRemoval,4);
    assert.equal(selection.actualOriginalGraphFilesUnchanged,true);
    for(const field of ['compilerInvoked','fullGraphRebuilt','fullModuleGraphWasmExecuted','fullCompilerBuilt','languageReadiness'])assert.equal(selection[field],false);
    assert.equal(sha256(await readRegular(selectedFixture.prepared.receiptPath,32*1024*1024)),selection.rawNewReceiptSha256);
    return {fullModuleOriginalCommonJvmRecords:runtime.originalCommonFullModuleRecords,exactMethodOriginalCommonJvmNodeWasmRecords:runtime.exactMethodOriginalCommonJvmWasmRecords,guards:guards.checks.length,localFiles:manifest.files.length+1,fullModuleGraphWasmExecuted:false,fullCompilerBuilt:false,languageReadiness:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await verifyModuleRequirePathEvidence()));
