#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identity, runLibatomicValidationCommand as run } from './libatomic-qualification.mjs';
import { inspectTlsObject } from './tls-inspect.mjs';
import { tlsRuntimeCases, assertTlsRuntimeOrdinaryResult, assertTlsRuntimeSharedResult } from './tls-runtime-fixtures.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const identify=async file=>({path:path.resolve(file),...identity(await fs.readFile(file))});
const content=value=>({bytes:value.bytes,sha256:value.sha256});
export const tlsRuntimeValidationFiles=Object.freeze(['test-tls-runtime.mjs','tls-runtime-fixtures.mjs',
  'run-tls-runtime-program.mjs','run-tls-shared.mjs','tls-runtime-qualification.mjs','tls-libc-qualification.mjs',
  'tls-assembly-replay.mjs','tls-inspect.mjs','symbol-alias-inspect.mjs','libatomic-qualification.mjs']);

export function verifyTlsCompilerEnvironment(environment) {
  for(const name of ['CPATH','C_INCLUDE_PATH','CPLUS_INCLUDE_PATH','OBJC_INCLUDE_PATH',
    'GCC_EXEC_PREFIX','COMPILER_PATH','LIBRARY_PATH'])
    assert(!environment[name], 'Unrecorded TLS compiler search-path environment: '+name);
}

export function tlsRuntimeCompileArguments(fixture,source,assembly,context) {
  const {request}=fixture,compiler=path.join(context.work,'gcc-native/gcc');
  const headers=path.join(context.gccCxxSysroot,'include/c++/17.0.0');
  return ['-quiet','-O'+request.optimization,'-g0','-std='+request.standard,'-fdiagnostics-color=never',
    '-fno-stack-protector','-mtls',request.atomics?'-matomics':'-mno-atomics','-nostdinc',
    '-I',path.dirname(source),'-isystem',path.join(compiler,'include'),
    ...(request.language==='cpp'?['-fno-exceptions','-fno-rtti','-fuse-cxa-atexit',
      '-isystem',headers,'-isystem',path.join(headers,'wasm32-wasi'),'-isystem',path.join(headers,'backward')]:[]),
    '-isystem',path.join(context.runtime,'sysroot/include/wasm32-wasi-tls'),
    '-isystem',path.join(context.sysroot,'include/wasm32-wasi'),source,'-o',assembly];
}

export function tlsRuntimeLinkArguments(fixture,objects,program,context) {
  const shared=fixture.request.sharedMemory;
  const directory=path.join(context.runtime,'sysroot/lib',shared?'wasm32-wasi-threads':'wasm32-wasi-tls');
  const libraries=[path.join(directory,shared?'libgcc-wasi-tls-shared.a':'libgcc-wasi-tls.a'),
    ...(fixture.request.longDouble?[path.join(directory,'libc-printscan-long-double.a')]:[]),
    path.join(directory,'libc.a'),path.join(directory,'libm.a'),path.join(directory,'libclang_rt.builtins-wasm32.a')];
  if(shared) {
    const exports=['__stack_pointer','__stack_low','__stack_high','__heap_base','__data_end','__tls_size',
      '__tls_align','__tls_base','__wasm_init_tls','__wasm_call_ctors','__wasm_call_thread_dtors',shared.entry];
    return ['--fatal-warnings','--no-entry','--shared-memory','--import-memory','--export-memory',
      '--no-stack-first','--global-base=1024','-z','stack-size='+shared.reservedBytes,
      '--initial-memory='+shared.initialPages*65536,'--max-memory='+shared.maximumPages*65536,
      '--extra-features=atomics,bulk-memory,mutable-globals',...exports.map(name=>'--export='+name),
      ...objects,...libraries,'-o',program];
  }
  return ['--fatal-warnings','--entry=_start','--export=_start','--wrap=exit','--wrap=__wasm_call_dtors',
    '-z','stack-size=65536','--initial-memory=2097152','--max-memory=2097152',
    path.join(context.sysroot,'lib/wasm32-wasi/crt1-command.o'),...objects,...libraries,'-o',program];
}

export async function executeTlsRuntimeCase(fixture,program,directory,context) {
  await fs.mkdir(directory,{recursive:true});
  const shared=fixture.request.sharedMemory;
  const spec={program,shared,run:fixture.run??{},stdin:path.join(directory,'stdin.txt'),
    stdout:path.join(directory,'guest.stdout'),stderr:path.join(directory,'guest.stderr'),
    result:path.join(directory,'result.json'),memory:path.join(directory,'memory.bin')};
  await fs.writeFile(spec.stdin,fixture.stdin??'');
  const specFile=path.join(directory,'run.json');await fs.writeFile(specFile,JSON.stringify(spec,null,2)+'\n');
  const command=await run(context.node??process.execPath,['--no-warnings',path.join(here,'run-tls-runtime-program.mjs'),specFile],directory,'execute',60000);
  const result=JSON.parse(await fs.readFile(spec.result));
  const memory=shared?new Uint8Array(await fs.readFile(spec.memory)):undefined;
  const oracle=shared?assertTlsRuntimeSharedResult(fixture,{...result,memory}):assertTlsRuntimeOrdinaryResult(fixture,result);
  return {command,spec:await identify(specFile),result:await identify(spec.result),
    ...(shared?{memory:await identify(spec.memory)}:{stdout:await identify(spec.stdout),stderr:await identify(spec.stderr)}),oracle};
}

