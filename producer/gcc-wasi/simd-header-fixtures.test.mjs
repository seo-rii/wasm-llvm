import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cases,apis,disabledCases,diagnosticCases,featureDiagnosticCases} from './simd-header-fixtures.mjs';
test('public header coverage retains every169 API in C/C++O0/O2 without target builtin substitutes',()=>{
 assert.equal(apis.length,169);assert.equal(cases.length,676);assert.equal(disabledCases.length,4);
 assert.equal(new Set(cases.map(f=>f.id)).size,cases.length);
 for(const api of apis){
  const selected=cases.filter(f=>f.apis.includes(api));
  assert.deepEqual(selected.map(f=>f.request.language+f.request.optimization).sort(),['c0','c2','cpp0','cpp2']);
  for(const fixture of selected){assert(fixture.request.code.includes(api+'('));assert(fixture.request.code.includes('#include <wasm_simd128.h>'));assert(!fixture.request.code.includes('__builtin_wasm_'));assert.equal(fixture.request.simd,true);}
 }
});
test('lane and shuffle macros have exact-type/value/single-evaluation tests and all three invalid index boundaries',()=>{
 const immediate=apis.filter(api=>/extract_lane|replace_lane|shuffle/.test(api));assert.equal(immediate.length,24);
 for(const api of immediate){
  for(const fixture of cases.filter(f=>f.apis.includes(api))){assert(fixture.request.code.includes('if(evaluations!='));assert(fixture.request.code.includes('take_vector(a)'));}
  const rejected=diagnosticCases.filter(f=>f.apis.includes(api));assert.equal(rejected.length,12);
  assert.deepEqual([...new Set(rejected.map(f=>f.kind))].sort(),['negative','past-end','runtime']);
  for(const fixture of rejected)assert.equal(fixture.profile,'enabled-invalid');
 }
});
test('unaligned load/store stay real operations and feature defaults are distinct rejection profiles',()=>{
 for(const api of['wasm_v128_load','wasm_v128_store'])for(const fixture of cases.filter(f=>f.apis.includes(api))){
  assert(fixture.request.code.includes('pointer(storage+1)'));assert(fixture.request.code.includes('(*volatile pointer)'));assert.deepEqual(fixture.requiredInstructions,[api==='wasm_v128_load'?'v128.load':'v128.store']);
 }
 assert.equal(diagnosticCases.length,296);assert.equal(featureDiagnosticCases.length,8);
 assert.equal(featureDiagnosticCases.filter(f=>f.profile==='default').length,4);assert.equal(featureDiagnosticCases.filter(f=>f.profile==='disabled').length,4);
 for(const fixture of disabledCases){assert.equal(fixture.request.simd,false);assert.equal(fixture.stdout,'20\n');assert(!fixture.request.code.includes('wasm_simd128.h'));}
});
test('bitwise oracles preserve raw integer/float bytes and comparison opcode signedness',()=>{
 for(const fixture of cases.filter(f=>f.semanticKind==='public-header')){
  const rows=fixture.stdout.trimEnd().split('\n');assert.equal(rows.length,16);for(const row of rows)assert.match(row,/^[a-f0-9]{32}$/);
 }
 for(const op of['lt','le','gt','ge'])for(const fixture of cases.filter(f=>f.apis.includes('wasm_i64x2_'+op)))assert.deepEqual(fixture.requiredInstructions,['i64x2.'+op+'_s']);
 const conversions=cases.filter(f=>f.semanticKind==='public-header-conversion');assert.equal(conversions.length,104);assert.equal(new Set(conversions.flatMap(f=>f.apis)).size,26);
});
