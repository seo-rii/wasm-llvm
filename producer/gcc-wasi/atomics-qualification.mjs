import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {nativeAtomicSharedCases, assertNativeAtomicSharedResult} from './atomics-native-fixtures.mjs';
import {identity, assertLibatomicAssemblyReplay, runLibatomicValidationCommand as run} from './libatomic-qualification.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const content=record=>({bytes:record.bytes,sha256:record.sha256});
const policies=[['explicit-before','cpp'],['explicit-after','c'],['pragma','c'],['attribute','cpp']];
const queryPolicy={baseline:'enabled','final-disabled':'enabled','final-enabled':'disabled',
  'explicit-before':'disabled','explicit-after':'disabled','baseline-explicit-disabled':'disabled'};
export const expectedNativeAtomicsCounts=Object.freeze({driverCases:36,driverExecutions:8,
  alignmentDiagnostics:8,alignmentControls:12,optimizerQueries:6,sharedCases:16,optimizationControls:4});

export function verifyNativeAtomicsReportMetadata(driver,shared) {
  assert.equal(driver.kind,'gcc-wasi-atomics-backend-driver-probe');
  assert.equal(shared.kind,'gcc-wasi-native-atomics-shared-qualification');
  for(const report of [driver,shared]) {
    assert.equal(report.status,'passed');assert.equal(report.inputsUnchanged,true);
    assert(report.cases.every(item=>item.status==='passed'));
    assert.equal(new Set(report.cases.map(item=>item.id)).size,report.cases.length,'Duplicate atomics evidence');
  }
  assert.deepEqual(driver.counts,{cases:36,functionalExecutions:8,diagnostics:8,alignmentControls:12,optimizationPolicyCases:6});
  const driverIds=[];
  for(const language of ['c','cpp']) for(const level of ['0','2']) {
    for(const profile of ['enabled','disable-then-enable','enable-then-disable','default']) driverIds.push(`${profile}-${language}-o${level}`);
    for(const name of ['constant','symbol-offset']) driverIds.push(`misaligned-${name}-${language}-o${level}`);
    for(const name of ['reassigned','runtime-offset','conditional']) driverIds.push(`alignment-control-${name}-${language}-o${level}`);
  }
  assert.deepEqual(driver.cases.map(item=>item.id).sort(),driverIds.sort(),'Incomplete native driver matrix');
  assert.deepEqual(driver.optimizationPolicyCases.map(item=>item.id).sort(),Object.keys(queryPolicy).sort());
  for(const item of driver.optimizationPolicyCases) {
    assert.equal(item.status,'passed');assert.equal(item.ipaReference,queryPolicy[item.id]);
    assert.equal(item.command.exitCode,0);
    assert.match(item.command.stdout,new RegExp(`^\\s*-fipa-reference\\s+\\[${queryPolicy[item.id]}\\]\\s*$`,'mu'));
  }
  const sharedIds=nativeAtomicSharedCases.map(item=>item.id);
  for(const [policy,language] of policies) sharedIds.push(`atomics-native-shared-1-${language}-o2-policy-${policy}`);
  assert.deepEqual(shared.cases.map(item=>item.id).sort(),sharedIds.sort(),'Incomplete shared atomics matrix');
  assert.deepEqual(shared.counts,{cases:20,baseCases:16,optimizationControls:4,workersPerCase:2,
    ticketWindows:240,publicationPhases:60,seqCstRounds:2560});
  for(const item of shared.cases) {
    if(item.optimizationPolicy) {
      const pair=policies.find(([policy])=>policy===item.optimizationPolicy);assert(pair);
      assert.equal(item.sourceFixture,`atomics-native-shared-1-${pair[1]}-o2`);
      assert.equal(item.id,item.sourceFixture+'-policy-'+pair[0]);
    } else assert(nativeAtomicSharedCases.some(fixture=>fixture.id===item.id),'Unknown base fixture');
  }
  return expectedNativeAtomicsCounts;
}

