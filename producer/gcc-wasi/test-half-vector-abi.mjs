import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { identity } from '../clang-browser/cross/package.mjs';
import { fileURLToPath } from 'node:url';
import { inspectObjectFunctionSignatures } from './inspect-vector-abi.mjs';
// Four internal half modes must retain indirect public arguments/results.
const options={};
for(let i=2;i<process.argv.length;i+=2){
  const key=process.argv[i].replace(/^--/,'');
  assert(['compiler','work','sdk','sysroot','output'].includes(key)&&process.argv[i+1]&&!options[key]);
  options[key]=path.resolve(process.argv[i+1]);
}
for(const key of ['compiler','work','sdk','sysroot','output'])assert(options[key],`Required --${key}`);
const {compiler,work,sdk,sysroot,output}=options,library=path.join(sysroot,'lib/wasm32-wasi');
const tools={c:path.join(compiler,'cc1'),cpp:path.join(compiler,'cc1plus'),assembler:path.join(work,'wabt-native/wat2wasm'),linker:path.join(sdk,'bin/wasm-ld'),node:process.execPath};
const runtimeInputs = Object.fromEntries(await Promise.all(['crt1-command.o', 'libc.a', 'libm.a'].map(async name => {
  const file = path.join(library, name);
  return [name, {path: file, ...identity(await fs.readFile(file))}];
})));
const builtins = path.join(sdk, 'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a');
runtimeInputs.builtins = {path: builtins, ...identity(await fs.readFile(builtins))};
const native=JSON.parse(await fs.readFile(path.join(path.dirname(path.dirname(compiler)),'native-build.json')));
const inputs=Object.fromEntries(await Promise.all(Object.entries(tools).map(async([name,file])=>[name,{path:file,...identity(await fs.readFile(file))}])));
assert.equal(inputs.c.sha256,native.tools.cc1.sha256);assert.equal(inputs.cpp.sha256,native.tools.cc1plus.sha256);
await fs.mkdir(output);
const runner=path.join(output,'runner.mjs');await fs.writeFile(runner,`import{WASI}from'node:wasi';import{readFile}from'node:fs/promises';const w=new WASI({version:'preview1',args:['program'],env:{},returnOnExit:true});const m=await WebAssembly.compile(await readFile(process.argv[2]));process.exitCode=w.start(await WebAssembly.instantiate(m,{wasi_snapshot_preview1:w.wasiImport}));\n`);
const harness=identity(await fs.readFile(fileURLToPath(import.meta.url)));
const report={kind:'gcc-wasi-internal-half-mode-public-abi-control',status:'running',gccSource:native.gccSource,harness,tools:inputs,runtimeInputs,cases:[]};
function run(command,argv,input){const r=spawnSync(command,argv,{encoding:'utf8',input,timeout:120000,maxBuffer:4*1024*1024});return{command,argv,status:r.status,signal:r.signal,stdout:r.stdout||'',stderr:r.stderr||'',...(r.error?{error:r.error.message}:{})};}
for(const [shape,type,lanes]of[['i8x8','signed char',8],['i16x4','short',4],['i32x2','int',2],['f32x2','float',2]])for(const language of['c','cpp'])for(const optimization of['0','2'])for(const profile of['default','disabled','enabled']){
 const id=`half-${shape}-${language}-o${optimization}-${profile}`,directory=path.join(output,id);await fs.mkdir(directory);
 const code=`#include <stdio.h>\ntypedef ${type} Lane;typedef Lane V __attribute__((vector_size(8)));\n#ifdef __cplusplus\nextern "C"\n#endif\n__attribute__((noinline)) V half_add(V value,int n){for(unsigned i=0;i<${lanes};++i)value[i]=value[i]+(Lane)n;return value;}\nstatic V(*volatile call_half)(V,int)=half_add;\nint main(void){int n;if(scanf("%d",&n)!=1||n<0||n>8)return 2;V input;for(unsigned i=0;i<${lanes};++i)input[i]=(Lane)(i+1);V result=call_half(input,n);for(unsigned i=0;i<${lanes};++i)printf("%d%c",(int)result[i],i+1==${lanes}?'\\n':' ');return 0;}\n`;
 const source=path.join(directory,language==='cpp'?'main.cc':'main.c'),assembly=path.join(directory,'main.wat'),object=path.join(directory,'main.o'),program=path.join(directory,'main.wasm');await fs.writeFile(source,code);
 const entry={id,status:'running',source:identity(Buffer.from(code)),stdin:'3\n',commands:[]};report.cases.push(entry);
 const invoke=(tool,argv,input)=>{const result=run(tools[tool],argv,input);entry.commands.push(result);assert.equal(result.status,0,result.stderr||result.error);return result;};
 try{
 invoke(language,['-quiet',`-O${optimization}`,`-std=${language==='cpp'?'gnu++17':'gnu11'}`,'-fdiagnostics-color=never','-D__GCC_WASI_SINGLE_THREAD__=1','-nostdinc','-isystem',path.join(compiler,'include'),'-isystem',path.join(sysroot,'include/wasm32-wasi'),...(language==='cpp'?['-fno-exceptions','-fno-rtti']:[]),...(profile==='default'?[]:[profile==='enabled'?'-msimd128':'-mno-simd128']),source,'-o',assembly]);
 invoke('assembler',['-r','--enable-annotations',assembly,'-o',object]);const objectBytes=await fs.readFile(object);entry.object=identity(objectBytes);entry.signature=inspectObjectFunctionSignatures(objectBytes).half_add;assert.deepEqual(entry.signature,{params:['i32','i32','i32'],results:[]},'Half-vector public ABI must stay indirect');
 invoke('linker',['--fatal-warnings','-m','wasm32','-e','_start','--export=half_add','-o',program,path.join(library,'crt1-command.o'),`-L${library}`,object,'-lm','-lc',path.join(sdk,'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a')]);
 entry.stdout=invoke('node',['--disable-warning=ExperimentalWarning',runner,program],entry.stdin).stdout;assert.equal(entry.stdout,Array.from({length:lanes},(_,i)=>i+4).join(' ')+'\n');entry.program=identity(await fs.readFile(program));entry.status='passed';
 }catch(error){entry.status='failed';entry.error=error.message;}
}
for(const[name,file]of Object.entries(tools))assert.deepEqual(identity(await fs.readFile(file)),{bytes:inputs[name].bytes,sha256:inputs[name].sha256});
assert.deepEqual(identity(await fs.readFile(fileURLToPath(import.meta.url))),harness);
for (const item of Object.values(runtimeInputs)) {
  assert.deepEqual(identity(await fs.readFile(item.path)), {bytes: item.bytes, sha256: item.sha256});
}
report.inputsUnchanged=true;report.status=report.cases.every(c=>c.status==='passed')?'passed':'failed';await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,cases:report.cases.length,signatures:[...new Set(report.cases.filter(c=>c.signature).map(c=>JSON.stringify(c.signature)))],failures:report.cases.filter(c=>c.status!=='passed').map(c=>({id:c.id,error:c.error})).slice(0,3)}));process.exitCode=report.status==='passed'?0:1;
