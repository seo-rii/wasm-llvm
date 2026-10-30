// Public GCC wasm_simd128.h qualification. Integer expectations use BigInt;
// floating arithmetic inputs are exact dyadic values. No fixture implements an
// intrinsic as its own compiler fallback.
import {cases as conversionCases} from './simd-conversions-fixtures.mjs';
const shapes = [
  ['i8x16','int8_t',8,true],['u8x16','uint8_t',8,false],
  ['i16x8','int16_t',16,true],['u16x8','uint16_t',16,false],
  ['i32x4','int32_t',32,true],['u32x4','uint32_t',32,false],
  ['i64x2','int64_t',64,true],['u64x2','uint64_t',64,false],
  ['f32x4','float',32,false,true],['f64x2','double',64,false,true]
].map(([id,c,bits,signed,floating=false])=>({id,c,bits,signed,floating,lanes:128/bits}));
const byShape=Object.fromEntries(shapes.map(x=>[x.id,x]));
const integerShapes=shapes.filter(x=>!x.floating&&x.signed),floatShapes=shapes.filter(x=>x.floating);
const profiles=[];
const view=new DataView(new ArrayBuffer(8));
const asBits=(n,bits)=>{if(bits===32){view.setFloat32(0,n,true);return BigInt(view.getUint32(0,true));}view.setFloat64(0,n,true);return view.getBigUint64(0,true);};
const asNumber=(raw,bits)=>{if(bits===32){view.setUint32(0,Number(raw),true);return view.getFloat32(0,true);}view.setBigUint64(0,raw,true);return view.getFloat64(0,true);};
const rawInteger=(n,bits)=>BigInt.asUintN(bits,n);
const number=(n,type)=>type.floating?asNumber(n,type.bits):type.signed?BigInt.asIntN(type.bits,n):n;
function bytes(values,bits){return values.flatMap(raw=>Array.from({length:bits/8},(_,i)=>Number((BigInt.asUintN(bits,raw)>>BigInt(8*i))&255n)));}
function inputRows(type,side,comparison=false){
  let samples;
  if(type.floating){samples=[-0,0,1,-1,.5,-.5,2,-2,8,-8,16,32,.25,-.25,64,-64].map(x=>asBits(x,type.bits));
    if(comparison)samples=[...samples.slice(0,10),asBits(Infinity,type.bits),asBits(-Infinity,type.bits),asBits(NaN,type.bits),asBits(NaN,type.bits)|(1n<<BigInt(type.bits-1)),1n,1n<<BigInt(type.bits-1)];
  }else{const half=1n<<BigInt(type.bits-1),max=2n*half-1n;samples=[0n,1n,2n,3n,half-1n,half,half+1n,max,max-1n,max-2n,127n,128n,255n,256n,0x123456789abcdef0n,0xfedcba9876543210n].map(x=>rawInteger(x,type.bits));}
  return Array.from({length:16},(_,row)=>Array.from({length:type.lanes},(_,lane)=>samples[(row*3+lane*5+side*7)%samples.length]));
}
const countSamples=[0,1,7,8,15,16,31,32,63,64,65,127,128,255,256,4294967295];
function add(api,type,body,expected,requiredInstructions=[],options={}){
  profiles.push({id:api.slice(5),api,type,body,expected,requiredInstructions,evaluations:2,...options});
}
for(const type of shapes){
 const {id,c,bits,lanes,floating}=type;
 const selected=Array.from({length:lanes},(_,i)=>i%2?`y[${(i*3)%lanes}]`:`x[${lanes-1-i}]`);
 add(`wasm_${id}_make`,type,`return wasm_${id}_make(${selected.map(v=>`take_scalar(${v})`).join(',')});`,
  (a,b)=>Array.from({length:lanes},(_,i)=>i%2?b[(i*3)%lanes]:a[lanes-1-i]),[],{evaluations:lanes,comparison:true});
 add(`wasm_${id}_splat`,type,`return wasm_${id}_splat(take_scalar(x[0]));`,a=>Array(lanes).fill(a[0]),[`${id[0]==='u'?'i'+id.slice(1):id}.splat`],{evaluations:1,comparison:true});
 const extractApi=`wasm_${id}_extract_lane`;
 const scalarStore=floating?`${c} value=${extractApi}(take_vector(a),${lanes-1});`:
   `${type.signed?'int64_t':'uint64_t'} value=${extractApi}(take_vector(a),${lanes-1});`;
 add(extractApi,type,`${scalarStore}\n  v128_t result={0}; memcpy(&result,&value,sizeof(value)); return result;`,
  a=>{const n=number(a[lanes-1],type);return floating?[a[lanes-1],...Array(lanes-1).fill(0n)]:bytes([rawInteger(n,64),0n],64);},
  [`${id[0]==='u'?'i'+id.slice(1):id}.extract_lane${!floating&&bits<32?type.signed?'_s':'_u':''}`],
  {evaluations:1,comparison:true,byteExpected:!floating,resultTypeCheck:`${extractApi}(a,0)`,resultCType:c});
 const replaceApi=`wasm_${id}_replace_lane`;
 add(replaceApi,type,`v128_t replaced=${replaceApi}(take_vector(a),0,take_scalar(y[0]));\n  return ${replaceApi}(take_vector(replaced),${lanes-1},take_scalar(y[${lanes-1}]));`,
  (a,b)=>a.map((value,i)=>i===0||i===lanes-1?b[i]:value),[`${id[0]==='u'?'i'+id.slice(1):id}.replace_lane`],{evaluations:4,comparison:true});
}
for(const type of integerShapes){
 const {id,bits}=type;
 for(const [op,symbol]of [['add','+'],['sub','-'],...(bits===8?[]:[['mul','*']])])
  add(`wasm_${id}_${op}`,type,`return wasm_${id}_${op}(take_vector(a),take_vector(b));`,
   (a,b)=>a.map((x,i)=>rawInteger(symbol==='+'?x+b[i]:symbol==='-'?x-b[i]:x*b[i],bits)),[`${id}.${op}`]);
 add(`wasm_${id}_neg`,type,`return wasm_${id}_neg(take_vector(a));`,a=>a.map(x=>rawInteger(-x,bits)),[`${id}.neg`],{evaluations:1});
 for(const unsigned of [false,true]){
  const shape=unsigned?'u'+id.slice(1):id;
  add(`wasm_${shape}_shr`,type,`return wasm_${shape}_shr(take_vector(a),take_count(count));`,
   (a,b,count)=>a.map(x=>rawInteger((unsigned?x:BigInt.asIntN(bits,x))>>BigInt(count%(bits)),bits)),[`${id}.shr_${unsigned?'u':'s'}`]);
 }
 add(`wasm_${id}_shl`,type,`return wasm_${id}_shl(take_vector(a),take_count(count));`,
  (a,b,count)=>a.map(x=>rawInteger(x<<BigInt(count%bits),bits)),[`${id}.shl`]);
}
for(const type of floatShapes){
 const {id,bits}=type;
 for(const op of ['add','sub','mul','div','neg']){
  const arity=op==='neg'?1:2;
  const bRows=op==='div'?Array.from({length:16},(_,row)=>Array.from({length:type.lanes},(_,lane)=>asBits([.5,-.5,2,-2,4,-4,8,-8][(row+lane)%8],bits))):undefined;
  add(`wasm_${id}_${op}`,type,`return wasm_${id}_${op}(take_vector(a)${arity===2?',take_vector(b)':''});`,
   (a,b)=>a.map((raw,i)=>{const x=asNumber(raw,bits),y=asNumber(b[i],bits);return asBits(op==='add'?x+y:op==='sub'?x-y:op==='mul'?x*y:op==='div'?x/y:-x,bits);}),[`${id}.${op}`],{evaluations:arity,bRows});
 }
}
for(const type of shapes){
 if(!type.floating&&!type.signed&&type.bits===64)continue;
 const {id,bits}=type,ops=!type.floating&&!type.signed?['lt','le','gt','ge']:['eq','ne','lt','le','gt','ge'];
 for(const op of ops){
  const opcodeShape=id[0]==='u'?'i'+id.slice(1):id;
  const suffix=type.floating||op==='eq'||op==='ne'?'':type.signed?'_s':'_u';
  add(`wasm_${id}_${op}`,type,`return wasm_${id}_${op}(take_vector(a),take_vector(b));`,(a,b)=>a.map((raw,i)=>{
   const x=number(raw,type),y=number(b[i],type),truth=op==='eq'?x===y:op==='ne'?x!==y:op==='lt'?x<y:op==='le'?x<=y:op==='gt'?x>y:x>=y;
   return truth?(1n<<BigInt(bits))-1n:0n;
  }),[`${opcodeShape}.${op}${suffix}`],{comparison:true});
 }
}
for(const op of ['and','or','xor','not']){
 const type=byShape.u8x16;
 add(`wasm_v128_${op}`,type,`return wasm_v128_${op}(take_vector(a)${op==='not'?'':',take_vector(b)'});`,
  (a,b)=>a.map((x,i)=>op==='and'?x&b[i]:op==='or'?x|b[i]:op==='xor'?x^b[i]:255n^x),[`v128.${op}`],{evaluations:op==='not'?1:2});
}
for(const type of shapes.filter(x=>!x.floating&&x.bits<32))for(const op of ['add','sub']){
 const{id,bits,signed}=type,min=signed?-(1n<<BigInt(bits-1)):0n,max=signed?(1n<<BigInt(bits-1))-1n:(1n<<BigInt(bits))-1n;
 add(`wasm_${id}_${op}_sat`,type,`return wasm_${id}_${op}_sat(take_vector(a),take_vector(b));`,
  (a,b)=>a.map((raw,i)=>{const x=number(raw,type),y=number(b[i],type),v=op==='add'?x+y:x-y;return rawInteger(v<min?min:v>max?max:v,bits);}),[`i${id.slice(1)}.${op}_sat_${signed?'s':'u'}`]);
}
for(const type of integerShapes){
 const{id,lanes}=type,indices=Array.from({length:lanes},(_,i)=>i%2?lanes+(i*3)%lanes:lanes-1-i);
 add(`wasm_${id}_shuffle`,type,`return wasm_${id}_shuffle(take_vector(a),take_vector(b),${indices.join(',')});`,
  (a,b)=>indices.map(index=>[...a,...b][index]),['i8x16.shuffle']);
}
add('wasm_v128_load',byShape.u8x16,'unsigned char storage[33]; memcpy(storage+1,&a,16); return wasm_v128_load(pointer(storage+1));',a=>a,['v128.load'],{evaluations:1});
add('wasm_v128_store',byShape.u8x16,'unsigned char storage[33]; memset(storage,0,sizeof(storage)); wasm_v128_store(pointer(storage+1),take_vector(a));\n  v128_t result; memcpy(&result,storage+1,16); return result;',a=>a,['v128.store'],{evaluations:2});
function makeCoreCase(profile,language,optimization){
 const{type}=profile,rowsA=inputRows(type,0,profile.comparison),rowsB=profile.bRows||inputRows(type,1,profile.comparison);
 const outputs=rowsA.map((a,i)=>{const values=profile.expected(a,rowsB[i],countSamples[i]);return(profile.byteExpected?values:bytes(values,type.bits)).map(x=>x.toString(16).padStart(2,'0')).join('');});
 const data=(rows,name)=>`static const unsigned char ${name}[16][16]={${rows.map(row=>'{'+bytes(row,type.bits).join(',')+'}').join(',')}};`;
 const typeCheck=profile.resultTypeCheck?`#ifdef __cplusplus\n  static_assert(__is_same(__typeof__(${profile.resultTypeCheck}),${profile.resultCType}),"exact scalar result");\n#else\n  _Static_assert(__builtin_types_compatible_p(__typeof__(${profile.resultTypeCheck}),${profile.resultCType}),"exact scalar result");\n#endif\n`:'';
 return{id:`simd-header-${profile.id}-${language}-o${optimization}`,apis:[profile.api],semanticKind:'public-header',
  request:{language,standard:language==='cpp'?'gnu++17':'gnu11',optimization,simd:true,
   code:`#include <wasm_simd128.h>\n#include <stdio.h>\n#include <string.h>\n#ifndef __wasm_simd128__\n#error SIMD feature macro missing\n#endif\ntypedef ${type.c} I __attribute__((vector_size(16)));\n${data(rowsA,'inputs_a')}\n${data(rowsB,'inputs_b')}\nstatic const uint32_t counts[16]={${countSamples.map(x=>x+'U').join(',')}};\nstatic unsigned evaluations;\nstatic v128_t take_vector(v128_t value){++evaluations;return value;}\nstatic ${type.c} take_scalar(${type.c} value){++evaluations;return value;}\nstatic uint32_t take_count(uint32_t value){++evaluations;return value;}\nstatic void *take_pointer(void *value){++evaluations;return value;}\nstatic void *(*volatile pointer)(void *)=take_pointer;\n__attribute__((noinline)) static v128_t convert(v128_t a,v128_t b,uint32_t count){\n  I x=(I)a,y=(I)b;\n${typeCheck}  ${profile.body}\n}\nstatic v128_t (*volatile intrinsic)(v128_t,v128_t,uint32_t)=convert;\nint main(void){\n  unsigned rotation; if(scanf("%u",&rotation)!=1||rotation>=16)return 2;\n  for(unsigned row=0;row<16;row++){unsigned index=(row+rotation)%16;v128_t a,b;memcpy(&a,inputs_a[index],16);memcpy(&b,inputs_b[index],16);evaluations=0;\n    v128_t result=intrinsic(a,b,counts[index]);if(evaluations!=${profile.evaluations})return 3;\n    unsigned char output[16];memcpy(output,&result,16);for(unsigned lane=0;lane<16;lane++)printf("%02x",output[lane]);putchar('\\n');\n  }\n  return 0;\n}\n`},
  stdin:'3\n',stdout:Array.from({length:16},(_,i)=>outputs[(i+3)%16]).join('\n')+'\n',requiredInstructions:profile.requiredInstructions,forbiddenInstructions:[]};
}
const conversionNames={
 'trunc-sat-f32-s':'wasm_i32x4_trunc_sat_f32x4','trunc-sat-f32-u':'wasm_u32x4_trunc_sat_f32x4',
 'trunc-sat-f64-s':'wasm_i32x4_trunc_sat_f64x2_zero','trunc-sat-f64-u':'wasm_u32x4_trunc_sat_f64x2_zero',
 'narrow-i16-s':'wasm_i8x16_narrow_i16x8','narrow-i16-u':'wasm_u8x16_narrow_i16x8',
 'narrow-i32-s':'wasm_i16x8_narrow_i32x4','narrow-i32-u':'wasm_u16x8_narrow_i32x4',
 'convert-i32-f32':'wasm_f32x4_convert_i32x4','convert-u32-f32':'wasm_f32x4_convert_u32x4',
 'convert-i32-f64-low':'wasm_f64x2_convert_low_i32x4','convert-u32-f64-low':'wasm_f64x2_convert_low_u32x4',
 'promote-f32-low':'wasm_f64x2_promote_low_f32x4','demote-f64-zero':'wasm_f32x4_demote_f64x2_zero'
};
for(const bits of[8,16,32])for(const sign of['i','u'])for(const half of['low','high'])
 conversionNames[`extend-${sign}${bits}-${half}`]=`wasm_${sign}${bits*2}x${64/bits}_extend_${half}_${sign}${bits}x${128/bits}`;
