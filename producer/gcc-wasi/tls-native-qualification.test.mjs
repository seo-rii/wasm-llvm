import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeTlsSharedCases } from './tls-native-fixtures.mjs';
import { verifyNativeTlsMetadata } from './tls-native-qualification.mjs';

function reports() {
  const cases=[];
  for (const language of ['c','cpp']) for (const level of ['0','2']) {
    for (const profile of ['default','enabled','last-enabled','last-disabled','model-attribute']) cases.push({id:`${profile}-${language}-o${level}`,status:'passed'});
    for (const profile of ['pic','pie','debug','model']) cases.push({id:`reject-${profile}-${language}-o${level}`,status:'passed'});
    if (language==='cpp') for (const profile of ['constant','dynamic']) cases.push({id:`inline-${profile}-cpp-o${level}`,status:'passed'});
  }
  return [{schemaVersion:1,kind:'gcc-wasi-tls-native-driver',status:'passed',inputsUnchanged:true,
    counts:{executions:22,diagnostics:16,inlineDynamicObjectCases:2},cases},
  {schemaVersion:1,kind:'gcc-wasi-tls-native-shared',status:'passed',inputsUnchanged:true,reservedBytes:131072,
    counts:{sharedExecutions:8,translationUnits:16,workersPerExecution:2},cases:nativeTlsSharedCases.map(({id})=>({id,status:'passed'}))}];
}

test('requires the complete driver and shared ABI matrix',()=>assert.doesNotThrow(()=>verifyNativeTlsMetadata(...reports())));
test('a missing shared C++ optimization case cannot be hidden by counts',()=>{
  const [driver,shared]=reports(); shared.cases.pop(); assert.throws(()=>verifyNativeTlsMetadata(driver,shared));
});
test('duplicate IDs cannot substitute for a missing driver case',()=>{
  const [driver,shared]=reports(); driver.cases[1]={...driver.cases[0]}; assert.throws(()=>verifyNativeTlsMetadata(driver,shared));
});
test('a failed case cannot appear in a passed aggregate',()=>{
  const [driver,shared]=reports(); driver.cases[0].status='failed'; assert.throws(()=>verifyNativeTlsMetadata(driver,shared));
});
test('both suites must attest unchanged inputs',()=>{
  const [driver,shared]=reports(); shared.inputsUnchanged=false; assert.throws(()=>verifyNativeTlsMetadata(driver,shared));
});
test('unbounded or misaligned reserved arenas are rejected',()=>{
  for (const reservedBytes of [0,8193,NaN,Infinity]) {
    const [driver,shared]=reports(); shared.reservedBytes=reservedBytes; assert.throws(()=>verifyNativeTlsMetadata(driver,shared));
  }
});
