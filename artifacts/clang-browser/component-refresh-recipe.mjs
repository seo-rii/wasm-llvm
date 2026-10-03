import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

process.umask(0o077);
// Run from the wasm-llvm checkout. Inputs are explicit; work is disposable and
// must be outside the producer artifacts. The source-built MemFS input contains
// memfs.wasm, memfs-build-receipt.json, LICENSE.llvm.txt and LICENSE.stb_sprintf.txt.
const root=path.resolve(process.env.WASM_LLVM_REPO_ROOT || process.cwd());
for(const key of ['CLANG_REFRESH_WORK_DIR','WASI_SDK_PATH','MEMFS_SOURCE_DIR'])assert(process.env[key],`Set ${key}`);
const cache=path.resolve(process.env.CLANG_REFRESH_WORK_DIR);
const sdk=path.resolve(process.env.WASI_SDK_PATH);
const sdkArchive=process.env.WASI_SDK_ARCHIVE || sdk+'.tar.gz';
const memfsSource=path.resolve(process.env.MEMFS_SOURCE_DIR);
const artifacts=path.join(root,'artifacts/clang-browser');
assert(!cache.startsWith(artifacts+path.sep)&&cache!==artifacts,'Work directory must be outside artifacts');
await fs.mkdir(cache,{recursive:true,mode:0o700});
const baseline=process.env.CLANG_REFRESH_BASELINE_DIR || path.join(cache,'baseline');
const work=path.join(cache,'work');
const output=path.join(cache,'output');
const producerDir=path.join(root,'producer/clang-browser');
const scriptDir=path.join(producerDir,'scripts');
const execute=promisify(execFile);
const run=async(command,args)=>{await execute(command,args,{maxBuffer:8*1024**2});};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=bytes=>({bytes:bytes.length,sha256:hash(bytes)});
const readJson=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const writeJson=async(file,data)=>fs.writeFile(file,JSON.stringify(data,null,2)+'\n');
const {ZipReader,Uint8ArrayReader,Uint8ArrayWriter,configure}=await import(path.join(root,'node_modules/@zip.js/zip.js/index.js'));
configure({useWebWorkers:false});
const {pruneSysrootHeaders,SYSROOT_C_PROBE,SYSROOT_CPP_PROBE,SYSROOT_CPP_STANDARDS}=await import(path.join(scriptDir,'sysroot-pruning.mjs'));
const {GCC_COMPATIBILITY_HEADERS}=await import(path.join(scriptDir,'gcc-compat.mjs'));
const {verifyMemfsModule}=await import(path.join(scriptDir,'build-memfs.mjs'));

