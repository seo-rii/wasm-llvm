import assert from 'node:assert/strict';
import {test} from 'node:test';
import {integerToFloatBits,convertFloatBits,saturatingFloatToInteger,conversionProfiles,cases,disabledCases,diagnosticCases} from './simd-conversions-fixtures.mjs';

test('integer conversion oracle rounds ties to even without Number precision loss',()=>{
  for(const [input,expected]of [[16777215n,0x4b7fffffn],[16777216n,0x4b800000n],[16777217n,0x4b800000n],[16777219n,0x4b800002n],[-16777217n,0xcb800000n],[2147483647n,0x4f000000n],[4294967295n,0x4f800000n]])
    assert.equal(integerToFloatBits(input,32),expected);
  assert.equal(integerToFloatBits((1n<<64n)-1n,64),0x43f0000000000000n);
  assert.equal(integerToFloatBits(-(1n<<63n),64),0xc3e0000000000000n);
  assert.equal(integerToFloatBits((1n<<53n)+1n,64),0x4340000000000000n);
  assert.equal(integerToFloatBits((1n<<53n)+3n,64),0x4340000000000002n);
});
test('float conversion oracle preserves zero, subnormals and finite tie/overflow boundaries',()=>{
  for(const [input,expected]of [[0n,0n],[0x8000000000000000n,0x80000000n],
    [0x3ff0000010000000n,0x3f800000n],[0x3ff0000030000000n,0x3f800002n],
    [0x36a0000000000000n,1n],[0x3690000000000000n,0n],[0x3690000000000001n,1n],
    [0x3810000000000000n,0x00800000n],[0x47efffffe0000000n,0x7f7fffffn],
    [0x47effffff0000000n,0x7f800000n],[0xfff0000000000000n,0xff800000n]])
    assert.equal(convertFloatBits(input,64,32),expected);
  assert.equal(convertFloatBits(1n,32,64),0x36a0000000000000n);
  assert.equal(convertFloatBits(0x80000000n,32,64),0x8000000000000000n);
  assert.equal(convertFloatBits(0x7fc12345n,32,64),'nan');
  assert.equal(convertFloatBits(0x7ff0000000000001n,64,32),'nan');
});
test('saturation oracle handles signed/unsigned limits, NaN and infinities',()=>{
  for(const [raw,signed,unsigned]of [[0x7fc12345n,0n,0n],[0x7f800000n,2147483647n,4294967295n],
    [0xff800000n,-2147483648n,0n],[0xbfc00000n,-1n,0n],[0x3fc00000n,1n,1n],
    [0x4f000000n,2147483647n,2147483648n],[0x4f800000n,2147483647n,4294967295n]]){
    assert.equal(saturatingFloatToInteger(raw,32,false),signed);
    assert.equal(saturatingFloatToInteger(raw,32,true),unsigned);
  }
  assert.equal(saturatingFloatToInteger(0x41efffffffe80000n,64,true),4294967295n);
});
test('integer IEEE oracle agrees with independent DataView conversion across deterministic samples',()=>{
  const view=new DataView(new ArrayBuffer(8));let state=0x12345678n;
  for(let index=0;index<512;index++){
    state=(state*6364136223846793005n+1442695040888963407n)&((1n<<64n)-1n);
    const input=state;view.setBigUint64(0,input,true);const number=view.getFloat64(0,true);
    view.setFloat32(0,number,true);const actual=BigInt(view.getUint32(0,true));
    const expected=convertFloatBits(input,64,32);
    if(expected==='nan')assert(Number.isNaN(view.getFloat32(0,true)));
    else assert.equal(expected,actual);
    const bits32=Number(state&0xffffffffn);view.setUint32(0,bits32,true);const small=view.getFloat32(0,true);
    view.setFloat64(0,small,true);const promoted=convertFloatBits(BigInt(bits32),32,64);
    if(promoted==='nan')assert(Number.isNaN(view.getFloat64(0,true)));
    else assert.equal(promoted,view.getBigUint64(0,true));
  }
});
test('matrix covers all 26 real conversion opcodes, exact builtin types, and separate defined controls',()=>{
  assert.equal(conversionProfiles.length,41);assert.equal(cases.length,164);assert.equal(disabledCases.length,12);
  assert.equal(new Set([...cases,...disabledCases].map(c=>c.id)).size,176);
  const opcodes=[...new Set(cases.flatMap(c=>c.requiredInstructions))].filter(opcode=>opcode!=='i8x16.shuffle');
  assert.equal(opcodes.length,26);
  assert.equal(conversionProfiles.filter(p=>p.builtin).length,8);
  assert.equal(conversionProfiles.filter(p=>p.semanticKind.startsWith('scalar-fallback')).length,4);
  for(const profile of conversionProfiles.filter(p=>p.semanticKind==='saturating-integer-narrow'))
    assert(profile.source.startsWith('i'),'Unsigned narrow still has signed wider input');
  const unsigned32=conversionProfiles.find(p=>p.builtin==='__builtin_wasm_trunc_saturate_u_i32x4_f32x4');
  assert.equal(unsigned32.result,'i32');assert.equal(unsigned32.unsignedOutput,true);
  for(const c of cases){assert(c.stdin==='3\n');assert(c.stdout.endsWith('\n'));assert(c.request.code.includes('(*volatile conversion)'));}
  for(const c of disabledCases){assert.equal(c.request.simd,false);assert.equal(c.requiredInstructions.length,0);assert(!c.builtin);}
  assert.equal(diagnosticCases.length,128);
  assert.equal(new Set(diagnosticCases.map(c=>c.id)).size,128);
  assert.deepEqual([...new Set(diagnosticCases.map(c=>c.kind))],['wrong-width','wrong-kind','too-few','too-many']);
});
