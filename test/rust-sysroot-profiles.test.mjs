import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {inventorySysroot,validateSysrootTrace,packageSysrootProfiles,selectSysrootDelivery} from '../producer/rust-browser/scripts/package-sysroot-profiles.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
async function fixture(t,target='wasm32-wasip1'){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rust-hot-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const sysroot=path.join(dir,'lib');await fs.mkdir(path.join(sysroot,'self-contained'),{recursive:true});
 for(const name of ['libcore-a.rlib','libstd-b.rlib','libtest-c.rlib','self-contained/crt1.o'])await fs.writeFile(path.join(sysroot,name),Buffer.from('!<arch>\n'+name));
 const compilerManifest=path.join(dir,'manifest.json');const data=Buffer.from('{"revision":"fixture"}');await fs.writeFile(compilerManifest,data);
 const inventory=await inventorySysroot(sysroot,target);
 const trace={format:'wasm-rust-sysroot-trace-v1',target,compilerManifestSha256:sha(data),inventorySha256:inventory.inventorySha256,scenarios:[{name:'hello',exitCode:0,sourceSha256:sha('fn main() {}'),files:['libcore-a.rlib','libstd-b.rlib','self-contained/crt1.o']}]};
 const traceFile=path.join(dir,'trace.json');await fs.writeFile(traceFile,JSON.stringify(trace));
 return{dir,sysroot,target,compilerManifest,traceFile,trace,inventory,output:path.join(dir,'out')};
}
test('hot/extra preserve every file and full pack uses only the selected target',async t=>{
 const f=await fixture(t,'wasm32-wasip2');const{manifest}=await packageSysrootProfiles(f);const partitions={};
 for(const[name,p]of Object.entries(manifest.profiles)){
  const data=gunzipSync(await fs.readFile(path.join(f.output,p.asset)));const idx=JSON.parse(gunzipSync(await fs.readFile(path.join(f.output,p.index))));
  assert.equal(data.length,p.totalBytes);assert.equal(idx.fileCount,p.fileCount);partitions[name]=[];
  for(const e of idx.entries){assert(e.runtimePath.startsWith('/lib/rustlib/wasm32-wasip2/lib/'));const key=e.runtimePath.split('/lib/').at(-1);assert.deepEqual(data.subarray(e.offset,e.offset+e.length),await fs.readFile(path.join(f.sysroot,key)));partitions[name].push(e.runtimePath)}
  for(const[filename,r]of Object.entries(p.receipts)){const bytes=await fs.readFile(path.join(f.output,filename));assert.equal(sha(bytes),r.sha256);assert.equal(sha(gunzipSync(bytes)),r.uncompressedSha256)}
 }
 assert.deepEqual([...partitions.hot,...partitions.extra].sort(),partitions.full.sort());assert.equal(partitions.extra.length,1);assert.equal(manifest.promotion,'requires-real-compiler-probe');
});
test('rejects stale inventory, compiler, target, failed scenarios and unknown files',async t=>{
 const f=await fixture(t),h=f.trace.compilerManifestSha256;
 for(const change of [{inventorySha256:'0'.repeat(64)},{compilerManifestSha256:'0'.repeat(64)},{target:'wasm32-wasip3'},{scenarios:[]},{scenarios:[{...f.trace.scenarios[0],exitCode:1}]},{scenarios:[{...f.trace.scenarios[0],files:['missing.rlib']}]},{scenarios:[{...f.trace.scenarios[0],files:['../outside']}]}])assert.throws(()=>validateSysrootTrace({...f.trace,...change},f.inventory,f.target,h));
 await fs.writeFile(path.join(f.sysroot,'libstd-b.rlib'),'changed');await assert.rejects(packageSysrootProfiles(f),/inventory/);
});
test('rejects symlink inputs and refuses existing output',async t=>{
 const f=await fixture(t);await fs.symlink('/etc/passwd',path.join(f.sysroot,'link'));await assert.rejects(packageSysrootProfiles(f),/Non-regular/);await fs.unlink(path.join(f.sysroot,'link'));await fs.mkdir(f.output);await assert.rejects(packageSysrootProfiles(f),/already exists/);
});
test('rejects an output beneath a symlinked alias of the input before creating directories',async t=>{
 const f=await fixture(t),alias=path.join(f.dir,'alias');
 await fs.symlink(f.sysroot,alias,'dir');
 await assert.rejects(packageSysrootProfiles({...f,output:path.join(alias,'generated','profiles')}),/outside input/);
 await assert.rejects(fs.lstat(path.join(f.sysroot,'generated')),{code:'ENOENT'});
});
test('reserves the output before publishing and never replaces a competing directory',async t=>{
 const f=await fixture(t),originalMkdir=fs.mkdir,marker=path.join(f.output,'competitor');
 let competed=false;
 fs.mkdir=async(directory,...args)=>{
  if(directory===f.output && !competed){
   competed=true;
   await originalMkdir(f.output);
   await fs.writeFile(marker,'owned by another operation');
  }
  return originalMkdir(directory,...args);
 };
 try{await assert.rejects(packageSysrootProfiles(f),/already exists|EEXIST/)}
 finally{fs.mkdir=originalMkdir}
 assert.equal(competed,true);
 assert.equal(await fs.readFile(marker,'utf8'),'owned by another operation');
 assert.deepEqual(await fs.readdir(f.output),['competitor']);
});
test('does not publish a manifest when copying a reserved output fails',async t=>{
 const f=await fixture(t),originalCopyFile=fs.copyFile;
 fs.copyFile=async(source,destination,...args)=>{
  if(path.basename(destination)==='hot.pack.gz')throw new Error('injected copy failure');
  return originalCopyFile(source,destination,...args);
 };
 try{await assert.rejects(packageSysrootProfiles(f),/injected copy failure/)}
 finally{fs.copyFile=originalCopyFile}
 await assert.rejects(fs.lstat(path.join(f.output,'sysroot-profiles.v1.json')),{code:'ENOENT'});
 assert((await fs.readdir(f.output)).length>0);
});
test('is byte deterministic and permits an empty extra pack',async t=>{
 const f=await fixture(t);f.trace.scenarios[0].files=f.inventory.files.map(f=>f.path);await fs.writeFile(f.traceFile,JSON.stringify(f.trace));
 const a=await packageSysrootProfiles(f);assert.equal(a.manifest.profiles.extra.fileCount,0);
 const other=f.output+'2';await packageSysrootProfiles({...f,output:other});for(const name of await fs.readdir(f.output))assert.deepEqual(await fs.readFile(path.join(f.output,name)),await fs.readFile(path.join(other,name)));
});
test('selects direct delivery for cold bases and delta only for verified cheaper bases',()=>{
 const direct={bytes:25,sha256:'a'.repeat(64)},base={bytes:24,sha256:'b'.repeat(64)},delta={bytes:7,sha256:'c'.repeat(64),base};
 assert.deepEqual(selectSysrootDelivery({direct,delta}),{kind:'direct',bytes:25});
 assert.deepEqual(selectSysrootDelivery({direct,delta,cachedBaseSha256:[base.sha256]}),{kind:'delta',bytes:7,requiresBase:false});
 assert.equal(selectSysrootDelivery({direct,delta,cachedBaseSha256:['d'.repeat(64)]}).kind,'direct');
 assert.equal(selectSysrootDelivery({direct,delta:{...delta,bytes:30},cachedBaseSha256:[base.sha256]}).kind,'direct');
 assert.deepEqual(selectSysrootDelivery({direct:{...direct,bytes:40},delta}),{kind:'delta',bytes:31,requiresBase:true});
 assert.throws(()=>selectSysrootDelivery({direct:{...direct,bytes:Infinity},delta}),/Invalid/);
});
