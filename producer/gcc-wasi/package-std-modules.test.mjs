import assert from 'node:assert/strict';
import test from 'node:test';
import {stdModulesManifest} from './package-std-modules.mjs';
import {stdModulesProfile,moduleAssets} from './std-modules-profile.mjs';
import {stdModuleCases,moduleDiagnostics} from './std-modules-fixtures.mjs';

// These exercise only the pure manifest transformation. They are not compiler
// receipts; the async packager additionally reopens actual files and programs.
function fixture(){
  const digest=n=>({bytes:n,sha256:String(n%10).repeat(64)}),asset=n=>({path:n+'.bin',...digest(100)});
  const base={schemaVersion:2,kind:'gcc-wasm32-wasi',host:'wasm32-emscripten',target:'wasm32-wasi',abi:'wasm32-wasi-preview1',capabilities:{libstdcxx:true},assets:{cc1plusJs:asset('cc1plusJs'),cc1plusWasm:asset('cc1plusWasm'),sysroot:asset('sysroot')},provenance:{gccSource:{gccCommit:'a'.repeat(40),sourceDiffSha256:'b'.repeat(64),patches:[{path:'patches/first.patch',sha256:'c'.repeat(64)}]},files:{}},qualification:{status:'unverified'},limitations:[]};
  const assets=Object.fromEntries(Object.entries(moduleAssets).map(([key,path],i)=>[key,{path,...digest(i+100)}]));
  const report={kind:'gcc-wasi-std-modules-qualification',status:'passed',inputsUnchanged:true,profile:structuredClone(stdModulesProfile),target:base.target,abi:base.abi,compilerTarget:'wasm32-unknown-wasi',bindings:{gccSource:structuredClone(base.provenance.gccSource),cc1plusJs:digest(100),cc1plusWasm:digest(100),sysroot:digest(100)},signalArchive:digest(103),interfaces:{},hosts:['native','wasm'].map(host=>({host,compilerHost:host==='native'?'x86_64-pc-linux-gnu':'wasm32-unknown-emscripten',status:'passed',modules:['std','std.compat'].map((name,i)=>({name,requires:i?['std']:[],bmi:digest(100+i),object:digest(200+i)})),archive:digest(102),cases:stdModuleCases.map(c=>({id:c.id})),diagnostics:[...moduleDiagnostics.map(d=>({id:d.id})),...(host==='wasm'?[{id:'wrong-host'}]:[])]}))};
  return{base,report,assets};
}
test('optional modules preserve every eager asset and both qualification gates',()=>{
  const{base,report,assets}=fixture(),original=structuredClone(base),result=stdModulesManifest(base,report,assets);
  assert.deepEqual(base,original);assert.deepEqual(result.assets,base.assets);assert.equal(result.stdModules.compilerHost,'wasm32-unknown-emscripten');assert.equal(result.host,'wasm32-emscripten');assert.deepEqual(result.stdModules.profile,stdModulesProfile);assert.equal(result.qualification.status,'unverified');assert.equal(result.stdModules.qualification.status,'unverified');assert.deepEqual(result.stdModules.initializerArchive.members.map(m=>m.name),['std.o','std.compat.o']);
});
for(const[name,change]of[
  ['native BMI host',x=>x.report.hosts[1].compilerHost='x86_64-pc-linux-gnu'],
  ['target',x=>x.report.target='x86_64-linux-gnu'],
  ['compiler bytes',x=>x.report.bindings.cc1plusWasm.sha256='d'.repeat(64)],
  ['sysroot bytes',x=>x.report.bindings.sysroot.bytes++],
  ['patch sequence',x=>x.report.bindings.gccSource.patches.unshift({path:'other',sha256:'f'.repeat(64)})],
  ['ABI',x=>x.report.abi='other'],
  ['optimization',x=>x.report.profile.optimization='0'],
  ['macro override',x=>x.report.profile.defines.push('_GLIBCXX_USE_CXX11_ABI=0')],
  ['missing actual fixture',x=>x.report.hosts[0].cases.pop()],
  ['missing wrong-host negative',x=>x.report.hosts[1].diagnostics.pop()],
  ['missing std dependency',x=>x.report.hosts[1].modules[1].requires=[]],
  ['wrong BMI hash',x=>x.assets.std.sha256='e'.repeat(64)],
  ['wrong BMI length',x=>x.assets.std.bytes++],
  ['unsafe asset path',x=>x.assets.std.path='../std.gcm'],
  ['extra optional asset',x=>x.assets.extra=x.assets.std],
  ['missing initializer',x=>delete x.assets.initializers],
  ['failed qualification',x=>x.report.status='failed'],
  ['mutable build inputs',x=>x.report.inputsUnchanged=false],
])test('reject '+name,()=>{const x=fixture();change(x);assert.throws(()=>stdModulesManifest(x.base,x.report,x.assets));});
