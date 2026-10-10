import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareSerializerNullability,verifySerializerNullability} from './prepare.mjs';
import {bindSerializerNullableGetters,HELPER} from './transform.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
const inventory=JSON.parse(await readFile(path.join(HERE,'inventory.json'))),lock=JSON.parse(await readFile(path.join(HERE,'sources.lock.json')));
const sourceRoot=path.join(REPO,'out/kotlin-compiler-port/sources'),original=await readFile(path.join(sourceRoot,inventory.consumer.path));
const ast=JSON.parse(await readFile(path.join(HERE,'../js-ast/evidence/receipt.json'))),command=ast.commands.find(x=>x.phase==='actual-original-jvm-observe').command;
const astOutput=path.join(path.dirname(command[command.indexOf('-cp')+1].split(path.delimiter)[0]),'common');
const preparedJsAst={outputRoot:astOutput,receipt:ast.preparation,receiptPath:path.join(astOutput,'js-ast-inputs.json'),commonSources:ast.preparation.files.map(x=>path.join(astOutput,x.path))};
async function unit(action){const outputRoot=await mkdtemp(path.join(REPO,'out/serializer-nullability-guard-'));try{await action({sourceRoot,outputRoot,preparedJsAst});}finally{await rm(outputRoot,{recursive:true,force:true});}}
test('exact25 checks+2 direct nonnull getters+1 metadata preserve every other original byte',()=>{
    const r=bindSerializerNullableGetters(original,inventory),text=r.bytes.toString();assert.equal(r.bindings.length,27);
    assert.equal((text.match(/requiredSerializerAstValue\(/g)??[]).length,26);assert.equal((text.match(/requiredSerializerMetadataValue\(value\)::class/g)??[]).length,1);
    assert(text.includes('writeExpression(requiredSerializerAstValue(x.arg1, "getArg1(...)"))'));
    assert(text.includes('writeExpression(requiredSerializerAstValue(x.arg2, "getArg2(...)"))'));
    let undo=text.slice(0,-HELPER.length),shift=0;
    const mutations=[...r.bindings.map(row=>({start:row.start,before:row.before,after:row.after})),
        {start:inventory.metadataClassLiteral.start,before:'value::class.qualifiedName',after:'requiredSerializerMetadataValue(value)::class.qualifiedName'}]
        .sort((a,b)=>a.start-b.start).map(row=>{const value={...row,preparedStart:row.start+shift};shift+=row.after.length-row.before.length;return value;});
    for(const row of mutations.reverse()){
        assert.equal(undo.slice(row.preparedStart,row.preparedStart+row.after.length),row.after);
        undo=undo.slice(0,row.preparedStart)+row.before+undo.slice(row.preparedStart+row.after.length);
    }
    assert.equal(undo,original.toString());
    assert.equal(r.bytes.length,lock.prepared.bytes);assert.equal(text.match(/declarable\.getName\(\)/g).length,2);
});
test('unknown source body/offset and missing/duplicate recipe reject',()=>{
    assert.throws(()=>bindSerializerNullableGetters(Buffer.from(original.toString().replace('writeByte(StatementIds.THROW)','writeByte(StatementIds.RETURN)')),inventory));
    for(const transform of [d=>d.bindings.pop(),d=>d.bindings.push(d.bindings[0]),d=>d.bindings[0].start++,d=>d.bindings[0].before='writeExpression(x.value)',d=>d.bindings[12].getter='getArg(...)']){
        const d=structuredClone(inventory);transform(d);assert.throws(()=>bindSerializerNullableGetters(original,d));
    }
});
test('genuine preparation and full AST dependency replay succeed',()=>unit(async options=>{
    const r=await prepareSerializerNullability(options);assert.equal(r.commonSources.length,1);assert.deepEqual(r.replacedOriginalPaths,[inventory.consumer.path]);
    assert.equal((await verifySerializerNullability(options)).transportChanged,false);
}));
test('fabricated AST receipt or canonical source list reject',()=>unit(async options=>{
    const receipt=structuredClone(preparedJsAst.receipt);receipt.propertyAliasImports.push('org.jetbrains.kotlin.js.backend.ast.JsExport');
    await assert.rejects(()=>prepareSerializerNullability({...options,preparedJsAst:{...preparedJsAst,receipt}}));
    await assert.rejects(()=>prepareSerializerNullability({...options,preparedJsAst:{...preparedJsAst,commonSources:preparedJsAst.commonSources.slice(1)}}));
    await assert.rejects(()=>prepareSerializerNullability({...options,preparedJsAst:{...preparedJsAst,receiptPath:path.join(options.outputRoot,'forged-receipt.json')}}));
}));
test('changed selected prepared expression/NPE text reject',()=>unit(async options=>{
    const r=await prepareSerializerNullability(options),filename=r.commonSources[0];const bytes=await readFile(filename);
    await writeFile(filename,bytes.toString().replace('getArg1(...)','getArg(...)'));await assert.rejects(()=>verifySerializerNullability(options));
}));
test('reference bytes and false scope/readiness claims are bound',()=>unit(async options=>{
    const r=await prepareSerializerNullability(options);const receipt=structuredClone(r.receipt);receipt.fullSerializerWasmExecuted=true;
    await writeFile(r.receiptPath,JSON.stringify(receipt));await assert.rejects(()=>verifySerializerNullability(options));
    await writeFile(r.receiptPath,JSON.stringify(r.receipt));await writeFile(path.join(options.outputRoot,r.receipt.referencePath),original.toString()+'\n');
    await assert.rejects(()=>verifySerializerNullability(options));
}));
