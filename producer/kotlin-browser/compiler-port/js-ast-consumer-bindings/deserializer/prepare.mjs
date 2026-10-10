import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, gitBlob, readRegular, sha256, verifyFile, writeJson } from '../../../scripts/source.mjs';
import { verifyAstIntegerBounds } from '../integer-bounds/prepare.mjs';
import { verifyJsAstInput } from '../input-codec/prepare.mjs';
import { bindDeserializer, DESERIALIZER } from './transform.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)), REPO=path.resolve(HERE,'../../../../..');
const OUTPUT='compiler-port-js-ast-deserializer/'+DESERIALIZER;
export async function auditCommentConsumers(retainedSources) {
    if(!retainedSources) return null;
    assert(Array.isArray(retainedSources) && retainedSources.length>0);
    const callers=[]; const lock=JSON.parse(await readRegular(path.join(HERE,'sources.lock.json')));
    for(const {path:sourcePath,filename} of retainedSources) {
        if(!sourcePath.endsWith('.kt')) continue;
        const bytes=await readRegular(filename),text=bytes.toString().replace(/^import[^\n]*\n/gm,'');
        if(!/comments(?:Before|After)Node|[gs]etComments(?:Before|After)Node/.test(text)) continue;
        assert(!/(?:comments(?:Before|After)Node|[gs]etComments(?:Before|After)Node\(\))[\s\S]{0,120}(?:===|!==)[\s\S]{0,60}emptyList|emptyList[^\n]*(?:===|!==)[^\n]*(?:commentsBeforeNode|commentsAfterNode)/.test(text), 'Changed global empty singleton consumer');
        const canonical=sourcePath.endsWith('/'+DESERIALIZER)?DESERIALIZER:sourcePath;
        const bodySha256=sha256(Buffer.from(text.split('\n').filter(line=>line.trim()).join('\n')));
        const expected=lock.commentConsumerBodies.find(pin=>pin.path===canonical);assert(expected,'New selected comment consumer');assert.equal(bodySha256,expected.bodySha256,'Changed selected comment consumer body');
        callers.push({path:sourcePath,bytes:bytes.length,sha256:sha256(bytes),bodySha256});
    }
    assert.deepEqual(callers.map(pin=>pin.path.endsWith('/'+DESERIALIZER)?DESERIALIZER:pin.path).sort(),lock.commentConsumerBodies.map(pin=>pin.path).sort(),'Changed selected comment consumer closure');
    return callers.sort((a,b)=>a.path.localeCompare(b.path));
}
async function inputs(options) {
    const {sourceRoot,preparedBounds,preparedInteger,preparedInput,retainedSources}=options;
    const lockBytes=await readRegular(path.join(HERE,'sources.lock.json')),lock=JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion,1);assert.equal(lock.kind,'pinned-selected-js-ast-deserializer-consumer');
    const closureBytes=await readRegular(path.join(HERE,'../../closure.lock.json')),closure=JSON.parse(closureBytes);
    assert.equal(sha256(closureBytes),lock.primaryClosureSha256);assert.deepEqual(lock.source,closure.source);
    for(const pin of lock.sources) {assert.deepEqual(pin,closure.files.find(item=>item.path===pin.path));verifyFile(await readRegular(path.join(sourceRoot,pin.path)),pin);}
    for(const pin of [...lock.dependencies,...lock.tools,...lock.observers,lock.comments,lock.arrayFactory])verifyFile(await readRegular(path.join(HERE,pin.path)),pin);
    const stdlib=JSON.parse(await readRegular(path.join(HERE,'../../../stdlib-probe/recipe.json')));assert.deepEqual(lock.arrayFactorySource,stdlib.files.find(p=>p.path==='libraries/stdlib/common/src/generated/_Arrays.kt'));assert.equal(lock.arrayFactory.sha256,lock.arrayFactorySource.sha256);assert.equal(lock.arrayFactory.gitBlob,lock.arrayFactorySource.gitBlob);
    assert(preparedBounds.commonSources?.length===1);const boundFile=preparedBounds.commonSources[0];
    const boundRoot=boundFile.slice(0,-preparedBounds.receipt.file.path.length-1);
    const predecessor=await verifyAstIntegerBounds({sourceRoot,outputRoot:boundRoot,preparedInteger,retainedSources,receiptPath:preparedBounds.receiptPath});assert.deepEqual(predecessor,preparedBounds.receipt);
    const boundBytes=await readRegular(boundFile);verifyFile(boundBytes,lock.predecessorOutput);
    const inputRoot=preparedInput.commonSources[0].slice(0,-preparedInput.receipt.file.path.length-1);
    const inputReceipt=await verifyJsAstInput({sourceRoot,outputRoot:inputRoot,receiptPath:preparedInput.receiptPath});assert.deepEqual(inputReceipt,preparedInput.receipt);
    const inputDependency={component:'jsAstInputReceipt',path:inputReceipt.file.path,bytes:inputReceipt.file.bytes,sha256:inputReceipt.file.sha256};assert.deepEqual(inputDependency,lock.inputDependency);
    const transformed=bindDeserializer(boundBytes);verifyFile(transformed,lock.output);
    const receiptBytes=await readRegular(preparedBounds.receiptPath);
    const binding={component:'jsAstIntegerBoundsReceipt',logicalPath:'compiler-port-js-ast-integer-bounds/'+DESERIALIZER,componentRelativePath:predecessor.file.path,
        filename:boundFile,bytes:boundBytes.length,sha256:sha256(boundBytes),receiptSha256:sha256(receiptBytes),sourceLockSha256:predecessor.sourceLockSha256,preparationToolSha256:predecessor.preparationToolSha256};
    return {lock,lockBytes,transformed,binding,inputDependency,comments:await readRegular(path.join(HERE,lock.comments.path)),callers:await auditCommentConsumers(retainedSources)};
}
function receiptFor(i) {return {schemaVersion:1,kind:'selected-js-ast-deserializer-consumer-preparation',source:i.lock.source,sourceLockSha256:sha256(i.lockBytes),
    preparationToolSha256:i.lock.tools.find(p=>p.path==='prepare.mjs').sha256,predecessorBindings:[i.binding],inputDependency:i.inputDependency,sourceFiles:i.lock.sources,
    files:[{path:OUTPUT,...i.lock.output},{path:'compiler-port-js-ast-deserializer/org/jetbrains/kotlin/js/portable/JsAstComments.kt',bytes:i.comments.length,sha256:sha256(i.comments),gitBlob:gitBlob(i.comments)}],
    selectedCommentConsumers:i.callers,commentFactory:'Zero canonical immutable; singleton immutable; multi shallow array copy with fixed size and writable elements. Original node stores the published list; metadata retains its identity.',
    globalEmptyListIdentityPreserved:false,originalLocationFailureStackRetained:true,normalSerializedBytesChanged:false,integerAndBoundsBindingsRetained:true,
    javaFacadeIntroduced:false,fullDeserializerBuilt:false,fullCompilerBuilt:false,languageReadiness:false};}
