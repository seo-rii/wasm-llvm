#!/usr/bin/env node
// Actual native GCC/WASI qualification precedes production with the Wasm host.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readTarEntries} from '../../scripts/lib/tar.mjs';
import {moduleNames,moduleCompilerArguments,stdModulesProfile,mapperText} from './std-modules-profile.mjs';
import {stdModuleCases,moduleDiagnostics,unsupportedSetjmp} from './std-modules-fixtures.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const identity=bytes=>({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
const json=value=>JSON.stringify(value,null,2)+'\n';
const content=asset=>({bytes:asset.bytes,sha256:asset.sha256});

export async function buildStdModules({bundle,work,sdk,output}) {
  for(const value of [bundle,work,sdk,output])assert(path.isAbsolute(value),'Use absolute input/output paths');
  assert(![bundle,work,sdk].some(root=>output===root||root.startsWith(output+path.sep)),'Output contains an input');
  await fs.mkdir(output,{recursive:false});
  const frozen=new Map();
  async function freeze(file){const bytes=await fs.readFile(file);const receipt=identity(bytes);if(frozen.has(file))assert.deepEqual(receipt,frozen.get(file),'Changed input: '+file);else frozen.set(file,receipt);return bytes;}
  const manifestBytes=await freeze(path.join(bundle,'gcc-toolchain.v2.json')),manifest=JSON.parse(manifestBytes);
  assert.equal(manifest.schemaVersion,2);assert.equal(manifest.host,'wasm32-emscripten');assert.equal(manifest.target,'wasm32-wasi');assert.equal(manifest.abi,'wasm32-wasi-preview1');assert(manifest.capabilities.libstdcxx);assert(!manifest.stdModules);
  const lock=JSON.parse(await freeze(path.join(here,'sources.lock.json'))),runtimeLock=JSON.parse(await freeze(path.join(here,'runtime.lock.json'))),sdkLock=JSON.parse(await freeze(path.join(here,'debugger-runtime.lock.json'))).sdk;
  assert.equal(manifest.compiler.commit,lock.gcc.commit);assert.equal(manifest.compiler.version,'17.0.0');assert.equal(sdkLock.archiveSha256,lock.wasiSdk.sha256);assert.equal(sdkLock.wasiLibcCommit,runtimeLock.wasiLibc.commit);
  for(const name of ['build-std-modules.mjs','std-modules-profile.mjs','std-modules-fixtures.mjs','prepare-source.py'])await freeze(path.join(here,name));
  const source=path.join(work,'gcc');
  function sourceState(){const r=spawnSync('python3',[path.join(here,'prepare-source.py'),'--source',source],{encoding:'utf8',timeout:600000,maxBuffer:4*1024*1024});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
  const gccSource=sourceState();assert.deepEqual(gccSource,manifest.provenance.gccSource);
  for(const patch of lock.gcc.patches)assert.equal(identity(await freeze(path.join(here,patch.path))).sha256,patch.sha256);
  const nativeBuild=JSON.parse(await freeze(path.join(bundle,'provenance/native-build.json'))),wasmBuild=JSON.parse(await freeze(path.join(bundle,'provenance/compiler-build.json')));
  assert.deepEqual(nativeBuild.gccSource,gccSource);assert.deepEqual(wasmBuild.gccSource,gccSource);
  const tools={cc1plus:path.join(work,'gcc-native/gcc/cc1plus'),assembler:path.join(work,'wabt-native/wat2wasm'),archiver:path.join(sdk,'bin/llvm-ar'),nm:path.join(sdk,'bin/llvm-nm'),linker:path.join(sdk,'bin/wasm-ld'),inspector:path.join(work,'wabt-native/wasm-objdump'),node:process.execPath};
  const toolIds={};for(const[name,file]of Object.entries(tools))toolIds[name]=identity(await freeze(file));
  assert.equal(toolIds.cc1plus.sha256,nativeBuild.tools.cc1plus.sha256);
  for(const relative of ['bin/llvm-ar','bin/llvm-nm','bin/wasm-ld','share/wasi-sysroot/include/wasm32-wasi/signal.h','share/wasi-sysroot/include/wasm32-wasi/bits/signal.h','share/wasi-sysroot/lib/wasm32-wasi/libwasi-emulated-signal.a'])assert.deepEqual(identity(await freeze(path.join(sdk,relative))),sdkLock.files[relative]);
  const assets={};for(const[name,asset]of Object.entries(manifest.assets)){const bytes=await freeze(path.join(bundle,asset.path));assert.deepEqual(identity(bytes),content(asset),'Base asset changed: '+name);assets[name]=bytes;}
  for(const[name,file]of [['cc1plusJs','cc1plus.mjs'],['cc1plusWasm','cc1plus.wasm']])assert.deepEqual(content(wasmBuild.files[file]),identity(assets[name]));
  const entries=readTarEntries(assets.sysroot),sysroot=path.join(output,'sysroot');await fs.mkdir(sysroot);
  for(const[name,entry]of entries){const file=path.join(sysroot,name);if(entry.directory)await fs.mkdir(file,{recursive:true});else{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,assets.sysroot.subarray(entry.offset,entry.offset+entry.size));}}
  const interfaceInputs={},interfaces={};
  for(const name of ['std.cc.in','std.compat.cc.in','std-clib.cc.in'])interfaceInputs[name]=await freeze(path.join(source,'libstdc++-v3/src/c++23',name));
  for(const name of moduleNames)interfaces[name]=Buffer.concat([interfaceInputs[name+'.cc.in'],interfaceInputs['std-clib.cc.in']]);
  const signal=await freeze(path.join(sdk,'share/wasi-sysroot/lib/wasm32-wasi/libwasi-emulated-signal.a'));
  const report={schemaVersion:1,kind:'gcc-wasi-std-modules-qualification',status:'running',target:manifest.target,compilerTarget:'wasm32-unknown-wasi',abi:manifest.abi,profile:stdModulesProfile,baseManifest:identity(manifestBytes),bindings:{gccSource,cc1plusJs:identity(assets.cc1plusJs),cc1plusWasm:identity(assets.cc1plusWasm),sysroot:identity(assets.sysroot)},tools:toolIds,interfaces:{sources:Object.fromEntries(Object.entries(interfaceInputs).map(([k,v])=>[k,identity(v)])),std:identity(interfaces.std),stdCompat:identity(interfaces['std.compat'])},signalArchive:identity(signal),hosts:[]};
  const save=()=>fs.writeFile(path.join(output,'qualification.json'),json(report));await save();
  function run(command,argv,cwd,label,expected=0){const r=spawnSync(command,argv,{cwd,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});assert(!r.error,String(r.error));assert.equal(r.signal,null);assert.equal(r.status,expected,`${label}: ${r.stderr}`);return{command,argv,exitCode:r.status,stdout:r.stdout,stderr:r.stderr};}
  let create;
  async function compile(host,directory,code,bmis,{module,negative}={}) {
    await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'input.cpp'),code);
    const native=host==='native',mapper=path.join(directory,'mapper.txt');
    const sourceFile=native?path.join(directory,'input.cpp'):'/workspace/input.cpp',watFile=native?path.join(directory,'output.wat'):'/workspace/output.wat';
    const flags=moduleCompilerArguments(native?sysroot:'/sysroot',native?mapper:'/gcc-std-modules/mapper.txt').map(flag=>negative?.change&&flag===negative.change[0]?negative.change[1]:flag);
    const argv=[...flags,sourceFile,'-o',watFile],messages=[];let codeValue,m,peakMemoryBytes=null;const started=performance.now();
    if(native){
      for(const[name,bytes]of bmis)if(name!==negative?.missing)await fs.writeFile(path.join(directory,name+'.gcm'),bytes);
      if(!negative?.noMapper)await fs.writeFile(mapper,moduleNames.map(name=>name+' '+name+'.gcm\n').join(''));
      const r=spawnSync(tools.cc1plus,argv,{cwd:directory,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});assert(!r.error,String(r.error));assert.equal(r.signal,null);codeValue=r.status;messages.push(r.stdout,r.stderr);
    }else{
      create??=(await import(pathToFileURL(path.join(bundle,manifest.assets.cc1plusJs.path)).href)).default;
      m=await create({noInitialRun:true,wasmBinary:assets.cc1plusWasm,print:line=>messages.push(line),printErr:line=>messages.push(line)});
      for(const root of ['/sysroot','/workspace','/gcc-std-modules'])m.FS.mkdirTree(root);
      for(const[name,entry]of entries){const file='/sysroot/'+name;if(entry.directory)m.FS.mkdirTree(file);else{m.FS.mkdirTree(path.posix.dirname(file));m.FS.writeFile(file,assets.sysroot.subarray(entry.offset,entry.offset+entry.size));}}
      m.FS.writeFile(sourceFile,code);if(!negative?.noMapper)m.FS.writeFile('/gcc-std-modules/mapper.txt',mapperText);
      for(const[name,bytes]of bmis)if(name!==negative?.missing)m.FS.writeFile('/gcc-std-modules/'+name+'.gcm',bytes);
      try{codeValue=m.callMain(argv)??0;}catch(error){if(typeof error.status==='number')codeValue=error.status;else throw error;}
      peakMemoryBytes=m.HEAPU8.byteLength;
    }
    const diagnostic=messages.filter(Boolean).join('\n');await fs.writeFile(path.join(directory,'diagnostics.txt'),diagnostic);
    const record={argv,exitCode:codeValue,source:identity(code),diagnostics:identity(Buffer.from(diagnostic)),elapsedMs:performance.now()-started,linearMemoryBytes:peakMemoryBytes,maxRssKiB:process.resourceUsage().maxRSS};
    await fs.writeFile(path.join(directory,'compile.json'),json(record));
    assert.equal(codeValue,negative?1:0,`${host} ${path.basename(directory)}: ${diagnostic}`);
    if(negative){assert.match(diagnostic,negative.diagnostic);return record;}
    const assembly=native?await fs.readFile(watFile):Buffer.from(m.FS.readFile(watFile));
    await fs.writeFile(path.join(directory,'output.wat'),assembly);record.assembly=identity(assembly);
    if(module){const bmi=native?await fs.readFile(path.join(directory,module+'.gcm')):Buffer.from(m.FS.readFile('/gcc-std-modules/'+module+'.gcm'));assert(bmi.length>1000);assert(assembly.includes(Buffer.from('_ZGIW')));await fs.writeFile(path.join(directory,module+'.gcm'),bmi);record.bmi=identity(bmi);record.bmiBytes=bmi;}
    record.assemble=run(tools.assembler,['-r','--enable-annotations','--enable-exceptions','output.wat','-o','output.o'],directory,'assemble');
    const object=await fs.readFile(path.join(directory,'output.o'));assert(object.subarray(0,4).equals(Buffer.from([0,97,115,109])));record.object=identity(object);
    const wasmModule=new WebAssembly.Module(object);assert.equal(WebAssembly.Module.customSections(wasmModule,'linking').length,1,'Missing relocatable object metadata');
    record.inspection=run(tools.inspector,['-x','output.o'],directory,'object inspection');assert(!record.inspection.stdout.includes('[+] exception-handling'),'No-EH module profile produced EH feature');
    return record;
  }
  const runner=`import{WASI}from'node:wasi';import{readFileSync,openSync}from'node:fs';const w=new WASI({version:'preview1',args:['program.wasm'],env:{},preopens:{},stdin:openSync('input.txt','r'),stdout:openSync('output.txt','w'),stderr:openSync('error.txt','w'),returnOnExit:true});const m=await WebAssembly.compile(readFileSync('program.wasm'));const i=await WebAssembly.instantiate(m,{wasi_snapshot_preview1:w.wasiImport});process.exitCode=w.start(i);\n`;
  function linkCommand(objects,archive,filename){const lib=path.join(sysroot,'lib/wasm32-wasi');return['--fatal-warnings','-e','_start',path.join(lib,'crt1-command.o'),...objects,...(archive?[archive]:[]),path.join(output,'libwasi-emulated-signal.a'),'-L'+lib,'-lstdc++','-lc-printscan-long-double','-lm','-lc',path.join(lib,'libclang_rt.builtins-wasm32.a'),'-o',filename];}
  await fs.writeFile(path.join(output,'libwasi-emulated-signal.a'),signal);
  try {
    let nativeBmis;
    for(const host of ['native','wasm']){
      const directory=path.join(output,host);await fs.mkdir(directory);
      const bmis=new Map(),hostReport={host,compilerHost:host==='native'?'x86_64-pc-linux-gnu':'wasm32-unknown-emscripten',status:'running',modules:[],cases:[],diagnostics:[]};report.hosts.push(hostReport);
      for(const name of moduleNames){
        const moduleDirectory=path.join(directory,'modules',name),built=await compile(host,moduleDirectory,interfaces[name],bmis,{module:name});
        const{bmiBytes,...receipt}=built;bmis.set(name,bmiBytes);await fs.writeFile(path.join(directory,name+'.gcm'),bmiBytes);
        await fs.copyFile(path.join(moduleDirectory,'output.o'),path.join(directory,name+'.o'));
        await fs.copyFile(path.join(moduleDirectory,'output.wat'),path.join(directory,name+'.wat'));
        const symbols=run(tools.nm,['--defined-only',path.join(directory,name+'.o')],directory,'initializer symbols');
        assert(symbols.stdout.includes(name==='std'?'_ZGIW3std':'_ZGIW3stdW6compat'),'Missing actual module initializer');
        hostReport.modules.push({name,requires:name==='std'?[]:['std'],interface:identity(interfaces[name]),...receipt,symbols});await save();
      }
      const archive=path.join(directory,'libstdc++modules.a');hostReport.archiveCommand=run(tools.archiver,['rcs',archive,'std.o','std.compat.o'],directory,'module archive');hostReport.archive=identity(await fs.readFile(archive));
      for(const fixture of stdModuleCases){
        const caseDirectory=path.join(directory,'cases',fixture.id);await fs.mkdir(caseDirectory,{recursive:true});const units=[],objects=[];
        for(const[name,sourceText]of Object.entries(fixture.sources)){const unitDirectory=path.join(caseDirectory,name);const compiled=await compile(host,unitDirectory,Buffer.from(sourceText),bmis);units.push({name,...compiled});objects.push(path.join(unitDirectory,'output.o'));}
        const linked=run(tools.linker,linkCommand(objects,archive,'program.wasm'),caseDirectory,'link '+fixture.id);
        await fs.writeFile(path.join(caseDirectory,'input.txt'),fixture.stdin);await fs.writeFile(path.join(caseDirectory,'run.mjs'),runner);
        const execution=run(tools.node,['--no-warnings','run.mjs'],caseDirectory,'run '+fixture.id);
        const stdout=await fs.readFile(path.join(caseDirectory,'output.txt'),'utf8'),stderr=await fs.readFile(path.join(caseDirectory,'error.txt'),'utf8');assert.equal(stdout,fixture.stdout);assert.equal(stderr,'');
        const item={id:fixture.id,units,link:linked,execution,stdin:fixture.stdin,stdout,stderr,program:identity(await fs.readFile(path.join(caseDirectory,'program.wasm')))};
        if(fixture.id==='module-initializers'){item.missingInitializer=run(tools.linker,linkCommand(objects,null,'missing-initializer.wasm'),caseDirectory,'missing initializer',1);assert.match(item.missingInitializer.stderr,/undefined symbol: initializer for module std/);}
        hostReport.cases.push(item);await save();
      }
      const setjmpDirectory=path.join(directory,'unsupported-setjmp'),setjmp=await compile(host,setjmpDirectory,Buffer.from(unsupportedSetjmp),bmis);
      const rejected=run(tools.linker,linkCommand([path.join(setjmpDirectory,'output.o')],archive,'unsupported.wasm'),setjmpDirectory,'unsupported setjmp',1);assert.match(rejected.stderr,/undefined symbol: setjmp/);assert.match(rejected.stderr,/undefined symbol: longjmp/);hostReport.unsupportedSetjmp={compile:setjmp,link:rejected};
      for(const diagnostic of [...moduleDiagnostics,...(host==='wasm'?[{id:'wrong-host',diagnostic:/target & host/,native:true}]:[])]){
        const code=Buffer.from('import '+(diagnostic.compat?'std.compat':'std')+';\nint main(){std::vector<int> v={1,2};return v[0]-1;}\n');
        const item=await compile(host,path.join(directory,'diagnostics',diagnostic.id),code,diagnostic.native?nativeBmis:bmis,{negative:diagnostic});
        if(diagnostic.native){const text=await fs.readFile(path.join(directory,'diagnostics',diagnostic.id,'diagnostics.txt'),'utf8');assert(text.includes('x86_64-pc-linux-gnu')&&text.includes('wasm32-unknown-emscripten'));}
        hostReport.diagnostics.push({id:diagnostic.id,...item});await save();
      }
      hostReport.status='passed';if(host==='native')nativeBmis=bmis;await save();
    }
    assert.deepEqual(sourceState(),gccSource,'GCC source changed during qualification');
    for(const[file,expected]of frozen)assert.deepEqual(identity(await fs.readFile(file)),expected,'Input changed: '+file);
    // The extracted tree was compiler input; verify it too, not just its TAR.
    for(const[name,entry]of entries)if(!entry.directory)assert.deepEqual(identity(await fs.readFile(path.join(sysroot,name))),identity(assets.sysroot.subarray(entry.offset,entry.offset+entry.size)),'Extracted header/runtime changed: '+name);
    report.inputs=[...frozen].map(([file,receipt])=>({path:file,...receipt}));report.inputsUnchanged=true;report.status='passed';await save();
    // Expected failed Emscripten invocations set Node's process.exitCode.
    // Only clear it after every real outcome and frozen input has been checked.
    process.exitCode=0;
    return report;
  }catch(error){report.status='failed';report.error=String(error);await save();throw error;}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const options={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i].replace(/^--/,'');assert(['bundle','work','sdk','output'].includes(key)&&process.argv[i+1]&&!options[key],'Usage: build-std-modules.mjs --bundle DIR --work DIR --sdk DIR --output NEW_DIR');options[key]=path.resolve(process.argv[i+1]);}
  for(const key of ['bundle','work','sdk','output'])assert(options[key],'Missing --'+key);
  const result=await buildStdModules(options);console.log(json({status:result.status,output:options.output,hosts:result.hosts.map(host=>({host:host.host,cases:host.cases.length,diagnostics:host.diagnostics.length}))}));
}