async function identify(file) {return {path:path.resolve(file),...identity(await fs.readFile(file))};}
async function read(record,expectedPath) {
  assert(record && typeof record.path==='string','Missing atomics evidence identity');
  if(expectedPath) assert.equal(path.resolve(record.path),path.resolve(expectedPath),'Unexpected atomics evidence path');
  const bytes=await fs.readFile(record.path);
  assert.deepEqual(identity(bytes),content(record),`Changed atomics evidence: ${record.path}`);
  return bytes;
}
function locateArtifacts(report,directory) {
  // Python receipts store content identities; derive their locations from the
  // validated matrix and fixed output layout, never from recorded argv.
  const shared=report.kind==='gcc-wasi-native-atomics-shared-qualification';
  for(const item of report.cases) {
    const caseDirectory=path.join(directory,item.id);
    const cpp=item.id.includes('-cpp-o') && (shared || !/^(misaligned|alignment-control)-/u.test(item.id));
    const names={source:cpp?'main.cc':'main.c',assembly:'main.s',object:'main.o',program:'main.wasm',
      execution:'execution/execution.json',memory:'execution/memory.bin'};
    for(const [field,name] of Object.entries(names)) if(item[field]) item[field]={...item[field],path:path.join(caseDirectory,name)};
  }
  if(report.optimizationPolicySource) report.optimizationPolicySource={...report.optimizationPolicySource,path:path.join(directory,'optimization-policy.c')};
  if(report.fixtures) report.fixtures={...report.fixtures,path:path.join(directory,'fixtures.json')};
}
async function reports(aggregate,expected) {
  for(const key of ['work','sdk','gccSource','sourceLockSha256','nativeBuild']) assert(expected[key],`Missing atomics context ${key}`);
  const work=path.resolve(expected.work),sdk=path.resolve(expected.sdk);
  assert.equal(aggregate.schemaVersion,1);assert.equal(aggregate.kind,'gcc-wasi-native-atomics-qualification');
  assert.equal(aggregate.status,'passed');assert.deepEqual(aggregate.counts,expectedNativeAtomicsCounts);
  assert.deepEqual(aggregate.gccSource,expected.gccSource);
  assert.equal(aggregate.sourceLock.sha256,expected.sourceLockSha256);
  assert.deepEqual(content(aggregate.nativeBuild),content(expected.nativeBuild));
  await read(aggregate.sourceLock,path.join(here,'sources.lock.json'));
  const native=JSON.parse(await read(aggregate.nativeBuild,path.join(work,'native-build.json')));
  assert.deepEqual(native.gccSource,expected.gccSource);assert.equal(native.sourceLockSha256,expected.sourceLockSha256);
  const driver=JSON.parse(await read(aggregate.driver)),shared=JSON.parse(await read(aggregate.shared));
  verifyNativeAtomicsReportMetadata(driver,shared);
  locateArtifacts(driver,path.dirname(aggregate.driver.path));locateArtifacts(shared,path.dirname(aggregate.shared.path));
  const frozen=new Map();
  for(const report of [driver,shared]) for(const [file,record] of Object.entries(report.inputs)) {
    await read({...record,path:file},file);
    if(frozen.has(file)) assert.deepEqual(frozen.get(file),content(record),'Conflicting atomics input identities');
    frozen.set(file,content(record));
  }
  const required=[path.join(here,'sources.lock.json'),path.join(here,'build-native.sh'),
    path.join(here,'test-atomics-native.py'),path.join(here,'atomics-native-probe.c'),
    path.join(here,'test-atomics-shared-native.py'),path.join(here,'atomics-native-fixtures.mjs'),
    path.join(here,'run-libatomic-shared.mjs'),path.join(here,'test-simd-relaxed-driver.py'),
    path.join(here,'libatomic-shared-fixtures.mjs'),path.join(work,'native-build.json'),
    path.join(work,'gcc-source.json'),path.join(work,'native-driver.specs'),path.join(work,'wabt-native/provenance.json'),
    ...['xgcc','cc1','cc1plus'].map(name=>path.join(work,'gcc-native/gcc',name)),
    path.join(work,'wabt-native/wat2wasm'),path.join(sdk,'bin/wasm-ld'),
    path.join(sdk,'share/wasi-sysroot/lib/wasm32-wasi/libc.a')];
  for(const file of required) assert(frozen.has(file),`Unbound required atomics input: ${file}`);
  for(const [name,record] of Object.entries(aggregate.validators)) {
    await read(record,path.join(here,name));frozen.set(record.path,content(record));
  }
  assert.deepEqual(Object.keys(aggregate.validators).sort(),['atomics-qualification.mjs','libatomic-qualification.mjs']);
  for(const report of [driver,shared]) for(const item of report.cases) {
    await read(item.source);
    for(const field of ['assembly','object','program','execution','memory']) if(item[field]) await read(item[field]);
    if(report===driver) {
      const diagnostic=item.id.startsWith('misaligned-');
      assert.equal(item.commands[0].exitCode!==0,diagnostic);
      if(diagnostic) assert.match(item.commands[0].stderr,/requires natural 4-byte alignment/u);
      else assert(item.object && item.assembly,'Missing native compilation artifacts');
      if(/^(enabled|disable-then-enable)-/u.test(item.id)) assert(item.program,'Missing functional native program');
    } else {
      assert(['assembly','object','program','execution','memory'].every(field=>item[field]),'Missing shared native artifacts');
      const execution=JSON.parse(await read(item.execution));
      assert.equal(execution.status,'passed');assert.equal(execution.terminatedWorkers,2);
      assert(execution.overlapMilliseconds>0);assert.equal(execution.guardsUnchanged,true);assert.equal(execution.fixedMemory,true);
      const fixture=nativeAtomicSharedCases.find(f=>f.id===(item.sourceFixture||item.id));assert(fixture);
      const observation=assertNativeAtomicSharedResult(fixture,{values:execution.values,memory:await read(item.memory)});
      assert.deepEqual(execution.observation,observation);assert.deepEqual(item.observation,observation);
    }
  }
  await read(driver.optimizationPolicySource);await read(shared.fixtures);
  return {driver,shared,frozen,work,sdk};
}

