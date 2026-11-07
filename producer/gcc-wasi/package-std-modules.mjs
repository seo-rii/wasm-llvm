#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {gzipSync,brotliCompressSync,constants} from 'node:zlib';
import {stdModulesProfile,moduleAssets,moduleNames} from './std-modules-profile.mjs';
import {stdModuleCases,moduleDiagnostics} from './std-modules-fixtures.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const id=b=>({bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});
const json=v=>Buffer.from(JSON.stringify(v,null,2)+'\n');
const content=a=>({bytes:a.bytes,sha256:a.sha256});
const safe=name=>typeof name==='string'&&name&&!name.startsWith('/')&&!/[\\\x00-\x1f\x7f]/.test(name)&&!name.split('/').some(p=>!p||p==='.'||p==='..');

export function stdModulesManifest(base,report,assets) {
  assert.equal(base.schemaVersion,2);assert.equal(base.kind,'gcc-wasm32-wasi');assert.equal(base.host,'wasm32-emscripten');assert.equal(base.target,'wasm32-wasi');assert.equal(base.abi,'wasm32-wasi-preview1');assert.equal(base.capabilities?.libstdcxx,true);assert(!base.stdModules&&!base.capabilities.stdModules,'Base already contains modules');
  assert.equal(report.kind,'gcc-wasi-std-modules-qualification');assert.equal(report.status,'passed');assert.equal(report.inputsUnchanged,true);assert.deepEqual(report.profile,stdModulesProfile);assert.equal(report.target,base.target);assert.equal(report.abi,base.abi);assert.equal(report.compilerTarget,'wasm32-unknown-wasi');
  assert.deepEqual(report.bindings,{gccSource:base.provenance.gccSource,cc1plusJs:content(base.assets.cc1plusJs),cc1plusWasm:content(base.assets.cc1plusWasm),sysroot:content(base.assets.sysroot)});
  assert.deepEqual(report.hosts.map(h=>[h.host,h.compilerHost,h.status]),[['native','x86_64-pc-linux-gnu','passed'],['wasm','wasm32-unknown-emscripten','passed']]);
  for(const host of report.hosts){assert.deepEqual(host.modules.map(m=>m.name),moduleNames);assert.deepEqual(host.cases.map(c=>c.id),stdModuleCases.map(c=>c.id));assert.deepEqual(host.diagnostics.map(d=>d.id),[...moduleDiagnostics.map(d=>d.id),...(host.host==='wasm'?['wrong-host']:[])]);}
  const wasm=report.hosts[1];
  assert.deepEqual(Object.keys(assets).sort(),Object.keys(moduleAssets).sort());
  for(const host of report.hosts)for(const [i,m]of host.modules.entries())assert.deepEqual(m.requires,i?['std']:[]);
  for(const[key,filename]of Object.entries(moduleAssets)){assert.equal(assets[key].path,filename);assert(Number.isSafeInteger(assets[key].bytes)&&assets[key].bytes>0&&/^[0-9a-f]{64}$/.test(assets[key].sha256),'Invalid optional asset');}
  assert.deepEqual(content(assets.std),wasm.modules[0].bmi);assert.deepEqual(content(assets.stdCompat),wasm.modules[1].bmi);assert.deepEqual(content(assets.initializers),wasm.archive);assert.deepEqual(content(assets.signal),report.signalArchive);
  const descriptor={schemaVersion:1,kind:'gnu-libstdcxx-std-modules',compilerHost:'wasm32-unknown-emscripten',target:base.target,abi:base.abi,bindings:report.bindings,profile:stdModulesProfile,interfaces:report.interfaces,modules:wasm.modules.map((m,i)=>({name:m.name,requires:m.requires,bmi:i?assets.stdCompat:assets.std})),initializerArchive:{asset:assets.initializers,members:wasm.modules.map(m=>({name:m.name+'.o',...m.object}))},signalArchive:assets.signal,qualification:{status:'unverified'}};
  return {...base,capabilities:{...base.capabilities,stdModules:true},stdModules:descriptor,
    limitations:[...(base.limitations??[]).map(s=>s.includes('C++26 debugger functions and prebuilt std modules are unavailable')?'GNU libstdc++ C++26 debugger functions remain unavailable in this base runtime.':s),
      'std/std.compat require explicit opt-in, gnu++23/O2, private scalar memory, disabled C++ exceptions/RTTI, and the exact compiler/host/sysroot/ABI profile. Actual target EH is enabled to parse original GNU interfaces; it does not implement setjmp/longjmp, which remain unsupported link errors. Signal emulation uses the pinned real WASI archive.'],qualification:{status:'unverified'}};
}

