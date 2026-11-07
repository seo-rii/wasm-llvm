import assert from 'node:assert/strict';
import test from 'node:test';
import {verifyNativeAtomicsReportMetadata as verify,expectedNativeAtomicsCounts} from './atomics-qualification.mjs';
import {nativeAtomicSharedCases} from './atomics-native-fixtures.mjs';

// These records test metadata rejection only. The production gate additionally
// reopens every byte identity and actually recompiles/executes the programs.
function records() {
  const driver={kind:'gcc-wasi-atomics-backend-driver-probe',status:'passed',inputsUnchanged:true,
    counts:{cases:36,functionalExecutions:8,diagnostics:8,alignmentControls:12,optimizationPolicyCases:6},cases:[],optimizationPolicyCases:[]};
  for(const language of ['c','cpp']) for(const level of ['0','2']) {
    for(const profile of ['enabled','disable-then-enable','enable-then-disable','default']) driver.cases.push({id:`${profile}-${language}-o${level}`,status:'passed'});
    for(const kind of ['constant','symbol-offset']) driver.cases.push({id:`misaligned-${kind}-${language}-o${level}`,status:'passed'});
    for(const kind of ['reassigned','runtime-offset','conditional']) driver.cases.push({id:`alignment-control-${kind}-${language}-o${level}`,status:'passed'});
  }
  for(const [id,state] of [['baseline','enabled'],['final-disabled','enabled'],['final-enabled','disabled'],
    ['explicit-before','disabled'],['explicit-after','disabled'],['baseline-explicit-disabled','disabled']])
    driver.optimizationPolicyCases.push({id,status:'passed',ipaReference:state,command:{exitCode:0,stdout:`  -fipa-reference             [${state}]\n`}});
  const shared={kind:'gcc-wasi-native-atomics-shared-qualification',status:'passed',inputsUnchanged:true,
    counts:{cases:20,baseCases:16,optimizationControls:4,workersPerCase:2,ticketWindows:240,publicationPhases:60,seqCstRounds:2560},
    cases:nativeAtomicSharedCases.map(fixture=>({id:fixture.id,status:'passed'}))};
  for(const [policy,language] of [['explicit-before','cpp'],['explicit-after','c'],['pragma','c'],['attribute','cpp']]) {
    const sourceFixture=`atomics-native-shared-1-${language}-o2`;
    shared.cases.push({id:sourceFixture+'-policy-'+policy,sourceFixture,optimizationPolicy:policy,status:'passed'});
  }
  return {driver,shared};
}

test('metadata requires the complete driver, native shared and optimization policy matrices',()=>{
  const {driver,shared}=records();assert.deepEqual(verify(driver,shared),expectedNativeAtomicsCounts);
  driver.cases.pop();assert.throws(()=>verify(driver,shared),/Incomplete native driver matrix/);
});
test('duplicate cases cannot satisfy declared totals',()=>{
  const {driver,shared}=records();shared.cases[19]={...shared.cases[18]};
  assert.throws(()=>verify(driver,shared),/Duplicate atomics evidence/);
});
test('policy controls cannot be relabelled base fixtures or another width',()=>{
  let {driver,shared}=records();shared.cases=shared.cases.slice(0,16);
  assert.throws(()=>verify(driver,shared),/Incomplete shared atomics matrix/);
  ({driver,shared}=records());shared.cases[19].sourceFixture='atomics-native-shared-8-cpp-o2';
  assert.throws(()=>verify(driver,shared));
});
test('baseline optimization changes and explicit option bypasses are rejected',()=>{
  for(const index of [0,1,2,3,4]) {
    const {driver,shared}=records();const entry=driver.optimizationPolicyCases[index];
    entry.ipaReference=entry.ipaReference==='enabled'?'disabled':'enabled';
    assert.throws(()=>verify(driver,shared));
  }
  const {driver,shared}=records();driver.optimizationPolicyCases[3].command.stdout='  -fipa-reference-addressable [disabled]\n';
  assert.throws(()=>verify(driver,shared));
});
test('partial runs, changed inputs and forged totals are never qualification',()=>{
  for(const mutate of [
    ({driver})=>{driver.inputsUnchanged=false;},
    ({shared})=>{shared.status='running';},
    ({shared})=>{shared.cases[0].status='failed';},
    ({driver})=>{driver.counts.cases=4;},
    ({shared})=>{shared.counts.workersPerCase=1;},
  ]) {const value=records();mutate(value);assert.throws(()=>verify(value.driver,value.shared));}
});
