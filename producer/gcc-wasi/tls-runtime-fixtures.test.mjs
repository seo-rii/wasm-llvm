import assert from 'node:assert/strict';
import test from 'node:test';
import { tlsRuntimeCases, tlsRuntimeOrdinaryCases, tlsRuntimeSharedCases,
  assertTlsRuntimeOrdinaryResult, assertTlsRuntimeSharedResult } from './tls-runtime-fixtures.mjs';

function memoryFor(kind) {
  const fixture=tlsRuntimeSharedCases.find(value=>value.kind===kind),memory=new Uint8Array(16384);
  const result={values:[128,128],memory,tlsRegions:[{low:8192,high:10240},{low:12288,high:14336}]};
  const view=new DataView(memory.buffer,128),put=(index,value)=>view.setUint32(index*4,value,true);
  if(kind==='tls-errno-shared')for(let id=0;id<2;id++)
    [result.tlsRegions[id].low,result.tlsRegions[id].low,128,0,id?17:2147483647,id?701:68].forEach((value,i)=>put(id*6+i,value));
  if(kind==='tls-inline-shared')for(let id=0;id<2;id++) {
    const address=result.tlsRegions[id].low;
    [2,2,21,20,address,address+4,address,address+4,0].forEach((value,i)=>put(id*9+i,value));
  }
  if(kind==='tls-gnu-shared') {
    [0x544c5347,2,2112,513].forEach((value,i)=>put(i,value));
    for(let id=0;id<2;id++) {
      const address=result.tlsRegions[id].low,offset=4+id*528;
      [0,id,address,address,2,516,513,64,32,id?0:68,id?701:0,48].forEach((value,i)=>put(offset+i,value));
      [512,9000,...Array.from({length:512},(_,i)=>511-i),10001,10000].forEach((value,i)=>put(offset+12+i,value));
    }
  }
  return {fixture,result,put};
}

test('the matrix covers each exit mode and both inline translation-unit profiles',()=>{
  assert.equal(new Set(tlsRuntimeCases.map(value=>value.id)).size,32);
  assert.equal(tlsRuntimeOrdinaryCases.length,24);assert.equal(tlsRuntimeSharedCases.length,8);
  assert.equal(tlsRuntimeCases.filter(value=>value.request.sources?.length===1).length,4);
  assert.equal(tlsRuntimeCases.filter(value=>value.request.longDouble).length,4);
});
test('ordinary oracle requires exact output, status and actual abort trap',()=>{
  const fixture=tlsRuntimeOrdinaryCases.find(value=>value.kind==='tls-long-double-ordinary');
  assertTlsRuntimeOrdinaryResult(fixture,fixture.expected);
  assert.throws(()=>assertTlsRuntimeOrdinaryResult(fixture,{...fixture.expected,stdout:fixture.expected.stdout.replace('68','0')}));
  assert.throws(()=>assertTlsRuntimeOrdinaryResult(fixture,{...fixture.expected,stderr:'unexpected'}));
  assert.throws(()=>assertTlsRuntimeOrdinaryResult(fixture,{...fixture.expected,exitCode:1}));
  const abort=tlsRuntimeOrdinaryCases.find(value=>value.expected.trap);
  assert.throws(()=>assertTlsRuntimeOrdinaryResult(abort,{...abort.expected,trap:false}));
});
test('actual errno observations reject contamination, shortened rounds and aliasing',()=>{
  const {fixture,result,put}=memoryFor('tls-errno-shared');assertTlsRuntimeSharedResult(fixture,result);
  put(11,68);assert.throws(()=>assertTlsRuntimeSharedResult(fixture,result));put(11,701);
  put(8,127);assert.throws(()=>assertTlsRuntimeSharedResult(fixture,result));put(8,128);
  put(6,8192);put(7,8192);assert.throws(()=>assertTlsRuntimeSharedResult(fixture,result));
});
test('GNU list oracle rejects 128-entry caps and registration-during-cleanup loss',()=>{
  const {fixture,result,put}=memoryFor('tls-gnu-shared');assertTlsRuntimeSharedResult(fixture,result);
  put(9,128);assert.throws(()=>assertTlsRuntimeSharedResult(fixture,result));put(9,516);
  put(17,511);assert.throws(()=>assertTlsRuntimeSharedResult(fixture,result));put(17,9000);
  put(15,0);assert.throws(()=>assertTlsRuntimeSharedResult(fixture,result));
});
test('inline shared oracle requires coalescing, one construction and exact LIFO cleanup',()=>{
  const {fixture,result,put}=memoryFor('tls-inline-shared');assertTlsRuntimeSharedResult(fixture,result);
  put(0,4);assert.throws(()=>assertTlsRuntimeSharedResult(fixture,result));put(0,2);
  put(6,8200);assert.throws(()=>assertTlsRuntimeSharedResult(fixture,result));put(6,8192);
  put(2,20);assert.throws(()=>assertTlsRuntimeSharedResult(fixture,result));
});
test('shared results require copied memory, common bounded pointers and actual TLS regions',()=>{
  const {fixture,result}=memoryFor('tls-inline-shared');
  for(const changed of [{values:[128,132]},{values:[16380,16380]},{tlsRegions:[]},{memory:new SharedArrayBuffer(16384)}])
    assert.throws(()=>assertTlsRuntimeSharedResult(fixture,{...result,...changed}));
});
