import assert from 'node:assert/strict';
import test from 'node:test';
import { tlsRuntimeFiles,tlsRuntimeSources,verifyTlsRuntimeBuildMetadata,verifyTlsRuntimeExecutionMetadata,
 tlsFixtureDirectoryInventory,verifyTlsFixtureDirectoryInventory } from './tls-runtime-qualification.mjs';
import { tlsRuntimeCases } from './tls-runtime-fixtures.mjs';
import { verifyTlsLibcBuildMetadata } from './tls-libc-qualification.mjs';
import { verifyTlsCompilerEnvironment } from './test-tls-runtime.mjs';

const id={bytes:7,sha256:'1'.repeat(64)},source={gccCommit:'pinned',sourceDiffSha256:'2'.repeat(64)};
const files=tlsRuntimeFiles.map(path=>({path,...id}));
const expected={gccSource:source,nativeBuild:id,sourceLockSha256:id.sha256,runtimeBuild:id,files};
const build=()=>({schemaVersion:1,kind:'gcc-wasi-tls-runtime-build',target:'wasm32-wasi',status:'built-unverified',inputsUnchanged:true,
 gccSource:source,nativeBuild:id,sourceLock:id,files,objects:['ordinary','shared'].flatMap(profile=>tlsRuntimeSources.map(name=>({profile,member:name.replace('.cc','.o')}))),
 profile:{registrationLimit:null,executionQualified:false,allocator:'pinned-sdk-dlmalloc',pthread:false,
 ordinary:{linkFlags:['--wrap=exit','--wrap=__wasm_call_dtors'],atomics:false,atomicWaitNotify:false,libc:'wasm32-wasi-tls',memory:'private'},
 shared:{cleanup:'__wasm_call_thread_dtors',hostReservation:'lld-stack-before-heap',fixedMemory:true,imports:['env.memory','wasi_snapshot_preview1.sched_yield']}}});
const execution=()=>({schemaVersion:1,kind:'gcc-wasi-tls-runtime-execution',status:'passed',inputsUnchanged:true,gccSource:source,nativeBuild:id,
 runtimeBuild:id,sourceLock:id,files,cases:tlsRuntimeCases.map(fixture=>({id:fixture.id,status:'passed'})),counts:{ordinary:24,shared:8,workersPerSharedCase:2,expectedAbortTraps:2}});
test('build admission keeps source/compiler/archive identity and separates execution',()=>{
 verifyTlsRuntimeBuildMetadata(build(),expected);
 for(const update of [{status:'passed'},{inputsUnchanged:false},{gccSource:{...source,gccCommit:'other'}},{nativeBuild:{...id,bytes:8}}])
  assert.throws(()=>verifyTlsRuntimeBuildMetadata({...build(),...update},expected));
});
test('build admission requires both exit wrappers, no arbitrary cleanup cap, and private native-TLS libc',()=>{
 for(const mutate of [r=>r.profile.registrationLimit=128,r=>r.profile.ordinary.linkFlags.pop(),
  r=>r.profile.ordinary.libc='wasm32-wasi',r=>r.profile.ordinary.atomicWaitNotify=true,r=>r.profile.pthread=true,
  r=>r.profile.shared.hostReservation='above-heap']) {
  const report=build();mutate(report);assert.throws(()=>verifyTlsRuntimeBuildMetadata(report,expected));
 }
});
test('the private long-double archive and each actual GNU runtime object are mandatory',()=>{
 const missing=build();missing.files=files.filter(value=>!value.path.endsWith('libc-printscan-long-double.a'));
 assert.throws(()=>verifyTlsRuntimeBuildMetadata(missing,expected));
 const object=build();object.objects.pop();assert.throws(()=>verifyTlsRuntimeBuildMetadata(object,expected));
});
test('execution proof cannot omit, duplicate, reorder or fail an actual fixture',()=>{
 verifyTlsRuntimeExecutionMetadata(execution(),expected);
 for(const mutate of [r=>r.cases.pop(),r=>r.cases[1]=r.cases[0],r=>r.cases.reverse(),r=>r.cases[0].status='failed',
  r=>r.runtimeBuild={...id,bytes:8},r=>r.counts.expectedAbortTraps=0]) {
  const report=execution();mutate(report);assert.throws(()=>verifyTlsRuntimeExecutionMetadata(report,expected));
 }
});
test('private libc proof rejects a threads build or a build with unverified TLS metadata',()=>{
 const report={schemaVersion:1,kind:'gcc-wasi-private-tls-libc-build',status:'built-unverified',inputsUnchanged:true,
 profile:{target:'wasm32-wasip1',threads:false,reentrant:false,compilerThreadModel:'single',nativeTls:true,
 allocator:'unmodified-single-thread-dlmalloc',atomicWaitNotify:false,sourceModified:false,longDoubleFormatting:true,executionQualified:false},
 libraries:{'libc.a':id,'libc-printscan-long-double.a':id},memberInventories:{'libc.a':Array(827).fill('member'),'libc-printscan-long-double.a':Array(6).fill('member')},
 tlsInspection:Array(6).fill({}),formatterDelegation:Array(3).fill({}),objects:Array(833).fill({}),commands:Array(840).fill({status:0})};
 verifyTlsLibcBuildMetadata(report);
 for(const update of [{threads:true},{compilerThreadModel:'posix'},{nativeTls:false},{atomicWaitNotify:true},{executionQualified:true}])
  assert.throws(()=>verifyTlsLibcBuildMetadata({...report,profile:{...report.profile,...update}}));
});
test('retained source directories reject injected headers, precompiled headers and symbolic links',()=>{
 const fixture=tlsRuntimeCases.find(value=>value.id==='tls-inline-shared-o0'),entries=tlsFixtureDirectoryInventory(fixture);
 verifyTlsFixtureDirectoryInventory(fixture,entries);
 for(const path of ['errno.h','inline-tls.h.gch','include/stdio.h'])
  assert.throws(()=>verifyTlsFixtureDirectoryInventory(fixture,[...entries,{path,kind:'file'}]));
 const linked=structuredClone(entries);linked.find(value=>value.path==='inline-tls.h').kind='unsupported';
 assert.throws(()=>verifyTlsFixtureDirectoryInventory(fixture,linked));
});
test('compiler environment cannot inject an unrecorded include or library search root',()=>{
 verifyTlsCompilerEnvironment({PATH:'/usr/bin',CPATH:''});
 for(const name of ['CPATH','C_INCLUDE_PATH','CPLUS_INCLUDE_PATH','OBJC_INCLUDE_PATH','GCC_EXEC_PREFIX','COMPILER_PATH','LIBRARY_PATH'])
  assert.throws(()=>verifyTlsCompilerEnvironment({[name]:'/unrecorded'}));
});
