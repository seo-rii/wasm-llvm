import assert from 'node:assert/strict';
import test from 'node:test';
import { timezoneCases } from './tzdb-fixtures.mjs';
import { timezonePmfCases } from './tzdb-pmf-fixtures.mjs';
import { verifyTimezoneQualificationMetadata, verifyTimezonePmfMetadata } from './tzdb-qualification.mjs';

const nativeBuild={path:'/test/native-build.json',bytes:42,sha256:'a'.repeat(64)};
const expected={gccSource:{gccCommit:'b'.repeat(40),patches:[{path:'0029'}]},
  nativeBuild,sourceLockSha256:'c'.repeat(64)};
function measured() {
  // These records exercise metadata admission only. They never satisfy the
  // on-disk source, compiler, artifact and actual execution reopener.
  return {schemaVersion:1,kind:'gcc-wasi-tzdb-native-qualification',status:'passed',
    inputsUnchanged:true,mode:'full-gnu-runtime',fullGnuLibrary:true,
    compilerHost:'native',target:'wasm32-wasi',browserCompilerQualified:false,
    noGuestPreopens:true,hostTimezoneFilesExposed:false,
    gccSource:structuredClone(expected.gccSource),nativeBuild:{...nativeBuild},
    sourceLock:{sha256:expected.sourceLockSha256},counts:{total:12,ordinary:10,exceptions:2,families:6},
    commands:Array.from({length:60},()=>({exitCode:0,signal:null,timedOut:false})),
    cases:timezoneCases.map(fixture=>({id:fixture.id,status:'passed',request:fixture.request,
      run:fixture.run,expected:{stdout:fixture.stdout,stderr:fixture.stderr,exitCode:fixture.exitCode},
      observations:{stdout:fixture.stdout,stderr:fixture.stderr,exitCode:fixture.exitCode,
        escapedException:null,imports:[{module:'wasi_snapshot_preview1',kind:'function'}]},
      stages:[{sdkTool:'cc1plus',sdkArgv:['-mno-atomics'],semanticArgumentsIdentical:true,exitCode:0},
        {sdkTool:'as',sdkArgv:[],semanticArgumentsIdentical:true,exitCode:0},
        {sdkTool:'ld',sdkArgv:['--fatal-warnings'],semanticArgumentsIdentical:true,exitCode:0}],
      profile:{atomicInstructions:0,atomicHelpers:0,sharedMemory:false}})),
    inputs:Array.from({length:101},(_,i)=>({path:'/test/input-'+i})),artifacts:[{path:'/test/program.wasm'}]};
}
test('full native metadata retains separate ordinary and exception matrices',()=>{
  verifyTimezoneQualificationMetadata(measured(),expected);
});
for(const [name,mutate] of [
  ['standalone object mode',r=>{r.mode='standalone-preflight';}],
  ['partial GNU runtime',r=>{r.fullGnuLibrary=false;}],
  ['changed source',r=>{r.gccSource.gccCommit='d'.repeat(40);}],
  ['wrong compiler',r=>{r.nativeBuild.sha256='d'.repeat(64);}],
  ['wrong source lock',r=>{r.sourceLock.sha256='d'.repeat(64);}],
  ['failed execution',r=>{r.status='failed';}],
  ['changed input',r=>{r.inputsUnchanged=false;}],
  ['reference compiler',r=>{r.compilerHost='clang';}],
  ['invented browser qualification',r=>{r.browserCompilerQualified=true;}],
  ['host timezone preopens',r=>{r.noGuestPreopens=false;}],
  ['host timezone answer',r=>{r.hostTimezoneFilesExposed=true;}],
  ['missing case',r=>{r.cases.pop();}],
  ['duplicate case',r=>{r.cases[1]=r.cases[0];}],
  ['wrong case result',r=>{r.cases[0].observations.stdout='2026f\n';}],
  ['escaping trap',r=>{r.cases[0].observations.escapedException={message:'table index out of bounds'};}],
  ['unexpected host import',r=>{r.cases[0].observations.imports[0].module='host-timezone';}],
  ['atomic opcode',r=>{r.cases[0].profile.atomicInstructions=1;}],
  ['atomic helper',r=>{r.cases[0].profile.atomicHelpers=1;}],
  ['shared memory',r=>{r.cases[0].profile.sharedMemory=true;}],
  ['external timezone object',r=>{r.cases[0].stages[2].sdkArgv.push('/link-inputs/tzdb.o');}],
  ['non-production compiler arguments',r=>{r.cases[0].stages[0].semanticArgumentsIdentical=false;}],
  ['non-fatal linker warnings',r=>{r.cases[0].stages[2].sdkArgv=[];}],
  ['timed out command',r=>{r.commands[0].timedOut=true;}],
  ['missing command',r=>{r.commands.pop();}],
  ['duplicate input identity',r=>{r.inputs[1]=r.inputs[0];}],
  ['duplicate artifact identity',r=>{r.artifacts.push(r.artifacts[0]);}],
])test('timezone admission rejects '+name,()=>{
  const report=structuredClone(measured());mutate(report);
  assert.throws(()=>verifyTimezoneQualificationMetadata(report,expected));
});
function pmfMeasured() {
  return {kind:'gcc-wasi-member-function-pointer-native-qualification',schemaVersion:1,
    status:'passed',inputsUnchanged:true,compilerHost:'native',target:'wasm32-wasi',
    gccSource:structuredClone(expected.gccSource),nativeBuild:{...nativeBuild},
    counts:{total:8,families:4,optimizations:['0','2']},
    cases:timezonePmfCases.map(fixture=>({id:fixture.id,status:'passed',request:fixture.request,
      run:fixture.run,expected:{stdout:fixture.stdout,stderr:fixture.stderr,exitCode:fixture.exitCode},
      observed:{stdout:fixture.stdout,stderr:fixture.stderr,exitCode:fixture.exitCode,escapedException:null},
      commands:Array.from({length:4},()=>({exitCode:0}))}))};
}
test('PMF matrix includes invocation, projections, virtual nullness and both adjustments',()=>{
  verifyTimezonePmfMetadata(pmfMeasured(),expected);
  assert.equal(new Set(timezonePmfCases.map(x=>x.family)).size,4);
});
for(const [name,mutate] of [
  ['old compiler',r=>{r.nativeBuild.sha256='f'.repeat(64);}],
  ['missing adjustment coverage',r=>{r.cases=r.cases.slice(0,6);}],
  ['wrong virtual discriminator',r=>{r.cases[4].observed.stdout='virtual-abi 8 1 0 1\n';}],
  ['table-index trap',r=>{r.cases[0].observed.escapedException={message:'table index out of bounds'};}],
  ['unexecuted case',r=>{r.cases[0].status='prepared';}],
])test('PMF admission rejects '+name,()=>{
  const report=structuredClone(pmfMeasured());mutate(report);
  assert.throws(()=>verifyTimezonePmfMetadata(report,expected));
});
