import assert from 'node:assert/strict';
import test from 'node:test';
import {nativeAtomicSharedCases as cases, nativeAtomicLayout as layout, assertNativeAtomicSharedResult as validate} from './atomics-native-fixtures.mjs';

// Synthetic oracle inputs test rejection behavior only. They are never
// execution receipts or substitutes for two actual guest Workers.
function synthetic(fixture, {sequential=false}={}) {
  const address=1024, memory=new Uint8Array(address+layout.bytes+16);
  const view=new DataView(memory.buffer,address,layout.bytes);
  const put=(offset,n)=>view.setUint32(offset,n,true);
  const put64=(offset,n)=>{put(offset,Number(n&0xffffffffn));put(offset+4,Number(n>>32n));};
  [layout.magic,fixture.width,2,64,layout.bytes,layout.version].forEach((n,i)=>put(i*4,n));
  const base=1n<<BigInt(fixture.width*8-1), mask=(1n<<BigInt(fixture.width*8))-1n;
  for(let scenario=0;scenario<2;scenario++) for(let order=0;order<6;order++) {
    const index=scenario*6+order;
    put64(layout.final+index*8,(base+128n)&mask);
    put(layout.batches+index*4,fixture.minimumBatches);
    put(layout.interleaved+index*4,1);
    put(layout.transitions+index*4,sequential?1:127);
    for(let worker=0;worker<2;worker++) {
      put(layout.forcedFailures+(order*2+worker)*4,fixture.minimumBatches);
      for(let i=0;i<64;i++) put64(layout.tickets+(((index*2+worker)*64+i)*8),base+BigInt(sequential?worker*64+i:i*2+worker));
    }
  }
  for(let i=0;i<6;i++) put(layout.messages+i*4,64);
  put(layout.litmus+4,64);put(layout.litmus+8,63);put(layout.litmus+12,1);
  return {result:{values:[address,address],memory},view,put,put64};
}

test('native widths cover C/C++ O0/O2 with guest-only operations and a bounded cohort',()=>{
  assert.equal(cases.length,16);assert.equal(new Set(cases.map(f=>f.id)).size,16);
  for(const width of [1,2,4,8]) assert.deepEqual(cases.filter(f=>f.width===width).map(f=>f.request.language+f.request.optimization),['c0','c2','cpp0','cpp2']);
  for(const fixture of cases) {
    assert.equal(fixture.request.atomics,true);
    assert.deepEqual(fixture.request.sharedMemory,{entry:'probe_entry',initialPages:4,maximumPages:4});
    assert.deepEqual(fixture.run.workerArguments,[[0,2,64],[1,2,64]]);
    assert.equal(fixture.run.stackBytes,32768);
    assert.deepEqual(fixture.requiredSymbols,[]);
    assert(!fixture.request.code.includes('__atomic_load_16'));
    assert(!fixture.request.code.includes('Atomics.'));
    const actual=validate(fixture,synthetic(fixture).result);
    assert.equal(actual.windows.length,12);
    assert(actual.windows.every(window=>window.transitions===127));
    assert.deepEqual(actual.messages,[[64,64],[64,64],[64,64]]);
    assert.deepEqual(actual.litmus,[0,64,63,1]);
  }
});

test('one or both sequential worker ranges never qualify as contention',()=>{
  const fixture=cases[0];
  assert.throws(()=>validate(fixture,synthetic(fixture,{sequential:true}).result),/sequential-only ticket ranges/);
  const data=synthetic(fixture);data.put(layout.interleaved,0);
  assert.throws(()=>validate(fixture,data.result),/missing bounded contention evidence/);
});

test('duplicate, out-of-window, reordered and truncated tickets are rejected',()=>{
  const fixture=cases[0];
  let data=synthetic(fixture);data.put64(layout.tickets+8,128n);
  assert.throws(()=>validate(fixture,data.result),/invalid or duplicate ticket/);
  data=synthetic(fixture);data.put64(layout.tickets,127n);
  assert.throws(()=>validate(fixture,data.result),/invalid or duplicate ticket/);
  data=synthetic(fixture);data.put64(layout.tickets,130n);data.put64(layout.tickets+8,128n);
  assert.throws(()=>validate(fixture,data.result),/reordered worker tickets/);
  data=synthetic(fixture);data.result.memory=data.result.memory.subarray(0,1024+layout.bytes-1);
  assert.throws(()=>validate(fixture,data.result),/outside memory/);
});

test('64-bit ticket oracle preserves the high bit and byte-width wraparound',()=>{
  const wide=cases.find(f=>f.width===8), narrow=cases[0];
  assert.equal(validate(wide,synthetic(wide).result).windows[0].tickets[0][0],'9223372036854775808');
  const data=synthetic(wide);data.put(layout.final+4,0);
  assert.throws(()=>validate(wide,data.result),/wrong final counter/);
  const wrapped=synthetic(narrow);assert.equal(wrapped.view.getUint32(layout.final,true),0);
  validate(narrow,wrapped.result);
});

test('actual guest failures, missing CAS updates and inconsistent metrics fail closed',()=>{
  const fixture=cases[0];
  for(const [offset,value,reason] of [
    [24,8,/guest failure codes/],
    [layout.forcedFailures,0,/missing failed-CAS expected updates/],
    [layout.transitions,2,/incorrect interleaving metric/],
    [layout.batches,65,/missing bounded contention evidence/],
    [layout.batches,fixture.minimumBatches-1,/missing bounded contention evidence/],
  ]) {const data=synthetic(fixture);data.put(offset,value);assert.throws(()=>validate(fixture,data.result),reason);}
});

test('publication and seq_cst phases require complete observations and forbid 00',()=>{
  const fixture=cases[0];
  for(const [offset,value,reason] of [
    [layout.messages,63,/incomplete publication phases/],
    [layout.litmus,1,/forbidden or incomplete seq_cst/],
    [layout.litmus+4,63,/forbidden or incomplete seq_cst/],
  ]) {const data=synthetic(fixture);data.put(offset,value);assert.throws(()=>validate(fixture,data.result),reason);}
});

test('cohort identity and bounds are checked before reading memory',()=>{
  const fixture=cases[0];
  let data=synthetic(fixture);data.result.values=[1024,1028];
  assert.throws(()=>validate(fixture,data.result),/one valid result address/);
  data=synthetic(fixture);data.result.values=[1025,1025];
  assert.throws(()=>validate(fixture,data.result),/outside memory/);
  data=synthetic(fixture);data.put(4,16);
  assert.throws(()=>validate(fixture,data.result),/invalid result layout/);
  data=synthetic(fixture);data.result.memory=null;
  assert.throws(()=>validate(fixture,data.result),/missing final memory copy/);
});
