import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { readFile,writeFile } from 'node:fs/promises';
import { sha256,writeJson } from '../../scripts/source.mjs';
import { EXCLUDED,BASE,HOST,referenceNames } from './transform.mjs';
import { verifyFirSyntaxLightTreeFinalSources } from './prepare.mjs';

test('conservative aliases, backticks, literals, unicode and interpolation remain visible',()=>{
    for(const source of [
        'import org.jetbrains.kotlin.fir.analysis.checkers.syntax.FirPrefixAndSuffixSyntaxChecker as Affix',
        'val x=org.jetbrains.kotlin.fir.analysis.checkers.syntax.`FirPrefixAndSuffixSyntaxChecker`',
        'val x="FirPrefixAndSuffixSyntaxChecker"',
        'val x="FirPrefixAnd" + "SuffixSyntaxChecker"',
        'val x="FirPrefixAndSuffixSyntaxCheck\\u0065r"',
        'val x="${FirPrefixAndSuffixSyntaxChecker}"',
        'typealias A = FirSyntaxChecker<Any>',
        'val checker=FirAnnotatedBinaryExpressionChecker',
    ]) assert(referenceNames(source).length,source);
});

test('actual full-selection public final rejects changed PSI reachability, algorithms, owners and receipt',{skip:!process.env.FIR_SYNTAX_FIXTURE},async()=>{
    const fixture=JSON.parse(await readFile(process.env.FIR_SYNTAX_FIXTURE,'utf8')),prepared=fixture.prepared,rows=fixture.retainedSources;
    const checks=[];const call=(selection=rows,digest=prepared.receiptSha256)=>verifyFirSyntaxLightTreeFinalSources({outputRoot:prepared.outputRoot,retainedSources:selection,expectedReceiptSha256:digest});
    async function reject(name,run){await assert.rejects(run);checks.push({name,result:'rejected'});}
    await reject('externally bound receipt digest',()=>call(rows,'0'.repeat(64)));
    await reject('excluded PSI checker reintroduced',()=>call([...rows,fixture.originalSources.find(r=>r.path===EXCLUDED)]));
    await reject('required sealed source host absent',()=>call(rows.filter(r=>r.path!==HOST)));
    const base=rows.find(r=>r.path===BASE),baseBytes=await readFile(base.filename),wrong=path.join(path.dirname(process.env.FIR_SYNTAX_FIXTURE),'wrong-owner.kt');await writeFile(wrong,baseBytes);
    await reject('identical complete base under wrong physical owner',()=>call(rows.map(r=>r.path===BASE?{...r,filename:wrong}:r)));
    async function mutate(name,before,after){assert.equal(baseBytes.toString().split(before).length,2);const changed=Buffer.from(baseBytes.toString().replace(before,after));await writeFile(base.filename,changed);try{await reject(name,()=>call(rows.map(r=>r.path===BASE?{...r,bytes:changed.length,sha256:sha256(changed)}:r)));}finally{await writeFile(base.filename,baseBytes);}}
    await mutate('applicability algorithm changed with honest digest','if (!isApplicable(element, source)) return','if (isApplicable(element, source)) return');
    await mutate('unknown final import with honest digest','package org.jetbrains.kotlin.fir.analysis.checkers.syntax','package org.jetbrains.kotlin.fir.analysis.checkers.syntax\nimport invented.host.*');
    const extra=path.join(path.dirname(process.env.FIR_SYNTAX_FIXTURE),'new-source.kt');
    async function add(name,text){const bytes=Buffer.from(text);await writeFile(extra,bytes);await reject(name,()=>call([...rows,{path:'compiler-port-fixture/New.kt',filename:extra,bytes:bytes.length,sha256:sha256(bytes)}]));}
    await add('new fully qualified sealed source-family subclass','package fixture\nclass Other : org.jetbrains.kotlin.KtSourceElement()\n');
    await add('new PSI checker alias in interpolation','package fixture\nimport org.jetbrains.kotlin.fir.analysis.checkers.syntax.FirPrefixAndSuffixSyntaxChecker as Affix\nval use="${Affix}"\n');
    const final=await call();assert.equal(final.receipt.selectedSources,rows.length);assert.deepEqual(final.predecessorRetainedSources,fixture.originalSources);
    await writeJson(path.join(path.dirname(process.env.FIR_SYNTAX_FIXTURE),'integrity.json'),{schemaVersion:1,kind:'fir-syntax-public-final-guards',result:'pass',checks,
        actualSources:rows.length,restoredFinalPassed:true,preparationReceiptSha256:prepared.receiptSha256,fullCompilerBuilt:false});
});


test('retained syntax import boundaries use the portable source host',{skip:!process.env.FIR_SYNTAX_FIXTURE},async()=>{
    const fixture=JSON.parse(await readFile(process.env.FIR_SYNTAX_FIXTURE,'utf8'));
    const lock=JSON.parse(await readFile(new URL('sources.lock.json',import.meta.url),'utf8'));
    for(const output of lock.outputs){
        const row=fixture.retainedSources.find(item=>item.path===output.path);assert(row,'Missing full syntax output: '+output.path);
        assert.equal(row.filename,path.join(fixture.prepared.outputRoot,output.path));
        const bytes=await readFile(row.filename);assert.equal(bytes.length,row.bytes);assert.equal(sha256(bytes),row.sha256);
        // Comments must not conceal imports of tree carriers absent from the common host.
        const text=bytes.toString().replace(/\/\*[\s\S]*?\*\//g,'');
        const unavailable=[...text.matchAll(/^import\s+com\.intellij\.(?:lang\.LighterASTNode|psi\.tree\.(?:IElementType|TokenSet)|util\.diff\.FlyweightCapableTreeStructure)\b/gm)].map(match=>match[0]);
        assert.deepEqual(unavailable,[],output.path+' retains an unavailable legacy tree carrier import');
    }
    assert.equal(lock.outputs.length,18);
});