export async function compileTlsRuntimeCase(fixture,directory,context,sourceDirectory=directory) {
  await fs.mkdir(directory,{recursive:true});
  const {request}=fixture,main=request.language==='cpp'?'unit0.cpp':'unit0.c';
  const inputs=[{path:main,contents:request.code},...(request.files??[])],sources=[];
  for(const file of inputs) {
    assert(!path.isAbsolute(file.path)&&!file.path.split('/').includes('..'));
    const target=path.join(sourceDirectory,file.path);
    if(sourceDirectory===directory)await fs.writeFile(target,file.contents);
    else assert.equal(await fs.readFile(target,'utf8'),file.contents,'Retained TLS fixture source differs');
    sources.push(await identify(target));
  }
  const entry={id:fixture.id,request,kind:fixture.kind,sources,commands:[],objects:[]};
  for(const [index,name]of [main,...(request.sources??[])].entries()) {
    const source=path.join(sourceDirectory,name),assembly=path.join(directory,'unit'+index+'.wat'),object=path.join(directory,'unit'+index+'.o');
    const compiler=path.join(context.work,'gcc-native/gcc',request.language==='cpp'?'cc1plus':'cc1');
    const compiled=await run(compiler,tlsRuntimeCompileArguments(fixture,source,assembly,context),directory,'compile-'+index);
    const assembled=await run(path.join(context.work,'wabt-native/wat2wasm'),['--enable-all','-r',assembly,'-o',object],directory,'assemble-'+index);
    const inspected=await run(path.join(context.work,'wabt-native/wasm-objdump'),['-x','-d',object],directory,'inspect-'+index);
    entry.commands.push(compiled,assembled,inspected);
    const text=await fs.readFile(assembly,'utf8'),disassembly=await fs.readFile(inspected.stdout.path,'utf8');
    assert(!text.includes('__emutls_'),'Runtime fixture used emulated TLS');
    if(!request.atomics)assert(!/\.atomic\.|atomic\.fence/u.test(disassembly),'Ordinary fixture emitted user atomic instructions');
    const inspection=inspectTlsObject(await fs.readFile(object));
    assert(inspection.hasTls&&inspection.tlsRelocations.length,'Actual native TLS symbols and relocations required');
    entry.objects.push({source:await identify(source),assembly:await identify(assembly),object:await identify(object),
      inspection:{tlsSymbols:inspection.tlsSymbols,tlsRelocations:inspection.tlsRelocations,segments:inspection.segments},
      compile:compiled,assemble:assembled,disassembly:inspected.stdout});
  }
  const program=path.join(directory,'main.wasm');
  entry.link=await run(path.join(context.sdk,'bin/wasm-ld'),tlsRuntimeLinkArguments(fixture,entry.objects.map(item=>item.object.path),program,context),directory,'link');
  entry.commands.push(entry.link);
  const inspected=await run(path.join(context.work,'wabt-native/wasm-objdump'),['-x','-d',program],directory,'program-inspect');entry.commands.push(inspected);
  const text=await fs.readFile(inspected.stdout.path,'utf8'),module=await WebAssembly.compile(await fs.readFile(program));
  assert(!text.includes('__emutls_'),'Final program contains emulated TLS');
  if(!request.sharedMemory)assert(!/memory\.atomic\.(?:wait32|wait64|notify)/u.test(text),'Private TLS runtime contains shared-memory wait/notify');
  for(const name of fixture.requiredSymbols)assert(text.includes('<'+name+'>'),'Actual runtime function is absent: '+name);
  if(request.sharedMemory) {
    const imports=WebAssembly.Module.imports(module),allowed=[
      {module:'env',name:'memory',kind:'memory'},
      {module:'wasi_snapshot_preview1',name:'sched_yield',kind:'function'}];
    assert(imports.some(item=>item.module==='env'&&item.name==='memory'&&item.kind==='memory'));
    assert(imports.length>=1&&imports.length<=2);
    for(const item of imports)assert(allowed.some(value=>value.module===item.module&&value.name===item.name&&value.kind===item.kind),
      'Shared TLS runtime imports an unsupported host service');
  }
  entry.program=await identify(program);entry.disassembly=inspected.stdout;
  entry.execution=await executeTlsRuntimeCase(fixture,program,path.join(directory,'execution'),context);
  entry.status='passed';return entry;
}