export async function prepareJsAstDeserializer(options) {
    const sourceRoot=path.resolve(options.sourceRoot),outputRoot=path.resolve(options.outputRoot);assert(outputRoot.startsWith(path.join(REPO,'out')+path.sep));
    for(const root of [sourceRoot,path.dirname(options.preparedBounds.receiptPath),path.dirname(options.preparedInput.receiptPath)]) assert(root!==outputRoot && !root.startsWith(outputRoot+path.sep) && !outputRoot.startsWith(root+path.sep));
    await assertNoSymlink(outputRoot);const i=await inputs({...options,sourceRoot}),receipt=receiptFor(i),commonSources=[];
    for(const [index,pin] of receipt.files.entries()) {const filename=path.join(outputRoot,pin.path);await assertNoSymlink(filename);await mkdir(path.dirname(filename),{recursive:true,mode:0o700});await writeFile(filename,index===0?i.transformed:i.comments,{flag:'wx',mode:0o600});commonSources.push(filename);}
    const receiptPath=path.join(outputRoot,'deserializer-inputs.json');await writeJson(receiptPath,receipt);
    return {commonSources,replacedOriginalPaths:['compiler-port-js-ast-integer-bounds/'+DESERIALIZER],predecessorBindings:[i.binding],inputDependency:i.inputDependency,receipt,receiptPath};
}
export async function verifyJsAstDeserializer(options) {
    const i=await inputs(options),receipt=receiptFor(i);for(const pin of receipt.files)verifyFile(await readRegular(path.join(options.outputRoot,pin.path)),pin);
    assert.deepEqual(JSON.parse(await readRegular(options.receiptPath)),receipt);return receipt;
}
