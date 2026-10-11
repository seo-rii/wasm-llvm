import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { normalizeImports } from '../klib-signature-index/transform.mjs';
import { selectedDeclarations } from '../backend-profile/references.mjs';
import { lexicalReferenceView } from '../native-js-output-profile/references.mjs';
import { BASE, EXCLUDED, FAMILY, REPLACED, HOST, ENTRY, PIPELINE, PARSER, SYMBOLS, referenceNames, syntaxChanges, applyChanges, expandObjectImports } from './transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const project = ({path,filename,bytes,sha256}) => ({path,filename,bytes,sha256});
function outputPath(filename) { assert(path.isAbsolute(filename) && filename.startsWith(path.join(REPO,'out')+path.sep), 'Syntax profile owner must stay under out/'); }
function checked(bytes, pin, label = pin.path) { assert.deepEqual(identity(bytes), {bytes:pin.bytes,sha256:pin.sha256}, 'Syntax profile bytes changed: '+label); return bytes; }
async function inputs() {
    const lockBytes=await readRegular(path.join(HERE,'sources.lock.json')), lock=JSON.parse(lockBytes);
    const primaryBytes=await readRegular(path.join(HERE,'../closure.lock.json')), primary=JSON.parse(primaryBytes);
    assert.equal(lock.schemaVersion,1); assert.equal(lock.kind,'official-fir-syntax-lighttree-source-profile');
    assert.deepEqual(lock.source,primary.source); assert.equal(lock.primaryClosureSha256,sha256(primaryBytes));
    assert.deepEqual(lock.family,FAMILY); assert.deepEqual(lock.symbols,SYMBOLS); assert.deepEqual(lock.replacedOriginalPaths,REPLACED); assert.deepEqual(lock.sourceSetExclusions,[EXCLUDED]);
    assert.deepEqual(lock.sources.map(r=>r.path),[...FAMILY,...REPLACED.filter(p=>!FAMILY.includes(p))]);
    for(const pin of lock.sources) assert.deepEqual(pin,primary.files.find(r=>r.path===pin.path));
    for(const pin of lock.dependencies) checked(await readRegular(path.join(HERE,pin.path)),pin);
    assert.deepEqual(lock.recordedPropertyImports,JSON.parse(await readRegular(path.join(HERE,'../serializer-comment-type-names/sources.lock.json'))).recordedPropertyImports);
    return {lockBytes,lock,primary};
}
function canonical(bytes,i) { return normalizeImports(bytes,i.lock.recordedPropertyImports); }
async function originals(root,i) {
    const result=new Map();
    for(const pin of i.lock.sources) {
        const bytes=verifyFile(await readRegular(path.join(root,pin.path)),pin); result.set(pin.path,bytes);
        assert.deepEqual(selectedDeclarations(bytes.toString()),i.lock.declarationInventory[pin.path]);
        if(REPLACED.includes(pin.path)) {
            assert.deepEqual(syntaxChanges(pin.path,bytes),i.lock.changes[pin.path]);
            const transformed=applyChanges(bytes,i.lock.changes[pin.path]); checked(transformed,i.lock.outputs.find(r=>r.path===pin.path));
            assert.deepEqual(applyChanges(transformed,i.lock.changes[pin.path],true),bytes);
        }
    }
    return result;
}
async function primaryAudit(sourceRoot,i) {
    const pins=i.primary.files.filter(r=>['kotlin','java'].includes(r.language)), references=[];
    for(let n=0;n<pins.length;n+=24) {
        const batch=await Promise.allSettled(pins.slice(n,n+24).map(async pin=>({pin,bytes:verifyFile(await readRegular(path.join(sourceRoot,pin.path)),pin)})));
        for(const result of batch) { if(result.status!=='fulfilled') throw result.reason;
            const {pin,bytes}=result.value, names=referenceNames(bytes.toString()); if(names.length) references.push({path:pin.path,names}); }
    }
    return {inspectedFiles:pins.length,originalCompileKotlinFiles:pins.filter(r=>r.compile&&r.language==='kotlin').length,
        inventorySha256:sha256(Buffer.from(JSON.stringify(pins))),references};
}
async function selection(rows,i,original,phase) {
    assert(Array.isArray(rows)&&rows.length>0&&rows.length<=20000); const sources=[],references=[],boundaries=[],seen=new Set(),owners=new Set();let bytesTotal=0;
    const required=new Set([...REPLACED,...i.lock.boundaries.map(r=>r.path),...(phase==='before'?[EXCLUDED]:[])]);
    for(let n=0;n<rows.length;n+=24) {
        const batch=await Promise.allSettled(rows.slice(n,n+24).map(async row=>({row,bytes:await readRegular(row.filename)})));
        for(const result of batch) {
            if(result.status!=='fulfilled') throw result.reason; const {row,bytes}=result.value;
            relativePath(row.path); assert(/\.(?:kt|java)$/.test(row.path)); outputPath(row.filename);
            assert(!seen.has(row.path)&&!owners.has(row.filename),'Duplicate syntax selection path/owner');seen.add(row.path);owners.add(row.filename);
            checked(bytes,row);bytesTotal+=bytes.length;assert(bytesTotal<=512*1024*1024);sources.push(project(row));
            const text=bytes.toString(), view=lexicalReferenceView(text);
            if(row.path!==HOST) {
                assert(!/\bKtSourceElement\s*\(/.test(view),'New selected sealed source-family constructor');
                assert(!/\b(?:import|typealias)\b[^\n]*\bKtSourceElement\b[^\n]*(?:\bas\b|=)|\btypealias\b[^\n]*=\s*(?:[\w.]+\.)?KtSourceElement\b/.test(view),'Source-family alias requires review');
            }
            assert(!/\b(?:class|object|interface)\s+Kt\w*PsiSourceElement\b/.test(view),'Selected PSI implementation');
            if(row.path===EXCLUDED) assert.equal(phase,'before','PSI-only syntax checker reintroduced');
            if(REPLACED.includes(row.path)||row.path===EXCLUDED) {
                let expected=original.get(row.path);
                if(phase==='after') expected=applyChanges(expected,i.lock.changes[row.path]);
                assert.deepEqual(canonical(bytes,i),expandObjectImports(expected,i.lock.objectOwners),'Selected complete syntax algorithm changed: '+row.path);
            }
            const boundary=i.lock.boundaries.find(r=>r.path===row.path);
            if(boundary) { checked(canonical(bytes,i),boundary); boundaries.push(project(row)); }
            const names=referenceNames(text);
            if(names.length) {
                assert(required.has(row.path),'New syntax declaration consumer or shadow: '+row.path);
                assert(phase==='before'||!names.includes('FirPrefixAndSuffixSyntaxChecker'),'Excluded PSI checker consumer');
                references.push({path:row.path,names});
            }
            if(required.has(row.path))required.delete(row.path);
        }
    }
    assert.equal(required.size,0,'Missing full syntax family or required source/entry boundary: '+[...required].join(','));
    assert.equal(boundaries.length,i.lock.boundaries.length); return {sources,references,boundaries,inspectedBytes:bytesTotal};
}
async function hostBinding(preparedHost,selected,i) {
    assert(preparedHost?.receiptPath&&preparedHost.receipt); const receiptPath=path.resolve(preparedHost.receiptPath);outputPath(receiptPath);
    const bytes=await readRegular(receiptPath),receipt=JSON.parse(bytes);assert.deepEqual(receipt,preparedHost.receipt);
    assert.equal(receipt.kind,'official-compiler-portable-source-host-preparation');assert.equal(receipt.sourceLockSha256,i.lock.sourceHostLockSha256);
    for(const logical of [HOST,PARSER]) {
        const pin=receipt.sources.find(r=>r.path===logical), boundary=i.lock.boundaries.find(r=>r.path===logical);assert(pin&&boundary);
        assert.deepEqual({bytes:pin.bytes,sha256:pin.sha256},{bytes:boundary.bytes,sha256:boundary.sha256});
        const row=selected.sources.find(r=>r.path===logical);assert(preparedHost.commonSources.includes(row.filename),'Wrong prepared source host owner');
    }
    const host=canonical(await readRegular(selected.sources.find(r=>r.path===HOST).filename),i).toString();
    assert(host.includes('sealed class KtSourceElement : AbstractKtSourceElement()'));assert.equal([...host.matchAll(/: KtSourceElement\(/g)].length,1);
    assert(host.includes('class KtLightSourceElement('));assert(!/\bclass Kt\w*PsiSourceElement\b/.test(host));
    const entry=canonical(await readRegular(selected.sources.find(r=>r.path===ENTRY).filename),i).toString();
    assert(entry.includes('MultiplatformParsing2Fir(session, provider.kotlinScopeProvider, diagnosticReporter)'));
    return {receiptPath,receiptSha256:sha256(bytes),sourceLockSha256:receipt.sourceLockSha256,sourceOwners:[HOST,PARSER].map(p=>selected.sources.find(r=>r.path===p))};
}
export async function prepareFirSyntaxLightTreeProfile({sourceRoot,outputRoot,retainedSources,preparedHost,recordedPropertyImports}) {
    sourceRoot=path.resolve(sourceRoot);outputRoot=path.resolve(outputRoot);outputPath(outputRoot);await assertNoSymlink(sourceRoot);await assertNoSymlink(outputRoot);
    assert(sourceRoot!==outputRoot&&!sourceRoot.startsWith(outputRoot+path.sep)&&!outputRoot.startsWith(sourceRoot+path.sep));
    const i=await inputs();assert.deepEqual(recordedPropertyImports,i.lock.recordedPropertyImports);
    const original=await originals(sourceRoot,i), audit=await primaryAudit(sourceRoot,i), selected=await selection(retainedSources,i,original,'before');
    const host=await hostBinding(preparedHost,selected,i);const files=[],commonSources=[];
    async function put(logical,bytes){const filename=path.join(outputRoot,logical);await assertNoSymlink(filename);await mkdir(path.dirname(filename),{recursive:true,mode:0o700});await writeFile(filename,bytes,{flag:'wx',mode:0o600});return filename;}
    for(const [logical,bytes] of original)await put('original/'+logical,bytes);
    for(const logical of [...REPLACED,EXCLUDED]) {
        const before=selected.sources.find(r=>r.path===logical),bytes=await readRegular(before.filename);await put('predecessor/'+logical,bytes);
        if(logical===EXCLUDED)continue;
        const afterBytes=applyChanges(bytes,i.lock.changes[logical]);assert.deepEqual(applyChanges(afterBytes,i.lock.changes[logical],true),bytes);
        const filename=await put(logical,afterBytes),after={path:logical,filename,...identity(afterBytes)};files.push({before,after});commonSources.push(filename);
    }
    const receipt={schemaVersion:1,kind:'official-fir-syntax-lighttree-preparation',source:i.lock.source,sourceLockSha256:sha256(i.lockBytes),
        preparationToolSha256:sha256(await readRegular(fileURLToPath(import.meta.url))),audit,selection:selected,host,files,
        excluded:selected.sources.find(r=>r.path===EXCLUDED),sourceSetExclusions:[EXCLUDED],replacedOriginalPaths:REPLACED,
        spans:Object.values(i.lock.changes).reduce((n,c)=>n+c.length,0),fullFirRuntime:false,fullCompilerBuilt:false,kmpLiteralAffixDiagnosticParity:false};
    const receiptPath=path.join(outputRoot,'receipt.json');await writeJson(receiptPath,receipt);
    return {outputRoot,receiptPath,receipt,receiptSha256:sha256(await readRegular(receiptPath)),commonSources,sourceSetExclusions:[EXCLUDED],replacedOriginalPaths:REPLACED};
}
export async function verifyFirSyntaxLightTreeFinalSources({outputRoot,retainedSources,expectedReceiptSha256}) {
    outputRoot=path.resolve(outputRoot);outputPath(outputRoot);await assertNoSymlink(outputRoot);const i=await inputs();
    const receiptBytes=await readRegular(path.join(outputRoot,'receipt.json'),64*1024*1024);assert.match(expectedReceiptSha256??'',/^[0-9a-f]{64}$/);
    assert.equal(sha256(receiptBytes),expectedReceiptSha256,'Externally bound syntax preparation receipt changed');const receipt=JSON.parse(receiptBytes);
    assert.equal(receipt.kind,'official-fir-syntax-lighttree-preparation');assert.equal(receipt.sourceLockSha256,sha256(i.lockBytes));
    assert.equal(receipt.preparationToolSha256,sha256(await readRegular(fileURLToPath(import.meta.url))));assert.deepEqual(receipt.sourceSetExclusions,[EXCLUDED]);assert.deepEqual(receipt.replacedOriginalPaths,REPLACED);
    const original=await originals(path.join(outputRoot,'original'),i), selected=await selection(retainedSources,i,original,'after');
    assert.deepEqual(selected.boundaries,receipt.selection.boundaries,'Syntax host/entry/consumer owner or bytes changed');
    assert.equal(sha256(await readRegular(receipt.host.receiptPath)),receipt.host.receiptSha256,'Bound original host receipt changed');
    assert.deepEqual(receipt.files.map(r=>r.after.path),REPLACED);const reverse=new Map();
    for(const {before,after} of receipt.files) {
        assert.equal(after.filename,path.join(outputRoot,after.path));assert.equal(before.path,after.path);
        assert.deepEqual(selected.sources.find(r=>r.path===after.path),after,'Final syntax source owner or bytes changed');
        const predecessor=checked(await readRegular(path.join(outputRoot,'predecessor',before.path)),before);
        assert.deepEqual(canonical(predecessor,i),expandObjectImports(original.get(before.path),i.lock.objectOwners));
        assert.deepEqual(applyChanges(await readRegular(after.filename),i.lock.changes[before.path],true),predecessor,'Full syntax reverse reconstruction differs');
        checked(await readRegular(before.filename),before,'Original selected source owner changed');reverse.set(before.path,before);
    }
    checked(await readRegular(path.join(outputRoot,'predecessor',EXCLUDED)),receipt.excluded);
    checked(await readRegular(receipt.excluded.filename),receipt.excluded);
    const predecessorRetainedSources=selected.sources.map(r=>reverse.get(r.path)??r);
    const oldPosition=receipt.selection.sources.findIndex(r=>r.path===EXCLUDED);
    const next=receipt.selection.sources.slice(oldPosition+1).find(r=>predecessorRetainedSources.some(s=>s.path===r.path));
    const insertion=next?predecessorRetainedSources.findIndex(r=>r.path===next.path):predecessorRetainedSources.length;
    predecessorRetainedSources.splice(insertion,0,receipt.excluded);
    return {receipt:{schemaVersion:1,kind:'official-fir-syntax-lighttree-final-selection',preparationReceiptSha256:expectedReceiptSha256,
        selectedSources:selected.sources.length,checked:receipt.files.map(r=>r.after),boundaries:selected.boundaries,references:selected.references,
        sourceSetExclusions:[EXCLUDED],sourceFamily:'sealed-light-tree-only',preservedLightTreeAndCommonAlgorithms:true,
        fullFirRuntime:false,fullCompilerBuilt:false,kmpLiteralAffixDiagnosticParity:false},predecessorRetainedSources};
}