export async function packageStdModules({bundle,modules,work,sdk,output}) {
  const read=async file=>fs.readFile(file);
  const baseBytes=await read(path.join(bundle,'gcc-toolchain.v2.json')),base=JSON.parse(baseBytes),receiptBytes=await read(path.join(modules,'qualification.json')),report=JSON.parse(receiptBytes);
  assert.deepEqual(id(baseBytes),report.baseManifest,'Qualified base manifest changed');
  const payloads=new Map();
  for(const[key,name]of Object.entries(moduleAssets)){const file=path.join(modules,key==='signal'?'libwasi-emulated-signal.a':'wasm/'+path.basename(name));payloads.set(name,await read(file));}
  const assets=Object.fromEntries(Object.entries(moduleAssets).map(([key,name])=>[key,{path:name,...id(payloads.get(name))}]));
  const manifest=stdModulesManifest(base,report,assets);
  for(const input of report.inputs){assert(path.isAbsolute(input.path));assert.deepEqual(id(await read(input.path)),content(input),'Changed qualified input: '+input.path);}
  for(const name of ['build-std-modules.mjs','std-modules-profile.mjs','std-modules-fixtures.mjs']){const file=path.join(here,name),expected=report.inputs.find(input=>input.path===file);assert(expected,'Missing producer recipe pin: '+name);assert.deepEqual(id(await read(file)),content(expected));}
  const assembler=path.join(work,'wabt-native/wat2wasm'),archiver=path.join(sdk,'bin/llvm-ar');assert.deepEqual(id(await read(assembler)),report.tools.assembler);assert.deepEqual(id(await read(archiver)),report.tools.archiver);
  const verifyFile=async(file,expected)=>assert.deepEqual(id(await read(file)),content(expected),'Qualified artifact changed: '+file);
  function archiveCommand(argv){const result=spawnSync(archiver,argv,{timeout:120000,maxBuffer:8*1024*1024});assert.equal(result.status,0,String(result.stderr));assert.equal(result.signal,null);assert(!result.error);return result.stdout;}
  for(const host of report.hosts){
    const directory=path.join(modules,host.host),archive=path.join(directory,'libstdc++modules.a');
    await verifyFile(archive,host.archive);assert.deepEqual(archiveCommand(['t',archive]).toString().trim().split('\n'),['std.o','std.compat.o']);
    for(const [index,module]of host.modules.entries()){
      assert.deepEqual(module.requires,index?['std']:[]);assert.deepEqual(module.interface,index?report.interfaces.stdCompat:report.interfaces.std);assert.equal(module.exitCode,0);assert.equal(module.assemble.exitCode,0);
      for(const[kind,ext]of [['bmi','.gcm'],['assembly','.wat'],['object','.o']])await verifyFile(path.join(directory,module.name+ext),module[kind]);
      assert.deepEqual(id(archiveCommand(['p',archive,module.name+'.o'])),module.object,'Archive initializer member differs');
      const object=new WebAssembly.Module(await read(path.join(directory,module.name+'.o')));assert.equal(WebAssembly.Module.customSections(object,'linking').length,1);
    }
    for(const[caseIndex,test]of host.cases.entries()){
      const fixture=stdModuleCases[caseIndex],directory=path.join(modules,host.host,'cases',test.id);assert.equal(test.stdin,fixture.stdin);assert.equal(test.stdout,fixture.stdout);assert.equal(test.stderr,'');assert.equal(test.link.exitCode,0);assert.equal(test.execution.exitCode,0);
      assert.equal(await fs.readFile(path.join(directory,'input.txt'),'utf8'),fixture.stdin);assert.equal(await fs.readFile(path.join(directory,'output.txt'),'utf8'),fixture.stdout);assert.equal(await fs.readFile(path.join(directory,'error.txt'),'utf8'),'');await verifyFile(path.join(directory,'program.wasm'),test.program);
      assert.deepEqual(test.units.map(u=>u.name),Object.keys(fixture.sources));
      for(const unit of test.units){const unitRoot=path.join(directory,unit.name);assert.equal(unit.exitCode,0);assert.equal(unit.assemble.exitCode,0);assert.deepEqual(unit.source,id(Buffer.from(fixture.sources[unit.name])));for(const[kind,name]of [['source','input.cpp'],['assembly','output.wat'],['object','output.o']])await verifyFile(path.join(unitRoot,name),unit[kind]);}
      if(test.id==='module-initializers'){assert.equal(test.missingInitializer.exitCode,1);assert.match(test.missingInitializer.stderr,/undefined symbol: initializer for module std/);}
    }
    assert.equal(host.unsupportedSetjmp.compile.exitCode,0);assert.equal(host.unsupportedSetjmp.link.exitCode,1);assert.match(host.unsupportedSetjmp.link.stderr,/undefined symbol: setjmp/);assert.match(host.unsupportedSetjmp.link.stderr,/undefined symbol: longjmp/);
    for(const diagnostic of host.diagnostics){assert.equal(diagnostic.exitCode,1);await verifyFile(path.join(directory,'diagnostics',diagnostic.id,'diagnostics.txt'),diagnostic.diagnostics);}
  }
  const baseCopies=[];
  for(const asset of Object.values(base.assets)){assert(safe(asset.path));const bytes=await read(path.join(bundle,asset.path));assert.deepEqual(id(bytes),content(asset));baseCopies.push(asset);}
  for(const[name,asset]of Object.entries(base.provenance.files)){assert(safe(name)&&safe(asset.path)&&asset.path.startsWith('provenance/'));await verifyFile(path.join(bundle,asset.path),asset);baseCopies.push(asset);}
  const proofs=new Map([['std-modules-qualification.json',receiptBytes]]);
  for(const name of ['build-std-modules.mjs','package-std-modules.mjs','std-modules-profile.mjs','std-modules-fixtures.mjs'])proofs.set(name,await read(path.join(here,name)));
  for(const name of ['std.cc.in','std.compat.cc.in','std-clib.cc.in']){const input=report.inputs.find(item=>item.path.endsWith('/libstdc++-v3/src/c++23/'+name));assert(input,'Missing official interface input');const bytes=await read(input.path);assert.deepEqual(id(bytes),report.interfaces.sources[name]);proofs.set('std-modules-'+name,bytes);}
  manifest.provenance={...base.provenance,files:{...base.provenance.files}};
  for(const[name,bytes]of proofs){assert(!manifest.provenance.files[name],'Provenance collision');manifest.provenance.files[name]={path:'provenance/'+name,...id(bytes)};}
  const sizes=([name,bytes])=>({path:name,...id(bytes),gzipBytes:gzipSync(bytes,{level:9}).length,brotliBytes:brotliCompressSync(bytes,{params:{[constants.BROTLI_PARAM_QUALITY]:6}}).length});
  const metadata=json(manifest),initial=await Promise.all(Object.values(base.assets).map(async a=>sizes([a.path,await read(path.join(bundle,a.path))])));initial.push(sizes(['gcc-toolchain.v2.json',metadata]));
  const optional=[...payloads].map(sizes),sum=files=>({totalBytes:files.reduce((n,f)=>n+f.bytes,0),totalGzipBytes:files.reduce((n,f)=>n+f.gzipBytes,0),totalBrotliBytes:files.reduce((n,f)=>n+f.brotliBytes,0)});
  const loading={scope:'Initial manifest and unchanged tool/sysroot assets; std module assets load only after explicit opt-in. SDK Worker measurements are recorded by browser qualification.',gzipLevel:9,brotliQuality:6,assets:initial,...sum(initial),optionalStdModules:{assets:optional,...sum(optional)},baseManifest:report.baseManifest,initialManifestAddedBytes:metadata.length-baseBytes.length};
  await fs.mkdir(output,{recursive:false});
  for(const asset of baseCopies){const destination=path.join(output,asset.path);await fs.mkdir(path.dirname(destination),{recursive:true});const bytes=await read(path.join(bundle,asset.path));assert.deepEqual(id(bytes),content(asset));await fs.writeFile(destination,bytes,{flag:'wx'});}
  await fs.cp(path.join(bundle,'licenses'),path.join(output,'licenses'),{recursive:true,errorOnExist:true,force:false});
  for(const[name,bytes]of payloads){await fs.mkdir(path.dirname(path.join(output,name)),{recursive:true});await fs.writeFile(path.join(output,name),bytes,{flag:'wx'});}
  for(const[name,bytes]of proofs)await fs.writeFile(path.join(output,'provenance',name),bytes,{flag:'wx'});
  await fs.writeFile(path.join(output,'gcc-toolchain.v2.json'),metadata,{flag:'wx'});await fs.writeFile(path.join(output,'gcc-toolchain.base.v2.json'),baseBytes,{flag:'wx'});await fs.writeFile(path.join(output,'loading-sizes.json'),json(loading),{flag:'wx'});
  return{status:'packaged-unverified',output,manifest:id(metadata),optionalStdModules:loading.optionalStdModules};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const options={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i].replace(/^--/,'');assert(['bundle','modules','work','sdk','output'].includes(key)&&process.argv[i+1]&&!options[key],'Usage: package-std-modules.mjs --bundle DIR --modules DIR --work DIR --sdk DIR --output NEW_DIR');options[key]=path.resolve(process.argv[i+1]);}
  for(const key of ['bundle','modules','work','sdk','output'])assert(options[key],'Missing --'+key);console.log(json(await packageStdModules(options)).toString());
}
