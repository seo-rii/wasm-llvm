import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
import { verifySourceMapRuntimeFinalSources } from '../source-map-runtime/final.mjs';
import { verifySourceMapPathFinalSources } from './final.mjs';
import { PATH_SOURCES } from './transform.mjs';
const REPO=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');
// An exited real assembly, not a successful full compiler. Its selected sources are
// measured again below; this probe does not modify any prior component artifacts.
const baseline=path.join(REPO,'out/kotlin-compiler-port/builds/deserialization-contracts-whole-1791649434480971899');
export async function verifyRuntimePathComposition({pathComponent,kernelComponent,outputRoot}) {
    const baselineReceiptPath=path.join(baseline,'compiler-build-receipt.json');
    const baselineBytes=await readRegular(baselineReceiptPath,32*1024*1024), prior=JSON.parse(baselineBytes);
    const selected=prior.sourceMapRuntimeFinalReceipt.inspected;
    assert.equal(selected.length,3521); assert.equal(prior.status,'failed');
    const oldRoot=path.join(baseline,'components/sourceMapRuntimeReceipt');
    const runtimeReceiptBytes=await readRegular(path.join(oldRoot,'source-map-runtime-inputs.json'));
    const runtimeReceipt=JSON.parse(runtimeReceiptBytes); assert.deepEqual(runtimeReceipt,prior.sourceMapRuntimeReceipt);
    await mkdir(outputRoot,{recursive:true,mode:0o700});
    for(const name of ['source-map-runtime-inputs.json','caller-snapshot.json',...runtimeReceipt.files.map(pin=>pin.path)]){
        const filename=path.join(outputRoot,name);await mkdir(path.dirname(filename),{recursive:true,mode:0o700});
        await writeFile(filename,await readRegular(path.join(oldRoot,name)),{flag:'wx',mode:0o600});
    }
    const retainedSources=selected.filter(item=>![...PATH_SOURCES,...kernelComponent.replacedOriginalPaths].includes(item.path)&&!runtimeReceipt.files.some(pin=>pin.path===item.path));
    assert.equal(selected.length-retainedSources.length,12);
    for(const [component,root]of [[pathComponent,path.dirname(pathComponent.receiptPath)],[kernelComponent,path.dirname(kernelComponent.receiptPath)],[{receipt:runtimeReceipt},outputRoot]])
        for(const pin of component.receipt.files)retainedSources.push({path:pin.path,filename:path.join(root,pin.path),compile:true});
    const pathFinal=await verifySourceMapPathFinalSources({sourceRoot:path.join(REPO,'out/kotlin-compiler-port/sources'),
        outputRoot:path.dirname(pathComponent.receiptPath),receiptPath:pathComponent.receiptPath,kernelComponent,retainedSources,
        allowedAddedImports:prior.sourceMapRuntimeFinalReceipt.allowedAddedImports,
        allowedRequestHostSources:retainedSources.filter(pin=>['compiler-port-entry/BrowserCompiler.kt','compiler-port-entry/BrowserCompilerPipeline.kt'].includes(pin.path))});
    const sourceContentRoot=path.join(baseline,'components/jsSourceContentReceipt');
    const sourceContentReceipt=JSON.parse(await readRegular(path.join(sourceContentRoot,'source-content-inputs.json')));
    const runtimeFinal=await verifySourceMapRuntimeFinalSources({profileRoot:outputRoot,sourceRoot:path.join(baseline,'sources'),
        runtimeSourceRoot:path.join(REPO,'out/kotlin-source-map-runtime/reference'),
        sourceContentComponent:{receipt:sourceContentReceipt,receiptPath:path.join(sourceContentRoot,'source-content-inputs.json'),
            commonSources:sourceContentReceipt.files.map(pin=>path.join(sourceContentRoot,pin.path))},retainedSources,
        allowedAddedImports:prior.sourceMapRuntimeFinalReceipt.allowedAddedImports,
        allowedRequestHostSources:retainedSources.filter(pin=>['compiler-port-entry/BrowserCompiler.kt','compiler-port-entry/BrowserCompilerPipeline.kt'].includes(pin.path))});
    assert.deepEqual(runtimeFinal.receipt.exactKnownGetJsCodeCallers,prior.sourceMapRuntimeFinalReceipt.exactKnownGetJsCodeCallers);
    return {baseline:{filename:baselineReceiptPath,bytes:baselineBytes.length,sha256:sha256(baselineBytes),compilerSucceeded:false},
        actualSelectedFiles:retainedSources.length,sourceMapPathFinal:pathFinal.receipt,sourceMapRuntimeFinal:runtimeFinal.receipt,
        runtimeFinalCodeUnmodified:true,originalCallerViewSynthesized:false,entryPathHostInstalled:false,fullCompilerBuilt:false};
}