async function unzip(file,name){
 const reader=new ZipReader(new Uint8ArrayReader(await fs.readFile(file)));
 try{const entries=(await reader.getEntries()).filter(e=>!e.directory);assert.equal(entries.length,1);assert.equal(entries[0].filename,name);return Buffer.from(await entries[0].getData(new Uint8ArrayWriter()));}finally{await reader.close();}
}
async function inventory(dir){
 const result=new Map();
 async function walk(relative=''){
  for(const entry of (await fs.readdir(path.join(dir,relative),{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:1)){
   const next=relative?relative+'/'+entry.name:entry.name;
   if(entry.isDirectory())await walk(next);else{assert(entry.isFile(),`Unexpected non-file ${next}`);result.set(next,await fs.readFile(path.join(dir,next)));}
  }
 }
 await walk();return result;
}
async function writeFile(relative,bytes,dir){const target=path.join(dir,relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);}
const manifestBytes=await fs.readFile(path.join(producerDir,'manifest.json'));
const manifest=JSON.parse(manifestBytes);
const initialSysrootSha='3948a257ad5fd3ed6ee26789ef2634ce28169f2e12fd60fc0682f6f30ad4be77';
try{await fs.access(baseline);}catch{
 const original=await readJson(path.join(artifacts,'toolchain.json'));
 assert.equal(original.assets['sysroot.tar.zip'],initialSysrootSha);
 await fs.mkdir(baseline,{recursive:true});
 for(const name of ['toolchain.json',...Object.keys(original.assets)])await writeFile(name,await fs.readFile(path.join(artifacts,name)),baseline);
}
const originalBytes=await fs.readFile(path.join(baseline,'toolchain.json'));
const original=JSON.parse(originalBytes);
assert.equal(original.assets['sysroot.tar.zip'],initialSysrootSha);
for(const [name,sha]of Object.entries(original.assets))assert.equal(hash(await fs.readFile(path.join(baseline,name))),sha,name);
assert.equal(hash(await fs.readFile(sdkArchive)),manifest.toolchains.wasiSdk.archives['x86_64-linux'],'pinned SDK archive');
console.log('Verified original asset snapshot and pinned SDK 33 archive.');
await fs.rm(work,{recursive:true,force:true});await fs.mkdir(work,{recursive:true});
await fs.rm(output,{recursive:true,force:true});
const archiveRoot=path.join(work,'sdk');await fs.mkdir(archiveRoot);
// Include all target headers so archive hard links can resolve in their original order.
await run('tar',['-xzf',sdkArchive,'-C',archiveRoot,'--wildcards',
 'wasi-sdk-33.0-x86_64-linux/share/wasi-sysroot/include/*',
 'wasi-sdk-33.0-x86_64-linux/lib/clang/22/include/*',
 'wasi-sdk-33.0-x86_64-linux/share/wasi-sysroot/lib/*/libc-printscan-long-double.a']);
const extracted=path.join(archiveRoot,'wasi-sdk-33.0-x86_64-linux');
const sourceInclude=path.join(extracted,'share/wasi-sysroot/include');
const candidate=path.join(work,'candidate');
await fs.mkdir(path.join(candidate,'include'),{recursive:true});
await fs.cp(path.join(sourceInclude,'wasm32-wasi'),path.join(candidate,'include/wasm32-wasi'),{
 recursive:true,dereference:true,filter:source=>!['eh','noeh'].includes(path.basename(source))
});
await fs.cp(path.join(sourceInclude,'wasm32-wasi/noeh/c++/v1'),path.join(candidate,'include/c++/v1'),{recursive:true,dereference:true});
await fs.cp(path.join(extracted,'lib/clang/22/include'),path.join(candidate,'lib/clang/22/include'),{recursive:true,dereference:true});
for(const header of GCC_COMPATIBILITY_HEADERS)await writeFile(header.path,Buffer.from(header.contents),candidate);
const originalTar=await unzip(path.join(baseline,'sysroot.tar.zip'),'sysroot.tar');
const originalRoot=path.join(work,'original');await fs.mkdir(originalRoot);
await fs.writeFile(path.join(work,'original.tar'),originalTar);
await run('tar',['-xf',path.join(work,'original.tar'),'-C',originalRoot]);
const oldFiles=await inventory(originalRoot);assert.equal(oldFiles.size,900);
// Use the exact shipped existing header bytes where present, adding only missing SDK files.
for(const [name,bytes]of oldFiles)if(name.startsWith('include/')||name.startsWith('lib/clang/22/include/'))await writeFile(name,bytes,candidate);
const probeDir=path.join(work,'probes');await fs.mkdir(probeDir);
const cProbe=path.join(probeDir,'probe.c'),cppProbe=path.join(probeDir,'probe.cpp');
await fs.writeFile(cProbe,SYSROOT_C_PROBE);await fs.writeFile(cppProbe,SYSROOT_CPP_PROBE);
const flags=dir=>['--target=wasm32-wasi',`--sysroot=${dir}`,'-resource-dir',path.join(dir,'lib/clang/22'),'-I',path.join(dir,'include')];
const cFlags=dir=>[...flags(dir),'-isystem',path.join(dir,'include/wasm32-wasi')];
const cppFlags=dir=>[...flags(dir),'-isystem',path.join(dir,'include/c++/v1'),'-isystem',path.join(dir,'include/wasm32-wasi')];
const cCompiler=path.join(sdk,'bin/clang'),cppCompiler=path.join(sdk,'bin/clang++');
await pruneSysrootHeaders({sysroot:candidate,resourceIncludeDir:path.join(candidate,'lib/clang/22/include'),probeDir,cCompiler,cppCompiler,cFlags:cFlags(candidate),cppFlags:cppFlags(candidate),cProbe,cppProbe,run});
const closure=await inventory(candidate);
const refreshed=path.join(work,'refreshed');await fs.cp(originalRoot,refreshed,{recursive:true});
const added=[];
for(const[name,bytes]of closure){
 if(oldFiles.has(name)){assert.deepEqual(bytes,oldFiles.get(name),name);continue;}
 await writeFile(name,bytes,refreshed);
 const archivePath=name.startsWith('include/c++/v1/')?'share/wasi-sysroot/include/wasm32-wasi/noeh/c++/v1/'+name.slice('include/c++/v1/'.length):name.startsWith('include/wasm32-wasi/')?'share/wasi-sysroot/'+name:name;
 assert.deepEqual(bytes,await fs.readFile(path.join(extracted,archivePath)),`SDK source ${name}`);
 added.push({path:name,...digest(bytes),sourcePath:'wasi-sdk-33.0-x86_64-linux/'+archivePath});
}
const longDoublePath='lib/wasm32-wasi/libc-printscan-long-double.a';
const longDouble=await fs.readFile(path.join(extracted,'share/wasi-sysroot',longDoublePath));
assert(!oldFiles.has(longDoublePath));await writeFile(longDoublePath,longDouble,refreshed);
added.push({path:longDoublePath,...digest(longDouble),sourcePath:'wasi-sdk-33.0-x86_64-linux/share/wasi-sysroot/'+longDoublePath});
added.sort((a,b)=>a.path<b.path?-1:1);
for(const standard of SYSROOT_CPP_STANDARDS){
 const object=path.join(probeDir,standard+'.o');await run(cppCompiler,[...cppFlags(refreshed),'-std='+standard,'-c',cppProbe,'-o',object]);
 assert.deepEqual((await fs.readFile(object)).subarray(0,4),Buffer.from([0,97,115,109]));
}
console.log(`Preserved ${oldFiles.size} existing files; added ${added.length} receipt-bound SDK files. All 8 C++ modes compile.`);
const source=path.join(probeDir,'long-double.cpp');
await fs.writeFile(source,'#include <cstdio>\n#include <iostream>\n#include <cfloat>\nstatic_assert(sizeof(long double)==16 && LDBL_MANT_DIG==113);\nint main(){long double x=0; if(sscanf("2.5","%Lf",&x)!=1)return 1; printf("format=%.3Lf scan=%.3Lf\\n",1.25L,x); std::cout<<"iostream="<<x<<"\\n";}\n');
const guest=path.join(probeDir,'long-double.wasm');
await run(cppCompiler,[...cppFlags(refreshed),'-std=gnu++26',source,'-lc-printscan-long-double','-o',guest]);
const {WASI}=await import('node:wasi');
const stdout=await fs.open(path.join(probeDir,'stdout'),'w'),stderr=await fs.open(path.join(probeDir,'stderr'),'w');
try{const wasi=new WASI({version:'preview1',args:['long-double'],env:{},preopens:{},returnOnExit:true,stdout:stdout.fd,stderr:stderr.fd});const instance=await WebAssembly.instantiate(await WebAssembly.compile(await fs.readFile(guest)),wasi.getImportObject());assert.equal(wasi.start(instance),0);}finally{await stdout.close();await stderr.close();}
const expectedOutput='format=1.250 scan=2.500\niostream=2.5\n';
assert.equal(await fs.readFile(path.join(probeDir,'stdout'),'utf8'),expectedOutput);assert.equal(await fs.readFile(path.join(probeDir,'stderr'),'utf8'),'');
const memfsWasm=await fs.readFile(path.join(memfsSource,'memfs.wasm'));
await verifyMemfsModule(memfsWasm);
await run(process.execPath,[path.join(scriptDir,'package-toolchain.mjs'),
 '--clang-wasm',path.join(baseline,'clang.zip'),'--lld-wasm',path.join(baseline,'lld.zip'),
 '--sysroot',refreshed,'--memfs-wasm',path.join(memfsSource,'memfs.wasm'),'--memfs-receipt',path.join(memfsSource,'memfs-build-receipt.json'),
 '--clangd-js',path.join(baseline,'clangd/clangd.js'),'--clangd-wasm',path.join(baseline,'clangd/clangd.wasm.gz'),
 '--target-dir',output,'--llvm-version',original.llvmVersion,'--llvm-commit',original.llvmCommit,'--wasi-sdk-version',original.wasiSdkVersion,
 '--emsdk-version',original.emsdkVersion,'--resource-dir',original.resourceDir,'--compiler-runtime-lib-dir',original.compilerRuntimeLibDir]);
const packaged=await readJson(path.join(output,'toolchain.json'));
const preservedNames=['clang.zip','lld.zip','clangd/clangd.js','clangd/clangd.wasm.gz'];
const preservedAssets={};
for(const name of preservedNames){const bytes=await fs.readFile(path.join(baseline,name));await writeFile(name,bytes,output);preservedAssets[name]=digest(bytes);}
const refreshedFiles=await inventory(refreshed);
for(const[name,bytes]of oldFiles)assert.deepEqual(refreshedFiles.get(name),bytes,`Preserved ${name}`);
const scripts={};
for(const name of ['sysroot-pruning.mjs','gcc-compat.mjs','package-toolchain.mjs','memfs-provenance.mjs'])scripts['producer/clang-browser/scripts/'+name]=digest(await fs.readFile(path.join(scriptDir,name)));
const toolchain={...original,assets:{...original.assets,'sysroot.tar.zip':packaged.assets['sysroot.tar.zip'],'memfs.zip':packaged.assets['memfs.zip']},memfs:packaged.memfs,
 componentDerivation:{format:'wasm-llvm-clang-component-refresh-v1',compilerRebuilt:false,
  description:'Preserves all prior Clang/LLD/clangd artifact bytes and all prior sysroot files; adds the SDK 33 conditional header closure and long-double archive, and replaces MemFS with the separately source-built 8192-node module.',
  originalToolchain:{...digest(originalBytes),metadata:original},preservedAssets,
  source:{sdkVersion:'33',sdkArchive:{name:path.basename(sdkArchive),sha256:manifest.toolchains.wasiSdk.archives['x86_64-linux']},producerManifestSha256:hash(manifestBytes),scripts},
  regeneration:{helper:'artifacts/clang-browser/component-refresh-recipe.mjs',...digest(await fs.readFile(fileURLToPath(import.meta.url))),
   helperSource:await fs.readFile(fileURLToPath(import.meta.url),'utf8'),
   argv:['node','artifacts/clang-browser/component-refresh-recipe.mjs'],
   environment:{WASM_LLVM_REPO_ROOT:'<wasm-llvm checkout>',CLANG_REFRESH_WORK_DIR:'<task-owned work directory outside artifacts>',WASI_SDK_PATH:'<extracted pinned WASI SDK 33>',WASI_SDK_ARCHIVE:'<pinned wasi-sdk-33.0-x86_64-linux.tar.gz>',MEMFS_SOURCE_DIR:'<source-built MemFS output with raw module, receipt and licenses>',CLANG_REFRESH_BASELINE_DIR:'<original artifact snapshot from baseRevision>'},
   baseRevision:'36e14dd531483a0f2b8c63b85713fec2cd4ab93e',baselinePath:'artifacts/clang-browser',publishOption:'--publish'},
  sysroot:{originalZipSha256:original.assets['sysroot.tar.zip'],originalTar:digest(originalTar),originalFileCount:oldFiles.size,retainedOriginalFileCount:oldFiles.size,
   addedFiles:added,outputFileCount:refreshedFiles.size,outputZipSha256:packaged.assets['sysroot.tar.zip'],outputTar:digest(await unzip(path.join(output,'sysroot.tar.zip'),'sysroot.tar'))},
  memfs:{outputZipSha256:packaged.assets['memfs.zip'],buildReceiptSha256:packaged.memfs.files['memfs-build-receipt.json'].sha256},
  validation:{cppCodeGeneration:SYSROOT_CPP_STANDARDS,longDouble:{standard:'gnu++26',abi:'binary128',expectedOutput},memfs:{maxNodes:8192,usableFileNodes:8188},preservedBytes:true}
 }};
await writeJson(path.join(output,'toolchain.json'),toolchain);
await fs.copyFile(fileURLToPath(import.meta.url),path.join(output,'component-refresh-recipe.mjs'));
for(const name of preservedNames)assert.deepEqual(await fs.readFile(path.join(artifacts,name)),await fs.readFile(path.join(baseline,name)),name);
const changed=['sysroot.tar.zip','memfs.zip','toolchain.json','memfs-build-receipt.json','LICENSE.memfs-llvm.txt','LICENSE.memfs-stb_sprintf.txt','component-refresh-recipe.mjs'];
if(process.argv.includes('--publish'))for(const name of changed)await fs.copyFile(path.join(output,name),path.join(artifacts,name));
const report={changed:changed.map(name=>({path:'artifacts/clang-browser/'+name,...(name==='toolchain.json'?{}:{sha256:toolchain.assets[name]??toolchain.memfs.files[name]?.sha256})})),preservedAssets,addedFiles:added.length,outputFiles:refreshedFiles.size,published:process.argv.includes('--publish')};
await writeJson(path.join(cache,'report.json'),report);console.log(JSON.stringify(report,null,2));
