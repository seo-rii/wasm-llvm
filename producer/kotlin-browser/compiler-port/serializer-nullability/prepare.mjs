import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertNoSymlink,readRegular,sha256,verifyFile,writeJson} from '../../scripts/source.mjs';
import {verifyJsAstPreparation} from '../js-ast/prepare.mjs';
import {bindSerializerNullableGetters} from './transform.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
async function inputs({sourceRoot,preparedJsAst}) {
    const lockBytes=await readRegular(path.join(HERE,'sources.lock.json')),lock=JSON.parse(lockBytes);
    assert.equal(lock.kind,'serializer-selected-nullable-getter-bindings');
    const closureBytes=await readRegular(path.join(HERE,'../closure.lock.json')),closure=JSON.parse(closureBytes);
    assert.equal(sha256(closureBytes),lock.primaryClosureSha256);assert.deepEqual(lock.source,closure.source);
    assert.deepEqual(lock.consumer,closure.files.find(x=>x.path===lock.consumer.path));
    for(const pin of lock.tools)verifyFile(await readRegular(path.join(HERE,pin.path)),pin);
    assert.equal(sha256(await readRegular(path.join(HERE,'../js-ast/sources.lock.json'))),lock.jsAstSourceLockSha256);
    assert(preparedJsAst?.receiptPath && preparedJsAst?.outputRoot);
    assert.equal(path.resolve(preparedJsAst.receiptPath),path.join(path.resolve(preparedJsAst.outputRoot),'js-ast-inputs.json'));
    const verified=await verifyJsAstPreparation(preparedJsAst.outputRoot,{sourceRoot});
    assert.deepEqual(verified.receipt,preparedJsAst.receipt);
    assert.deepEqual(verified.commonSources,preparedJsAst.commonSources);
    const named=verified.receipt.files.find(x=>x.path===lock.namedCommonPath);assert(named);
    const namedBytes=verifyFile(await readRegular(path.join(preparedJsAst.outputRoot,named.path)),named);
    assert(namedBytes.toString().includes('override fun getName(): JsName = name'));
    const inventoryBytes=verifyFile(await readRegular(path.join(HERE,'inventory.json')),lock.inventory);
    const inventory=JSON.parse(inventoryBytes);assert.deepEqual(inventory.consumer,lock.consumer);
    const original=verifyFile(await readRegular(path.join(sourceRoot,lock.consumer.path)),lock.consumer);
    const transformed=bindSerializerNullableGetters(original,inventory);
    assert.equal(transformed.bytes.length,lock.prepared.bytes);assert.equal(sha256(transformed.bytes),lock.prepared.sha256);
    return {lock,lockBytes,inventory,original,transformed,astReceiptSha256:sha256(await readRegular(preparedJsAst.receiptPath)),named};
}
function receiptFor(input) {
    const {lock,lockBytes,transformed,astReceiptSha256,named}=input;
    return {schemaVersion:1,kind:'serializer-selected-nullability-preparation',source:lock.source,
        sourceLockSha256:sha256(lockBytes),consumer:lock.consumer,prepared:lock.prepared,
        bindings:transformed.bindings,metadataNullEntry:input.inventory.metadataClassLiteral,
        jsAstBinding:{sourceLockSha256:lock.jsAstSourceLockSha256,receiptSha256:astReceiptSha256,namedSource:named},
        expressionChecks:25,explicitNamedGetters:2,metadataNullEntries:1,
        metadataNullMessage:'Cannot invoke "Object.getClass()" because "value" is null',
        referencePath:'reference/'+lock.consumer.path,
        transportChanged:false,qualifiedNameHostClosed:false,bootstrapNotNullInstrumentationParity:false,
        stackTraceLineParity:false,fullSerializerWasmExecuted:false,javaDescriptorImplementationFamilyClosed:false,
        fullCompilerBuilt:false,languageReadiness:false};
}
export async function prepareSerializerNullability(options) {
    const outputRoot=path.resolve(options.outputRoot);assert(outputRoot.startsWith(path.join(REPO,'out')+path.sep));
    await assertNoSymlink(outputRoot);const input=await inputs(options),receipt=receiptFor(input);
    const filename=path.join(outputRoot,input.lock.consumer.path),reference=path.join(outputRoot,receipt.referencePath);
    for(const [target,bytes] of [[filename,input.transformed.bytes],[reference,input.original]]){
        await assertNoSymlink(target);await mkdir(path.dirname(target),{recursive:true,mode:0o700});
        await writeFile(target,bytes,{flag:'wx',mode:0o600});
    }
    const receiptPath=path.join(outputRoot,'serializer-nullability-inputs.json');await writeJson(receiptPath,receipt);
    return {outputRoot,commonSources:[filename],replacedOriginalPaths:[input.lock.consumer.path],predecessorBindings:[],receipt,receiptPath};
}
export async function verifySerializerNullability(options) {
    const input=await inputs(options),receipt=receiptFor(input);
    verifyFile(await readRegular(path.join(options.outputRoot,input.lock.consumer.path)),input.lock.prepared);
    verifyFile(await readRegular(path.join(options.outputRoot,receipt.referencePath)),input.lock.consumer);
    assert.deepEqual(JSON.parse(await readRegular(path.join(options.outputRoot,'serializer-nullability-inputs.json'))),receipt);
    return receipt;
}