export async function writeNativeAtomicsQualification(file,proofs,expected) {
  const nativeBuild=await identify(path.join(expected.work,'native-build.json'));
  const aggregate={schemaVersion:1,kind:'gcc-wasi-native-atomics-qualification',status:'passed',
    counts:expectedNativeAtomicsCounts,gccSource:expected.gccSource,
    sourceLock:await identify(path.join(here,'sources.lock.json')),nativeBuild,
    driver:await identify(proofs.driver),shared:await identify(proofs.shared),validators:{}};
  for(const name of ['atomics-qualification.mjs','libatomic-qualification.mjs']) aggregate.validators[name]=await identify(path.join(here,name));
  await reports(aggregate,expected);
  await fs.writeFile(file,JSON.stringify(aggregate,null,2)+'\n',{flag:'wx'});
  return identify(file);
}

export async function reopenNativeAtomicsQualification(file,expected) {
  const original=await identify(file),aggregate=JSON.parse(await read(original));
  const {driver,shared,frozen,work,sdk}=await reports(aggregate,expected);
  const replay=await fs.mkdtemp(path.join(os.tmpdir(),'gcc-atomics-replay-'));
  await fs.chmod(replay,0o700);
  const evidence={schemaVersion:1,kind:'gcc-wasi-native-atomics-reopen',status:'running',original,
    replayDirectory:replay,commands:[],comparisons:[]};
  const save=()=>fs.writeFile(path.join(replay,'reopen.json'),JSON.stringify(evidence,null,2)+'\n');
  try {
    const node=expected.node||process.execPath,python=expected.python||'python3';
    for(const [label,script,stored] of [['driver','test-atomics-native.py',driver],['shared','test-atomics-shared-native.py',shared]]) {
      const destination=path.join(replay,label);
      evidence.commands.push(await run(python,[path.join(here,script),'--work',work,'--sdk',sdk,
        '--node',node,'--output',destination],replay,'replay-'+label,300000));
      const fresh=JSON.parse(await fs.readFile(path.join(destination,'qualification.json'),'utf8'));
      assert.equal(fresh.status,'passed');assert.equal(fresh.inputsUnchanged,true);
      assert.deepEqual(fresh.inputs,stored.inputs,'Atomics replay used different source, tools or recipes');
      assert.deepEqual(fresh.cases.map(item=>item.id),stored.cases.map(item=>item.id));
      locateArtifacts(fresh,destination);
      for(const old of stored.cases) {
        const current=fresh.cases.find(item=>item.id===old.id);
        assert.deepEqual(content(current.source),content(old.source),'Changed exact atomics fixture source');
        if(old.assembly) {
          const assembly=await read(old.assembly),newAssembly=await read(current.assembly);
          assertLibatomicAssemblyReplay(assembly,newAssembly);
          const obj=path.join(replay,label+'-'+old.id+'.o');
          evidence.commands.push(await run(path.join(work,'wabt-native/wat2wasm'),
            ['-r','--enable-annotations','--enable-threads',old.assembly.path,'-o',obj],replay,label+'-'+old.id+'-original-assembly'));
          assert.deepEqual(identity(await fs.readFile(obj)),content(old.object),'Stored WAT no longer reproduces its exact object');
          evidence.comparisons.push({id:old.id,assemblyComparison:'complete-import-order-only',rawEqual:assembly.equals(newAssembly)});
        }
        if(old.program) assert.deepEqual(content(current.program),content(old.program),'Changed linked atomics program');
        // Ticket schedules and allowed litmus outcomes may differ. Each raw
        // memory snapshot is independently checked by the same strict oracle.
      }
      evidence[label]=await identify(path.join(destination,'qualification.json'));
    }
    const newDriver=JSON.parse(await read(evidence.driver)),newShared=JSON.parse(await read(evidence.shared));
    verifyNativeAtomicsReportMetadata(newDriver,newShared);
    for(const [input,record] of frozen) assert.deepEqual(identity(await fs.readFile(input)),record,`Atomics input changed during replay: ${input}`);
    evidence.status='passed';evidence.inputsUnchanged=true;await save();
    return {status:'passed',qualification:original,counts:expectedNativeAtomicsCounts,
      gccSource:aggregate.gccSource,nativeBuild:aggregate.nativeBuild,replay:await identify(path.join(replay,'reopen.json'))};
  } catch(error) {
    evidence.status='failed';evidence.error=String(error?.stack||error);await save();
    error.message+=`; atomics replay preserved at ${replay}`;throw error;
  }
}
