import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {packageLanguageSysroots,deterministicTar,isCppSysrootPath} from '../producer/clang-browser/scripts/package-language-sysroots.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t) {
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'c-profile-')); t.after(()=>fs.rm(temp,{recursive:true,force:true}));
 const sysroot=path.join(temp,'root'),toolchainReceipt=path.join(temp,'toolchain.json');
 const files={ 'include/stdio.h':'stdio', 'include/wasm32-wasi/bits/alltypes.h':'types', 'lib/wasm32-wasi/libc.a':'libc', 'lib/wasm32-wasi/crt1.o':'crt', 'lib/clang/22/lib/wasi/libclang_rt.builtins-wasm32.a':'builtins','include/c++/v1/vector':'vector','lib/wasm32-wasi/libc++.a':'cxx','lib/wasm32-wasi/libc++abi.a':'abi','lib/wasm32-wasi/libunwind.a':'unwind','lib/clang/22/include/stddef.h':'resource' };
 for(const [name,data]of Object.entries(files)){await fs.mkdir(path.dirname(path.join(sysroot,name)),{recursive:true});await fs.writeFile(path.join(sysroot,name),data)}
 await fs.writeFile(toolchainReceipt,JSON.stringify({llvmVersion:'22.1.8',llvmCommit:'a'.repeat(40)}));
 return {temp,sysroot,toolchainReceipt,files,output:path.join(temp,'out')};
}
test('partitions the complete sysroot without changing file bytes',async t=>{
 const f=await fixture(t);const{manifest}=await packageLanguageSysroots(f);
 const seen=[];
 for(const[name,receipt]of Object.entries(manifest.assets)){
  const bytes=await fs.readFile(path.join(f.output,name));assert.equal(hash(bytes),receipt.sha256);assert.equal(bytes.length,receipt.bytes);
  const tar=gunzipSync(bytes);assert.equal(hash(tar),receipt.uncompressedSha256);assert.equal(tar.length,receipt.uncompressedBytes);
  const list=execFileSync('tar',['-tzf',path.join(f.output,name)],{encoding:'utf8'}).trim().split('\n');assert.deepEqual(list,receipt.files.map(e=>e.path));seen.push(...list);
  const extract=path.join(f.temp,name);await fs.mkdir(extract);execFileSync('tar',['-xzf',path.join(f.output,name),'-C',extract]);
  for(const file of receipt.files)assert.equal(await fs.readFile(path.join(extract,file.path),'utf8'),f.files[file.path]);
 }
 assert.deepEqual(seen.sort(),Object.keys(f.files).sort());assert.equal(new Set(seen).size,seen.length);
 const core=manifest.assets['c-sysroot.tar.gz'].files.map(f=>f.path);assert(!core.some(isCppSysrootPath));assert(core.some(p=>p.endsWith('/libunwind.a')));assert(core.some(p=>p.endsWith('/stddef.h')));
});
test('is byte reproducible independent of source mtimes and file modes',async t=>{
 const f=await fixture(t);await packageLanguageSysroots(f);await fs.utimes(path.join(f.sysroot,'include/stdio.h'),500,500);await fs.chmod(path.join(f.sysroot,'include/stdio.h'),0o700);
 const second=f.output+'2';await packageLanguageSysroots({...f,output:second});for(const name of await fs.readdir(f.output))assert.deepEqual(await fs.readFile(path.join(f.output,name)),await fs.readFile(path.join(second,name)));
});
test('rejects symlinks, missing C inputs, and output inside input',async t=>{
 const f=await fixture(t);await fs.symlink('/etc/passwd',path.join(f.sysroot,'include/leak'));await assert.rejects(packageLanguageSysroots(f),/Non-regular/);await fs.unlink(path.join(f.sysroot,'include/leak'));
 await assert.rejects(packageLanguageSysroots({...f,output:path.join(f.sysroot,'out')}),/outside/);
 await fs.unlink(path.join(f.sysroot,'include/stdio.h'));await assert.rejects(packageLanguageSysroots(f),/Missing required/);
});
test('does not overwrite an existing output',async t=>{const f=await fixture(t);await fs.mkdir(f.output);await fs.writeFile(path.join(f.output,'keep'),'keep');await assert.rejects(packageLanguageSysroots(f),/already exists/);assert.equal(await fs.readFile(path.join(f.output,'keep'),'utf8'),'keep')});
test('rejects invalid provenance',async t=>{const f=await fixture(t);await fs.writeFile(f.toolchainReceipt,'{}');await assert.rejects(packageLanguageSysroots(f),/LLVM revision/)});
test('USTAR encodes prefix paths and rejects traversal/control names',()=>{
 const tar=deterministicTar([{path:'include/'+('long/'.repeat(24))+'header.h',bytes:Buffer.from('x')}]);assert.equal(tar.length%512,0);
 for(const name of ['../x','/x','x/../y','x\\y','x\0y'])assert.throws(()=>deterministicTar([{path:name,bytes:Buffer.alloc(0)}]),/Unsafe/);
});
