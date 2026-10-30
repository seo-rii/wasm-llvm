#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cases, diagnosticCases } from './symbol-alias-fixtures.mjs';
import { inspectAliasObject, verifyAliasDefinitions } from './symbol-alias-inspect.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),options={};
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i].replace(/^--/,'');assert(['compiler','source','work','sdk','sysroot','gcc-cxx-sysroot','output'].includes(key)&&process.argv[i+1]&&!options[key]);options[key]=path.resolve(process.argv[i+1]);}
for(const key of ['compiler','source','work','sdk','sysroot','gcc-cxx-sysroot','output'])assert(options[key],`Required --${key}`);
const {compiler,source,work,sdk,sysroot,output}=options;
await fs.mkdir(output);
const identity=bytes=>({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
async function identify(file){return{path:file,...identity(await fs.readFile(file))};}
const tools={gcc:path.join(compiler,'cc1'),gccCpp:path.join(compiler,'cc1plus'),clang:path.join(sdk,'bin/clang'),assembler:path.join(work,'wabt-native/wat2wasm'),linker:path.join(sdk,'bin/wasm-ld'),archive:path.join(sdk,'bin/llvm-ar'),node:process.execPath};
const snapshots=Object.fromEntries(await Promise.all(Object.entries(tools).map(async([name,file])=>[name,await identify(file)])));
const recipes=Object.fromEntries(await Promise.all(['test-symbol-alias.mjs','symbol-alias-fixtures.mjs','symbol-alias-inspect.mjs','wide-integer-test.mjs'].map(async name=>[name,await identify(path.join(here,name))])));
const sourceLock=await identify(path.join(here,'sources.lock.json'));
const nativeBuild=await identify(path.join(work,'native-build.json'));
const nativeReceipt=JSON.parse(await fs.readFile(nativeBuild.path));
assert.equal(nativeReceipt.sourceLockSha256,sourceLock.sha256);
assert.equal(nativeReceipt.tools.cc1.sha256,snapshots.gcc.sha256);
assert.equal(nativeReceipt.tools.cc1plus.sha256,snapshots.gccCpp.sha256);
const report={schemaVersion:1,kind:'gcc-wasi-native-symbol-alias-qualification',status:'running',tools:snapshots,recipes,sourceLock,nativeBuild,gccSource:nativeReceipt.gccSource,cases:[],diagnostics:[],negativeLinks:[]};
const save=()=>fs.writeFile(path.join(output,'qualification.json'),JSON.stringify(report,null,2)+'\n');
function run(command,argv,input){const r=spawnSync(command,argv,{input,encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024});return{command,argv,status:r.status,signal:r.signal,stdout:r.stdout||'',stderr:r.stderr||'',...(r.error?{error:r.error.message}:{})};}
function success(result){assert.equal(result.status,0,result.stderr||result.error);assert.equal(result.signal,null);assert(!result.error);return result;}
const common=(language,optimization)=>[`-O${optimization}`,`-std=${language==='cpp'?'gnu++17':'gnu11'}`,'-fdiagnostics-color=never','-Werror=attributes','-Werror=pragmas',...(language==='cpp'?['-fno-exceptions','-fno-rtti']:[])];
async function compile(family,language,optimization,code,stem){
  const file=stem+(language==='cpp'?'.cc':'.c'),object=stem+'.o',assembly=stem+'.wat';await fs.writeFile(file,code);
  const argv=family==='gcc'?['-quiet',...common(language,optimization),'-mno-simd128','-nostdinc','-isystem',path.join(compiler,'include'),'-isystem',path.join(sysroot,'include/wasm32-wasi'),file,'-o',assembly]:['--target=wasm32-wasip1','--sysroot='+path.join(sdk,'share/wasi-sysroot'),...common(language,optimization),'-mno-simd128','-c',file,'-o',object];
  const command=run(tools[family==='gcc'&&language==='cpp'?'gccCpp':family],argv);
  const entry={source:await identify(file),command};
  if(command.status===0){if(family==='gcc'){entry.assembly=await identify(assembly);entry.assembler=success(run(tools.assembler,['-r','--enable-annotations',assembly,'-o',object]));}entry.object=await identify(object);entry.metadata=inspectAliasObject(await fs.readFile(object));}
  return entry;
}
const library=path.join(sysroot,'lib/wasm32-wasi'),builtins=path.join(sdk,'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a');
function link(objects,program){return run(tools.linker,['--fatal-warnings','-m','wasm32','-e','_start','-o',program,path.join(library,'crt1-command.o'),'-L'+library,...objects,'-lm','-lc',builtins]);}
const cLinkage=code=>`#ifdef __cplusplus\nextern "C" {\n#endif\n${code}\n#ifdef __cplusplus\n}\n#endif\n`;
try{
  const sourceCheck=success(run('python3',[path.join(here,'prepare-source.py'),'--source',source]));
  assert.deepEqual(JSON.parse(sourceCheck.stdout),report.gccSource);
  const argv=[path.join(here,'wide-integer-test.mjs'),'--suite',path.join(here,'symbol-alias-fixtures.mjs'),...Object.entries(options).filter(([key])=>key!=='output').flatMap(([key,value])=>['--'+key,value]),'--output',path.join(output,'programs')];
  // The common runner preserves every actual command, object and executable.
  const programs=spawnSync(process.execPath,argv,{stdio:'inherit'});assert.equal(programs.status,0,'Alias program matrix failed');
  const programFile=path.join(output,'programs/report.json'),proof=JSON.parse(await fs.readFile(programFile));
  assert.equal(proof.status,'passed');assert.equal(proof.inputsUnchanged,true);report.programs=await identify(programFile);
  for(const entry of proof.cases){
    const fixture=cases.find(f=>f.id===entry.fixture);assert(fixture);
    const objects=[];
    for(const [index,unit]of entry.units.entries()){
      const bytes=await fs.readFile(unit.object.path);assert.deepEqual(identity(bytes),{bytes:unit.object.bytes,sha256:unit.object.sha256});
      const metadata=inspectAliasObject(bytes);
      if(index===1)verifyAliasDefinitions(metadata,fixture);
      objects.push({compiler:unit.compiler,object:unit.object,metadata});
    }
    report.cases.push({id:entry.id,fixture:entry.fixture,direction:entry.direction,stdout:entry.stdout,objects});
  }
  // The original GNU __equal definition must share operator=='s actual body.
  const archive=path.join(options['gcc-cxx-sysroot'],'lib/wasm32-wasi/libsupc++.a');
  const archiveIdentity=await identify(archive),extracted=spawnSync(tools.archive,['p',archive,'tinfo.o'],{maxBuffer:32*1024*1024});
  assert.equal(extracted.status,0,extracted.stderr.toString());assert(extracted.stdout.length);
  const member=path.join(output,'gnu-tinfo.o');await fs.writeFile(member,extracted.stdout);
  const runtimeMetadata=inspectAliasObject(extracted.stdout),runtimeGroups=cases.find(f=>f.runtimeAliasGroups)?.runtimeAliasGroups;
  assert(runtimeGroups);verifyAliasDefinitions(runtimeMetadata,{aliasGroups:runtimeGroups});
  report.gnuRuntime={archive:archiveIdentity,member:await identify(member),metadata:runtimeMetadata};
  for(const fixture of diagnosticCases)for(const family of fixture.clang===false?['gcc']:['gcc','clang']){
    const directory=path.join(output,fixture.id+'-'+family);await fs.mkdir(directory);
    const result=await compile(family,fixture.request.language,fixture.request.optimization,fixture.request.code,path.join(directory,'invalid'));
    assert.equal(result.command.status,1,result.command.stderr);assert.equal(result.command.signal,null);assert(!result.command.error);
    assert.match(result.command.stderr,new RegExp(fixture.diagnosticPattern,'i'));
    assert(!result.object,'Rejected alias must not produce an object');report.diagnostics.push({id:fixture.id,family,...result});
  }
  for(const kind of ['function','data'])for(const language of ['c','cpp'])for(const optimization of ['0','2'])for(const family of ['gcc','clang']){
    const id=`${kind}-${language}-o${optimization}-${family}`,directory=path.join(output,'link-controls-'+id);await fs.mkdir(directory);
    const declaration=kind==='function'?'int shared_alias(int);':'extern int shared_alias;';
    const call=kind==='function'?'shared_alias(3)':'shared_alias';
    const main=await compile(family,language,optimization,cLinkage(declaration)+`int main(void){return ${call};}\n`,path.join(directory,'main'));success(main.command);
    const providers=[];
    for(const target of ['first','second']){
      const definition=kind==='function'?`int ${target}(int n){return n+1;} extern int shared_alias(int) __attribute__((alias("${target}")));`:`int ${target}=7; extern int shared_alias __attribute__((alias("${target}")));`;
      const provider=await compile(family,language,optimization,cLinkage(definition),path.join(directory,target));success(provider.command);
      verifyAliasDefinitions(provider.metadata,{aliasGroups:[{kind,names:[target,'shared_alias']}]});providers.push(provider);
    }
    // A valid single-provider link proves these are specific link rejections.
    const control=link([main.object.path,providers[0].object.path],path.join(directory,'control.wasm'));success(control);
    const duplicate=link([main.object.path,...providers.map(p=>p.object.path)],path.join(directory,'duplicate.wasm'));
    assert.notEqual(duplicate.status,0);assert.equal(duplicate.signal,null);assert(!duplicate.error);assert.match(duplicate.stderr,/duplicate symbol: shared_alias/);
    const undefinedLink=link([main.object.path],path.join(directory,'undefined.wasm'));
    assert.notEqual(undefinedLink.status,0);assert.equal(undefinedLink.signal,null);assert(!undefinedLink.error);assert.match(undefinedLink.stderr,/undefined symbol: shared_alias/);
    report.negativeLinks.push({id,main,providers,control,duplicate,undefined:undefinedLink});
  }
  for(const item of [...Object.values(snapshots),...Object.values(recipes),sourceLock,nativeBuild,report.gnuRuntime.archive])assert.deepEqual(await identify(item.path),item,'Changed alias qualification input');
  const finalSource=success(run('python3',[path.join(here,'prepare-source.py'),'--source',source]));
  assert.deepEqual(JSON.parse(finalSource.stdout),report.gccSource);
  report.inputsUnchanged=true;report.counts={programs:report.cases.length,diagnostics:report.diagnostics.length,linkRejections:report.negativeLinks.length*2};
  assert.deepEqual(report.counts,{programs:106,diagnostics:40,linkRejections:32});report.status='passed';
}catch(error){report.status='failed';report.error=error.stack;process.exitCode=1;}
await save();console.log(JSON.stringify({status:report.status,counts:report.counts,error:report.error?.slice(0,1000)}));