const converted=conversionCases.flatMap(fixture=>{
 const profile=fixture.id.replace(/^simd-convert-/,'').replace(/-(?:c|cpp)-o[02]$/,'');
 const api=conversionNames[profile];if(!api)return[];
 let code=fixture.request.code.replace('#include <stdio.h>','#include <wasm_simd128.h>\n#include <stdio.h>');
 code=code.replace(/#ifdef __cplusplus\nstatic_assert\([\s\S]*?#endif\n/,'');
 const second=/static R convert\(I a, I b\)/.test(code);
 const pattern=/(__attribute__\(\(noinline\)\) static R convert\([^\n]+\) \{\n)[\s\S]*?\n\}\nstatic R \(\*volatile conversion\)/;
 if(!pattern.test(code))throw new Error('Cannot locate conversion function '+fixture.id);
 code=code.replace(pattern,`$1  return (R)${api}((v128_t)a${second?',(v128_t)b':''});\n}\nstatic R (*volatile conversion)`);
 return[{...fixture,id:fixture.id.replace('simd-convert-','simd-header-convert-'),apis:[api],builtin:undefined,semanticKind:'public-header-conversion',request:{...fixture.request,code}}];
});
export const cases=[...profiles.flatMap(profile=>['c','cpp'].flatMap(language=>['0','2'].map(optimization=>makeCoreCase(profile,language,optimization)))),...converted];
export const apis=[...new Set(cases.flatMap(fixture=>fixture.apis))].sort();
export const disabledCases=['c','cpp'].flatMap(language=>['0','2'].map(optimization=>({id:`simd-header-scalar-disabled-${language}-o${optimization}`,apis:[],request:{language,standard:language==='cpp'?'gnu++17':'gnu11',optimization,simd:false,code:'#include <stdio.h>\n#ifdef __wasm_simd128__\n#error Disabled SIMD feature macro unexpectedly defined\n#endif\nint main(void){unsigned a,b;if(scanf("%u %u",&a,&b)!=2)return 1;printf("%u\\n",a+b);return 0;}\n'},stdin:'3 17\n',stdout:'20\n',requiredInstructions:[],forbiddenInstructions:[]})));
const invalid=[];
for(const type of shapes)for(const op of['extract_lane','replace_lane'])for(const kind of['runtime','negative','past-end']){
 const api=`wasm_${type.id}_${op}`,index=kind==='runtime'?'index':kind==='negative'?'-1':String(type.lanes);
 invalid.push({id:`${api}-${kind}`,api,kind,code:`v128_t rejected(v128_t a,int index){\n  ${op==='extract_lane'?`${type.c} value=${api}(a,${index}); return wasm_${type.id}_splat(value);`:`return ${api}(a,${index},(${type.c})1);`}\n}\n`});
}
for(const type of integerShapes)for(const kind of['runtime','negative','past-end']){
 const api=`wasm_${type.id}_shuffle`,indices=Array.from({length:type.lanes},(_,i)=>String(i));indices[0]=kind==='runtime'?'index':kind==='negative'?'-1':String(2*type.lanes);
 invalid.push({id:`${api}-${kind}`,api,kind,code:`v128_t rejected(v128_t a,v128_t b,int index){return ${api}(a,b,${indices.join(',')});}\n`});
}
const immediateDiagnosticCases=invalid.flatMap(profile=>['c','cpp'].flatMap(language=>['0','2'].map(optimization=>({id:`simd-header-${profile.id}-${language}-o${optimization}`,apis:[profile.api],kind:profile.kind,profile:'enabled-invalid',diagnosticPattern:'constant|range|bounds|lane|index',request:{language,standard:language==='cpp'?'gnu++17':'gnu11',optimization,simd:true,code:'#include <wasm_simd128.h>\n'+profile.code},stdin:''}))));
export const featureDiagnosticCases=['c','cpp'].flatMap(language=>['0','2'].flatMap(optimization=>['disabled','default'].map(profile=>({id:`simd-header-feature-${profile}-${language}-o${optimization}`,apis:[],profile,diagnosticPattern:'requires.*simd128|SIMD128.*disabled',request:{language,standard:language==='cpp'?'gnu++17':'gnu11',optimization,simd:false,code:'#include <wasm_simd128.h>\nv128_t live(v128_t a,v128_t b){return wasm_i32x4_add(a,b);}\n'},stdin:''}))));

export const diagnosticCases=[...immediateDiagnosticCases,...featureDiagnosticCases];
