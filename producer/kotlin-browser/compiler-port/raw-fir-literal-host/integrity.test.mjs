import assert from 'node:assert/strict';import {copyFile,mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';import test,{after} from 'node:test';
import {readRegular,sha256,writeJson} from '../../scripts/source.mjs';
import {actualFixture,HERE,REPO} from './fixture.mjs';
import {TARGET,HELPERS,RECIPE,transformRawFirLiteral,assembleRawFirLiteralImports} from './transform.mjs';
import {prepareRawFirLiteralHost,verifyRawFirLiteralHost,verifyFinalRawFirLiteralHost} from './prepare.mjs';
assert.equal(process.argv.length,3);const root=path.resolve(process.argv[2]);assert(root.startsWith(path.join(REPO,'out')+path.sep));await mkdir(root,{mode:0o700});
const fixture=await actualFixture(),prepared=await prepareRawFirLiteralHost({...fixture,outputRoot:path.join(root,'prepared')}),options={outputRoot:prepared.outputRoot,expectedReceiptSha256:prepared.receiptSha256},rows=fixture.retainedSources.map(row=>({...row}));
for(const filename of prepared.commonSources){const bytes=await readRegular(filename),row={path:path.relative(prepared.outputRoot,filename),filename,bytes:bytes.length,sha256:sha256(bytes)},index=rows.findIndex(p=>p.path===row.path);if(index<0)rows.push(row);else rows[index]=row;}
const inputs=[];for(const name of ['integrity.test.mjs','fixture.mjs','prepare.mjs','transform.mjs','fetch.mjs','sources.lock.json','RawFirLiteralHelpers.kt']){const bytes=await readRegular(path.join(HERE,name));inputs.push({path:path.join(HERE,name),bytes:bytes.length,sha256:sha256(bytes)});}
const passed=[],final=extra=>verifyFinalRawFirLiteralHost({...options,retainedSources:rows,recordedPropertyImports:fixture.recordedPropertyImports,...extra});
async function mutate(row,bytes){await writeFile(row.filename,bytes);row.bytes=bytes.length;row.sha256=sha256(bytes);}
test('11 exact spans reconstruct the complete genuine builder',async()=>{
 const original=await readRegular(path.join(fixture.sourceRoot,TARGET)),common=transformRawFirLiteral(original);let restored=common.toString();
 for(const[before,after,count]of[...RECIPE].reverse()){if(!after){continue;}assert.equal(restored.split(after).length-1,count);restored=restored.split(after).join(before);}
 // Empty-import removal spans restore at their original preceding/following import anchors.
 const anchors=[['import org.jetbrains.kotlin.*\n','import com.intellij.psi.PsiElement\n'],['import org.jetbrains.kotlin.utils.exceptions.requireWithAttachment\n','import org.jetbrains.kotlin.utils.exceptions.withPsiEntry\n']];
 for(const[anchor,addition]of anchors){assert.equal(restored.split(anchor).length-1,1);restored=restored.replace(anchor,addition.startsWith('import com.')?addition+anchor:anchor+addition);}
 assert.deepEqual(Buffer.from(restored),original);assert.throws(()=>transformRawFirLiteral(common));passed.push('full-builder-roundtrip');
});
test('actual3540 graph selects3541 with all other owners/order preserved',async()=>{
 await verifyRawFirLiteralHost(options);const receipt=await final();assert.equal(rows.length,3541);assert.equal(receipt.checked.length,2);assert.equal(receipt.boundaries.length,15);
 assert.deepEqual(rows.filter(r=>r.path!==TARGET&&r.path!==HELPERS),fixture.retainedSources.filter(r=>r.path!==TARGET));passed.push('actual-selection-positive');
});
test('rehashing modified full builder or helper cannot authorize changed algorithms',async()=>{
 for(const logical of [TARGET,HELPERS]){const row=rows.find(r=>r.path===logical),before=await readRegular(row.filename),forged=Buffer.from(before.toString().replace(logical===TARGET?'diagnostic = DiagnosticKind.WrongLongSuffix':'text.endsWith(\'u\') || text.endsWith(\'U\')',logical===TARGET?'diagnostic = DiagnosticKind.IllegalConstExpression':'false'));
  assert(!forged.equals(before));await mutate(row,forged);await assert.rejects(final());await mutate(row,before);await final();}
 passed.push('body-negatives-restored');
});
test('external digest and complete original/supplemental snapshots prevent reauthoring',async()=>{
 const before=await readRegular(prepared.receiptPath),receipt=JSON.parse(before);receipt.fullCompilerBuilt=true;const changed=Buffer.from(JSON.stringify(receipt));
 await writeFile(prepared.receiptPath,changed);await assert.rejects(final());await assert.rejects(verifyRawFirLiteralHost({...options,expectedReceiptSha256:sha256(changed)}));await writeFile(prepared.receiptPath,before);
 const lock=JSON.parse(await readRegular(path.join(HERE,'sources.lock.json')));
 for(const logical of ['original/'+TARGET,'supplemental/'+lock.supplementalSources[0].path,'boundaries/'+lock.boundaries[0].path]){const file=path.join(prepared.outputRoot,logical),bytes=await readRegular(file);await writeFile(file,Buffer.concat([bytes,Buffer.from('\n')]));await assert.rejects(final());await writeFile(file,bytes);}
 await final();passed.push('receipt-snapshot-negatives-restored');
});
test('missing/duplicate/relocated final owners and host owners reject',async()=>{
 const row=rows.find(r=>r.path===HELPERS);
 await assert.rejects(final({retainedSources:rows.filter(r=>r!==row)}));await assert.rejects(final({retainedSources:[...rows,{...row}]}));
 await assert.rejects(final({retainedSources:[...rows,{...row,path:'copy/LiteralHelpers.kt'}]}));
 const copy=path.join(root,'identical-helper.kt');await copyFile(row.filename,copy);await assert.rejects(final({retainedSources:rows.map(r=>r===row?{...row,filename:copy}:r)}));
 const host=rows.find(r=>r.path.endsWith('/KtSourceElement.kt')),copyHost=path.join(root,'identical-host.kt');await copyFile(host.filename,copyHost);
 await assert.rejects(final({retainedSources:rows.map(r=>r===host?{...host,filename:copyHost}:r)}));await final();passed.push('owner-negatives-restored');
});
test('exact late JVM/property/assert assembly passes and unknown/duplicate imports reject',async()=>{
 for(const row of rows.filter(r=>r.path===TARGET||r.path===HELPERS)){const before=await readRegular(row.filename),assembled=assembleRawFirLiteralImports(before,fixture.recordedPropertyImports);
  await mutate(row,assembled);await assert.rejects(final({recordedPropertyImports:[]}));await final();
  const text=assembled.toString(),pkg=/^package[^\r\n]+/m.exec(text),end=pkg.index+pkg[0].length;
  await mutate(row,Buffer.from(text.slice(0,end)+'\nimport org.example.unrecorded\n'+text.slice(end)));await assert.rejects(final());
  const marker='\n'+fixture.recordedPropertyImports.map(name=>'import '+name).join('\n')+'\n';await mutate(row,Buffer.from(text.slice(0,end)+marker+text.slice(end)));await assert.rejects(final());
  await mutate(row,before);await final();}
 passed.push('late-assembly-negatives-restored');
});
test('new builder callers, aliases, and PSI shadows invalidate selected LightNode scope',async()=>{
 for(const[index,source]of ['package injected\nclass Caller : org.jetbrains.kotlin.fir.builder.AbstractRawFirBuilder<Any,Any>()\n',
 'package injected\ntypealias Alias = org.jetbrains.kotlin.fir.builder.AbstractRawFirBuilder<Any,Any>\n',
 'package com.intellij.psi\ntypealias PsiElement = Any\n'].entries()){
  const file=path.join(root,'new-caller-'+index+'.kt'),bytes=Buffer.from(source);await writeFile(file,bytes,{flag:'wx',mode:0o600});
  await assert.rejects(final({retainedSources:[...rows,{path:'injected/Caller'+index+'.kt',filename:file,bytes:bytes.length,sha256:sha256(bytes)}]}));}
 await final();passed.push('node-profile-negatives-restored');
});
test('source cache tampering and overlapping/reused output roots reject',async()=>{
 const copySource=path.join(root,'source-copy'),lock=JSON.parse(await readRegular(path.join(HERE,'sources.lock.json')));
 for(const p of [lock.original,lock.numbers]){const file=path.join(copySource,p.path);await mkdir(path.dirname(file),{recursive:true});await copyFile(path.join(fixture.sourceRoot,p.path),file);}
 const file=path.join(copySource,TARGET),bytes=await readRegular(file);await writeFile(file,Buffer.concat([bytes,Buffer.from('\n')]));
 await assert.rejects(prepareRawFirLiteralHost({...fixture,sourceRoot:copySource,outputRoot:path.join(root,'tampered')}));
 await assert.rejects(prepareRawFirLiteralHost({...fixture,outputRoot:prepared.outputRoot}));await assert.rejects(prepareRawFirLiteralHost({...fixture,outputRoot:fixture.sourceRoot}));await assert.rejects(prepareRawFirLiteralHost({...fixture,outputRoot:path.join(fixture.sourceRoot,'nested')}));passed.push('roots-cache-negatives');
});
after(async()=>{if(passed.length!==8)return;for(const p of inputs){const bytes=await readRegular(p.path);assert.equal(bytes.length,p.bytes);assert.equal(sha256(bytes),p.sha256);}
 await writeJson(path.join(root,'receipt.json'),{schemaVersion:1,kind:'genuine-raw-fir-literal-integrity',result:'pass',passed,historical:fixture.historical,originalInventory:fixture.retainedSources,inputs,
  finalSources:rows.length,fullCompilerBuilt:false,psiAttachmentParity:false,universalJavaNumberStringParity:false,languageReadiness:false});});
