import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
assert.equal(process.argv.length,5,'Usage: evidence.mjs METADATA_JOB EXECUTION_JOB GUARDS_JOB');
async function pin(filename){const bytes=await readRegular(filename,64*1024*1024);return{filename,bytes:bytes.length,sha256:sha256(bytes)};}
async function check(base,rows){for(let n=0;n<rows.length;n+=24){const results=await Promise.allSettled(rows.slice(n,n+24).map(async row=>{const filename=row.filename??path.resolve(base,row.path);const actual=await pin(filename);assert.equal(actual.bytes,row.bytes,filename);assert.equal(actual.sha256,row.sha256,filename);}));for(const r of results)if(r.status!=='fulfilled')throw r.reason;}}
const records=[],receipts=[];
for(const [index,jobPath]of process.argv.slice(2).entries()){
 const job=JSON.parse(await readRegular(jobPath)),status=JSON.parse(await readRegular(job.status));assert.equal(status.state,'exited');assert.equal(status.exitCode,0);assert.equal(status.pid,job.pid);
 const bytes=await readRegular(path.join(job.output,'receipt.json'),64*1024*1024),receipt=JSON.parse(bytes);
 assert.equal(receipt.result??'pass','pass');assert.equal(receipt.fullCompilerBuilt,false);assert.equal(receipt.languageReadiness,false);
 await check(HERE,receipt.inputs);
 if(index<2){await check(job.output,receipt.artifacts);assert.equal(receipt.commands.length,index===0?4:7);assert(receipt.commands.every(row=>row.exitCode===0));assert.equal(receipt.records,index===0?499:27);
  const names=index===0?['original-actual-genuine-factory-metadata-jvm-observe','common-actual-genuine-factory-metadata-jvm-observe']:['original-creation-execution-action-disabled-jvm-observe','common-creation-execution-action-disabled-jvm-observe','complete-common-factory-node-wasm-observe'];
  for(const name of names){const raw=await readRegular(path.join(job.output,name+'.stdout'));assert.equal(sha256(raw),receipt.rawSha256);assert.equal(raw.toString().trimEnd().split('\n').length,receipt.records);}
 }else{assert.equal(receipt.passed.length,9);assert.equal(receipt.originalInventory.length,3540);await check(REPO,receipt.originalInventory);}
 records.push({job:await pin(jobPath),status:await pin(job.status),log:await pin(job.log),runner:await pin(job.runner),receipt:await pin(path.join(job.output,'receipt.json')),outputRoot:job.output,exitCode:0,durationSeconds:status.durationSeconds});receipts.push(bytes);
}
const currentFiles=[];async function current(root){for(const e of await readdir(root,{withFileTypes:true})){if(root===HERE&&e.name==='evidence')continue;const f=path.join(root,e.name);if(e.isDirectory())await current(f);else currentFiles.push(await pin(f));}}await current(HERE);
await mkdir(path.join(HERE,'evidence'),{mode:0o700});
for(const [i,name]of ['metadata.json','execution.json','integrity.json'].entries())await writeFile(path.join(HERE,'evidence',name),receipts[i],{flag:'wx',mode:0o600});
await writeJson(path.join(HERE,'evidence/executions.json'),{schemaVersion:1,kind:'genuine-lowering-phase-factories-completed-evidence',records,currentFiles,fullIrLoweringExecuted:false,fullCompilerBuilt:false,languageReadiness:false});
console.log(JSON.stringify({result:'pass',executions:records.length,currentFiles:currentFiles.length}));
