import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyPreparation } from './build.mjs';

// Guard tests reuse actual generated input bytes. This path fixture is never an
// execution receipt: only absolute paths are rewritten into an isolated copy.
const HERE=path.dirname(fileURLToPath(import.meta.url));
const prepared=process.env.KOTLIN_CODEC_PREPARED ?? path.resolve(HERE,'../../../../out/kotlin-compiler-serialization/probe-8/prepared');
let available=true;
try {await readFile(path.join(prepared,'receipt.json'));} catch(error) {if(error.code==='ENOENT')available=false;else throw error;}
async function fixture(t) {
 const temporary=await mkdtemp(path.join(os.tmpdir(),'kotlin-codec-guard-'));t.after(()=>rm(temporary,{recursive:true,force:true}));
 const directory=path.join(temporary,'prepared');await cp(prepared,directory,{recursive:true,dereference:false});
 const receipt=JSON.parse(await readFile(path.join(directory,'receipt.json'),'utf8'));
 for(const record of receipt.runtime)record.absolutePath=path.join(directory,'runtime',record.path);
 for(const record of receipt.files)record.absolutePath=path.join(directory,'generated',record.path);
 await writeFile(path.join(directory,'receipt.json'),JSON.stringify(receipt));return {directory,receipt};
}
const options={skip:!available?'Actual codec preparation unavailable; integration guard not run':false};
test('authentic generated common sources and sealed runtime are verified',options,async t=>{
 const {directory}=await fixture(t);const result=await verifyPreparation(directory);assert.equal(result.receipt.messages,131);assert.equal(result.receipt.fields,626);assert.equal(result.receipt.extensions,47);assert.equal(result.sourceFiles.length,11);
});
for(const [id,change]of [
 ['wrong selected source',r=>{r.source.commit='0'.repeat(40);}],
 ['ready claim in preparation',r=>{r.readiness=true;}],
 ['missing runtime source',r=>{r.runtime.pop();}],
 ['escaping runtime path',r=>{r.runtime[0].absolutePath='/tmp/escaped-runtime.kt';}],
 ['changed descriptor identity',r=>{r.descriptorSha256='0'.repeat(64);}],
]) test(id+' is rejected',options,async t=>{
 const {directory,receipt}=await fixture(t);change(receipt);await writeFile(path.join(directory,'receipt.json'),JSON.stringify(receipt));await assert.rejects(verifyPreparation(directory));
});
for(const name of ['metadata-ir.pb','generate.py','runtime/Runtime.kt','generated/ProtoBuf.kt','generated/catalog.json'])test('tampered '+name+' fails closed',options,async t=>{
 const {directory}=await fixture(t);await writeFile(path.join(directory,name),'tampered');await assert.rejects(verifyPreparation(directory));
});
test('generated source symlink is rejected before reading its target',options,async t=>{
 const {directory}=await fixture(t);const source=path.join(directory,'generated','ProtoBuf.kt');await rm(source);await symlink(path.join(directory,'generated','KotlinIr.kt'),source);await assert.rejects(verifyPreparation(directory),/symlink/i);
});
test('generated source traversal is rejected even with a matching rewritten index',options,async t=>{
 const {directory,receipt}=await fixture(t);const generation=JSON.parse(await readFile(path.join(directory,'generated','generation.json'),'utf8'));
 receipt.files[0].path='../../outside.kt';receipt.files[0].absolutePath=path.join(directory,'generated',receipt.files[0].path);generation.files[0].path=receipt.files[0].path;
 await writeFile(path.join(directory,'receipt.json'),JSON.stringify(receipt));await writeFile(path.join(directory,'generated','generation.json'),JSON.stringify(generation));await assert.rejects(verifyPreparation(directory),/path|traversal|relative/i);
});
