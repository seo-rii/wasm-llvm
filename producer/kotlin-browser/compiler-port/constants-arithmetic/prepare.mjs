import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {assertNoSymlink,gitBlob,readRegular,sha256,verifyFile,writeJson} from '../../scripts/source.mjs';
import {bindOperations,OPERATIONS} from './extract.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
export async function auditIncomingIntegerCallers(retainedSources) {
    if(!retainedSources)return null;assert(Array.isArray(retainedSources)&&retainedSources.length>0);
    const incoming=[];
    for(const item of retainedSources) {
        if(!item.path.endsWith('.kt')||item.path===OPERATIONS)continue;
        const bytes=await readRegular(item.filename);if(!/\bcheckBinaryOp\b/.test(bytes.toString()))continue;
        incoming.push({path:item.path,bytes:bytes.length,sha256:sha256(bytes)});
    }
    assert.deepEqual(incoming,[],'New incoming arithmetic caller requires a value/identity contract review');return incoming;
}
async function inputs(sourceRoot,retainedSources) {
    const lockBytes=await readRegular(path.join(HERE,'sources.lock.json')),lock=JSON.parse(lockBytes);assert.equal(lock.schemaVersion,1);assert.equal(lock.kind,'pinned-generated-constants-arithmetic');
    const closureBytes=await readRegular(path.join(HERE,'../closure.lock.json')),closure=JSON.parse(closureBytes);assert.equal(sha256(closureBytes),lock.primaryClosureSha256);assert.deepEqual(lock.source,closure.source);
    for(const pin of lock.sources){assert.deepEqual(pin,closure.files.find(p=>p.path===pin.path));verifyFile(await readRegular(path.join(sourceRoot,pin.path)),pin);}
    for(const pin of [...lock.dependencies,...lock.tools,...lock.observers,lock.implementation])verifyFile(await readRegular(path.join(HERE,pin.path)),pin);
    const ast=JSON.parse(await readRegular(path.join(HERE,'../js-ast/sources.lock.json'))),astPin=ast.portable.find(p=>p.path.endsWith('/AstInteger.kt'));
    assert.deepEqual(lock.astIntegerSource,astPin);assert.deepEqual(lock.sharedDependencies[0],{component:'jsAstReceipt',path:astPin.outputPath,bytes:astPin.bytes,sha256:astPin.sha256,gitBlob:astPin.gitBlob});
    assert.deepEqual(lock.sharedDependencies[1],{component:'retainedOriginal',...lock.sources[1]});
    const original=await readRegular(path.join(sourceRoot,OPERATIONS)),bound=bindOperations(original);verifyFile(bound,lock.output);
    return {lock,lockBytes,bound,implementation:await readRegular(path.join(HERE,lock.implementation.path)),incoming:await auditIncomingIntegerCallers(retainedSources)};
}
function receiptFor(i) {return {schemaVersion:1,kind:'generated-constants-arithmetic-preparation',source:i.lock.source,sourceLockSha256:sha256(i.lockBytes),
    preparationToolSha256:i.lock.tools.find(p=>p.path==='prepare.mjs').sha256,sourceFiles:i.lock.sources,sharedDependencies:i.lock.sharedDependencies,
    files:[{path:'compiler-port-constants-arithmetic/'+OPERATIONS,...i.lock.output},{path:'compiler-port-constants-arithmetic/org/jetbrains/kotlin/portable/constants/CompilerInteger.kt',bytes:i.implementation.length,sha256:sha256(i.implementation),gitBlob:gitBlob(i.implementation)}],
    incomingCallers:i.incoming,transformation:'Only genuine BigInteger import rebound; complete generated bodies and existing enum retained.',
    representation:'Immutable AstInteger canonical value and private little-endian base-256 arithmetic digits; no machine-integer truncation.',
    cachedJdkObjectIdentityClaimed:false,originalSourceUnmodified:true,fullGeneratedMapBuilt:false,fullCompilerBuilt:false,languageReadiness:false};}
export async function prepareConstantsArithmetic({sourceRoot,outputRoot,retainedSources}) {
    sourceRoot=path.resolve(sourceRoot);outputRoot=path.resolve(outputRoot);assert(outputRoot.startsWith(path.join(REPO,'out')+path.sep));assert(sourceRoot!==outputRoot&&!sourceRoot.startsWith(outputRoot+path.sep)&&!outputRoot.startsWith(sourceRoot+path.sep));
    await assertNoSymlink(sourceRoot);await assertNoSymlink(outputRoot);const i=await inputs(sourceRoot,retainedSources),receipt=receiptFor(i),commonSources=[];
    for(const [index,pin] of receipt.files.entries()){const filename=path.join(outputRoot,pin.path);await assertNoSymlink(filename);await mkdir(path.dirname(filename),{recursive:true,mode:0o700});await writeFile(filename,index===0?i.bound:i.implementation,{flag:'wx',mode:0o600});commonSources.push(filename);}
    const receiptPath=path.join(outputRoot,'constants-arithmetic-inputs.json');await writeJson(receiptPath,receipt);return {commonSources,replacedOriginalPaths:[OPERATIONS],sharedDependencies:i.lock.sharedDependencies,receipt,receiptPath};
}
export async function verifyConstantsArithmetic({sourceRoot,outputRoot,retainedSources,receiptPath}) {
    const i=await inputs(sourceRoot,retainedSources),receipt=receiptFor(i);for(const pin of receipt.files)verifyFile(await readRegular(path.join(outputRoot,pin.path)),pin);
    assert.deepEqual(JSON.parse(await readRegular(receiptPath)),receipt);return receipt;
}
