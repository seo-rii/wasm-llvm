#!/usr/bin/env node
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
const MAX_BYTES = 128 * 1024 * 1024;
const sha = data => createHash('sha256').update(data).digest('hex');
const sort = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const targets = new Set(['wasm32-wasip1','wasm32-wasip2','wasm32-wasip3']);
function inside(root, destination) {
 const relative=path.relative(root,destination);
 return relative==='' || (relative!=='..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
async function resolveNewOutput(output) {
 const absolute=path.resolve(output),suffix=[path.basename(absolute)];
 let parent=path.dirname(absolute);
 for(;;){
  let exists=false;
  try{await fs.lstat(parent);exists=true}catch(error){if(error.code!=='ENOENT')throw error}
  if(exists)return path.resolve(await fs.realpath(parent),...suffix.reverse());
  const next=path.dirname(parent);
  if(next===parent)throw new Error('Output parent is unavailable');
  suffix.push(path.basename(parent));parent=next;
 }
}
function safe(name) {
 if (typeof name!=='string' || !name || name.startsWith('/') || /[\\:\x00-\x1f\x7f]/.test(name) || name.split('/').some(p=>!p || p==='.' || p==='..')) throw new Error('Unsafe sysroot path');
 return name;
}
function hashValue(value) { if (typeof value!=='string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid SHA-256'); return value; }
export async function inventorySysroot(sysroot, target) {
 if (!targets.has(target)) throw new Error('Unsupported WASI target');
 const root=path.resolve(sysroot); if (!(await fs.lstat(root)).isDirectory()) throw new Error('Expected a real sysroot directory');
 const entries=[]; let total=0;
 async function walk(prefix) {
  for(const entry of (await fs.readdir(path.join(root,prefix),{withFileTypes:true})).sort((a,b)=>sort(a.name,b.name))) {
   const name=safe(prefix?`${prefix}/${entry.name}`:entry.name);
   if(entry.isDirectory()){await walk(name);continue}
   if(!entry.isFile())throw new Error('Non-regular sysroot entry');
   const handle=await fs.open(path.join(root,name),constants.O_RDONLY|constants.O_NOFOLLOW);
   try{
    const stat=await handle.stat();if(!stat.isFile() || stat.size>MAX_BYTES-total || entries.length>=10000)throw new Error('Sysroot budget exceeded');
    const bytes=await handle.readFile();total+=bytes.length;if(total>MAX_BYTES)throw new Error('Sysroot budget exceeded');
    entries.push({path:name,bytes,sha256:sha(bytes)});
   }finally{await handle.close()}
  }
 }
 await walk(''); if(!entries.length)throw new Error('Empty sysroot');
 const files=entries.map(e=>({path:e.path,bytes:e.bytes.length,sha256:e.sha256}));
 return {entries,files,inventorySha256:sha(JSON.stringify({target,files}))};
}
export function validateSysrootTrace(trace, inventory, target, compilerManifestSha256) {
 if(trace?.format!=='wasm-rust-sysroot-trace-v1' || trace.target!==target || trace.compilerManifestSha256!==hashValue(compilerManifestSha256) || trace.inventorySha256!==inventory.inventorySha256)throw new Error('Trace does not match compiler/target/sysroot inventory');
 if(!Array.isArray(trace.scenarios) || !trace.scenarios.length || trace.scenarios.length>1000)throw new Error('Expected successful trace scenarios');
 const known=new Set(inventory.files.map(e=>e.path)),selected=new Set(),names=new Set();
 for(const scenario of trace.scenarios){
  if(typeof scenario.name!=='string' || !scenario.name || names.has(scenario.name) || scenario.exitCode!==0 || !Array.isArray(scenario.files) || !scenario.files.length || scenario.files.length>10000)throw new Error('Invalid or failed trace scenario');
  names.add(scenario.name);hashValue(scenario.sourceSha256);
  for(const file of scenario.files){safe(file);if(!known.has(file))throw new Error(`Trace references absent file ${file}`);selected.add(file)}
 }
 return selected;
}
function pack(entries,target){
 let offset=0;
 const index={format:'wasm-rust-runtime-pack-index-v1',fileCount:entries.length,totalBytes:entries.reduce((n,e)=>n+e.bytes.length,0),entries:entries.map(e=>{const item={runtimePath:`/lib/rustlib/${target}/lib/${e.path}`,offset,length:e.bytes.length};offset+=e.bytes.length;return item})};
 return {bytes:Buffer.concat(entries.map(e=>e.bytes)),index};
}
async function emitPack(dir,name,entries,target){
 const data=pack(entries,target),rawIndex=Buffer.from(JSON.stringify(data.index,null,2)+'\n');
 const result={asset:name+'.pack.gz',index:name+'.index.json.gz',fileCount:entries.length,totalBytes:data.bytes.length,receipts:{}};
 for(const [filename,logical]of [[result.asset,data.bytes],[result.index,rawIndex]]){
  const bytes=gzipSync(logical,{level:9,mtime:0});await fs.writeFile(path.join(dir,filename),bytes);
  result.receipts[filename]={bytes:bytes.length,sha256:sha(bytes),uncompressedBytes:logical.length,uncompressedSha256:sha(logical)};
 }
 return result;
}
/** This estimates compressed transfer only, never a logical-memory or CPU budget. */
export function selectSysrootDelivery({direct,delta,cachedBaseSha256=[]}){
 const size=entry=>{hashValue(entry.sha256);if(!Number.isSafeInteger(entry.bytes)||entry.bytes<0)throw new Error('Invalid delivery byte count');return entry.bytes};
 const directBytes=size(direct);if(!delta)return {kind:'direct',bytes:directBytes};
 const deltaBytes=size(delta),baseBytes=size(delta.base);
 const cached=new Set(cachedBaseSha256.map(hashValue)).has(delta.base.sha256);
 const cost=deltaBytes+(cached?0:baseBytes);if(!Number.isSafeInteger(cost))throw new Error('Invalid combined delivery byte count');
 return cost<directBytes?{kind:'delta',bytes:cost,requiresBase:!cached}:{kind:'direct',bytes:directBytes};
}
export async function packageSysrootProfiles({sysroot,target,compilerManifest,traceFile,output}){
 const root=path.resolve(sysroot),realRoot=await fs.realpath(root),candidate=await resolveNewOutput(output);
 if(inside(realRoot,candidate))throw new Error('Output must be outside input');
 const compilerBytes=await fs.readFile(compilerManifest);JSON.parse(compilerBytes);
 const compilerManifestSha256=sha(compilerBytes),inventory=await inventorySysroot(root,target);
 const traceBytes=await fs.readFile(traceFile),trace=JSON.parse(traceBytes);
 const selected=validateSysrootTrace(trace,inventory,target,compilerManifestSha256);
 const hot=inventory.entries.filter(e=>selected.has(e.path)),extra=inventory.entries.filter(e=>!selected.has(e.path));
 await fs.mkdir(path.dirname(candidate),{recursive:true});
 const out=path.join(await fs.realpath(path.dirname(candidate)),path.basename(candidate));
 if(inside(realRoot,out))throw new Error('Output must be outside input');
 const temp=await fs.mkdtemp(out+'.tmp-');
 try{
  const manifest={format:'wasm-rust-sysroot-profiles-v1',target,compilerManifestSha256,inventorySha256:inventory.inventorySha256,traceSha256:sha(traceBytes),coverage:trace.scenarios.map(s=>({name:s.name,sourceSha256:s.sourceSha256})),promotion:'requires-real-compiler-probe',files:inventory.files,profiles:{}};
  // Always retain a direct full target pack. Cold P2/P3 need not fetch a P1 base.
  for(const[name,entries]of [['full',inventory.entries],['hot',hot],['extra',extra]])manifest.profiles[name]=await emitPack(temp,name,entries,target);
  const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await fs.writeFile(path.join(temp,'sysroot-profiles.v1.json'),bytes);
  try{await fs.mkdir(out,{mode:0o700})}catch(error){if(error.code==='EEXIST')throw new Error('Output already exists');throw error}
  // The exclusive directory reservation cannot replace another producer's output.
  // Publish the manifest last so incomplete directories are never promoted.
  for(const name of await fs.readdir(temp)){
   if(name!=='sysroot-profiles.v1.json')await fs.copyFile(path.join(temp,name),path.join(out,name),constants.COPYFILE_EXCL);
  }
  await fs.copyFile(path.join(temp,'sysroot-profiles.v1.json'),path.join(out,'sysroot-profiles.v1.json'),constants.COPYFILE_EXCL);
  return {manifest,manifestSha256:sha(bytes)};
 }finally{await fs.rm(temp,{recursive:true,force:true})}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);
 try{
  if(args.length===4&&args[0]==='--inventory'&&args[2]==='--target'){
   const {files,inventorySha256}=await inventorySysroot(args[1],args[3]);console.log(JSON.stringify({target:args[3],files,inventorySha256},null,2));
  }else if(args.length===10&&args[0]==='--sysroot'&&args[2]==='--target'&&args[4]==='--compiler-manifest'&&args[6]==='--trace'&&args[8]==='--output'){
   console.log(JSON.stringify(await packageSysrootProfiles({sysroot:args[1],target:args[3],compilerManifest:args[5],traceFile:args[7],output:args[9]}),null,2));
  }else throw new Error('Usage: --inventory DIR --target TARGET; or --sysroot DIR --target TARGET --compiler-manifest FILE --trace FILE --output NEW_DIR');
 }catch(error){console.error(error.message);process.exitCode=1}
}