async function tree(root) {
  const files=[];
  for(const item of await fs.readdir(root,{withFileTypes:true})) {
    const file=path.join(root,item.name);
    if(item.isDirectory())files.push(...await tree(file));else if(item.isFile())files.push(file);
  }
  return files.sort();
}

export async function qualifyTlsRuntime(options) {
  verifyTlsCompilerEnvironment(process.env);
  const context={...options,node:options.node??process.execPath};
  for(const key of ['work','sdk','sysroot','gccCxxSysroot','runtime','output'])context[key]=path.resolve(context[key]);
  await fs.mkdir(context.output);const reportFile=path.join(context.output,'qualification.json');
  const report={schemaVersion:1,kind:'gcc-wasi-tls-runtime-execution',status:'running',cases:[],commands:[]};
  const save=()=>fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n');
  try {
    report.runtimeBuild=await identify(path.join(context.runtime,'build.json'));
    const build=JSON.parse(await fs.readFile(report.runtimeBuild.path));
    assert.equal(build.status,'built-unverified');assert.equal(build.inputsUnchanged,true);
    report.files=build.files;report.gccSource=build.gccSource;
    report.nativeBuild=await identify(path.join(context.work,'native-build.json'));
    assert.deepEqual(content(report.nativeBuild),content(build.nativeBuild));
    report.sourceLock=await identify(path.join(here,'sources.lock.json'));
    assert.deepEqual(content(report.sourceLock),content(build.sourceLock));
    const inputs=new Map();const freeze=async file=>{const item=await identify(file);inputs.set(item.path,item);return item;};
    for(const item of build.inputs)assert.deepEqual(content(await freeze(item.path)),content(item),'Changed runtime build input');
    await freeze(report.runtimeBuild.path);await freeze(report.nativeBuild.path);
    for(const item of build.files)assert.deepEqual(content(await freeze(path.join(context.runtime,'sysroot',item.path))),content(item));
    for(const file of [...tlsRuntimeValidationFiles.map(name=>path.join(here,name)),context.node,
      path.join(context.sdk,'bin/wasm-ld'),path.join(context.work,'wabt-native/wat2wasm'),
      path.join(context.work,'wabt-native/wasm-objdump'),path.join(context.work,'gcc-native/gcc/cc1'),path.join(context.work,'gcc-native/gcc/cc1plus'),
      ...await tree(path.join(context.gccCxxSysroot,'include')),...await tree(path.join(context.sysroot,'include')),
      ...await tree(path.join(context.work,'gcc-native/gcc/include'))])await freeze(file);
    report.inputs=[...inputs.values()].sort((a,b)=>a.path.localeCompare(b.path));
    report.context=Object.fromEntries(['work','sdk','sysroot','gccCxxSysroot','runtime','node'].map(key=>[key,context[key]]));
    const sourceCheck=await run('python3',[path.join(here,'prepare-source.py'),'--source',path.join(context.work,'gcc')],context.output,'source-before',600000);
    report.commands.push(sourceCheck);assert.deepEqual(JSON.parse(await fs.readFile(sourceCheck.stdout.path)),build.gccSource);
    for(const fixture of tlsRuntimeCases) {
      report.cases.push(await compileTlsRuntimeCase(fixture,path.join(context.output,fixture.id),context,
        context.sourceRoot?path.join(path.resolve(context.sourceRoot),fixture.id):path.join(context.output,fixture.id)));await save();
    }
    const after=await run('python3',[path.join(here,'prepare-source.py'),'--source',path.join(context.work,'gcc')],context.output,'source-after',600000);
    report.commands.push(after);assert.deepEqual(JSON.parse(await fs.readFile(after.stdout.path)),build.gccSource);
    for(const item of report.inputs)assert.deepEqual(content(await identify(item.path)),content(item),'TLS execution input changed');
    report.inputsUnchanged=true;report.status='passed';
    report.counts={ordinary:tlsRuntimeCases.filter(fixture=>!fixture.request.sharedMemory).length,
      shared:tlsRuntimeCases.filter(fixture=>fixture.request.sharedMemory).length,workersPerSharedCase:2,
      expectedAbortTraps:tlsRuntimeCases.filter(fixture=>fixture.expected?.trap).length};
  }catch(error){report.status='failed';report.error=String(error.stack||error);await save();throw error;}
  await save();return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const options={};
  for(let i=2;i<process.argv.length;i+=2) {
    const key=({'--gcc-cxx-sysroot':'gccCxxSysroot'})[process.argv[i]]??process.argv[i].replace(/^--/u,'');
    assert(['work','sdk','sysroot','gccCxxSysroot','runtime','output','node'].includes(key));assert(process.argv[i+1]);options[key]=process.argv[i+1];
  }
  const report=await qualifyTlsRuntime(options);console.log(JSON.stringify({status:report.status,counts:report.counts}));
}
