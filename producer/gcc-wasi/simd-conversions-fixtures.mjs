// Source-level SIMD conversion qualification. Expected IEEE encodings and
// saturating integer values are computed with BigInt, independently of GCC.
const laneTypes = {
  i8: { c: 'signed char', bits: 8, signed: true },
  u8: { c: 'unsigned char', bits: 8, signed: false },
  i16: { c: 'short', bits: 16, signed: true },
  u16: { c: 'unsigned short', bits: 16, signed: false },
  i32: { c: 'int', bits: 32, signed: true },
  u32: { c: 'unsigned int', bits: 32, signed: false },
  i64: { c: 'long long', bits: 64, signed: true },
  u64: { c: 'unsigned long long', bits: 64, signed: false },
  f32: { c: 'float', bits: 32, floating: true },
  f64: { c: 'double', bits: 64, floating: true }
};
const rotation = 3;
const profiles = [];
const bitLength = value => value === 0n ? 0 : value.toString(2).length;
function roundShift(value, shift) {
  if (shift <= 0) return value << BigInt(-shift);
  const n = BigInt(shift), whole = value >> n, remainder = value - (whole << n);
  const halfway = 1n << (n - 1n);
  return whole + (remainder > halfway || (remainder === halfway && (whole & 1n)) ? 1n : 0n);
}
export function integerToFloatBits(value, bits) {
  value = BigInt(value);
  const fractionBits = bits === 32 ? 23 : 52, bias = bits === 32 ? 127 : 1023;
  const sign = value < 0n ? 1n << BigInt(bits - 1) : 0n;
  if (value < 0n) value = -value;
  if (value === 0n) return sign;
  let exponent = bitLength(value) - 1;
  let significand = roundShift(value, exponent - fractionBits);
  if (significand === 1n << BigInt(fractionBits + 1)) { significand >>= 1n; ++exponent; }
  return sign | (BigInt(exponent + bias) << BigInt(fractionBits)) | (significand - (1n << BigInt(fractionBits)));
}
function decodeFloat(raw, bits) {
  raw = BigInt(raw);
  const fractionBits = bits === 32 ? 23 : 52, exponentBits = bits === 32 ? 8 : 11;
  const exponentMask = (1n << BigInt(exponentBits)) - 1n;
  const fractionMask = (1n << BigInt(fractionBits)) - 1n;
  const exponent = Number((raw >> BigInt(fractionBits)) & exponentMask), fraction = raw & fractionMask;
  const bias = (1 << (exponentBits - 1)) - 1;
  return { sign: raw >> BigInt(bits - 1), special: exponent === Number(exponentMask), nan: exponent === Number(exponentMask) && fraction !== 0n,
    significand: fraction | (exponent && exponent !== Number(exponentMask) ? 1n << BigInt(fractionBits) : 0n),
    power: (exponent ? exponent - bias : 1 - bias) - fractionBits };
}
export function convertFloatBits(raw, fromBits, toBits) {
  const input = decodeFloat(raw, fromBits);
  const fractionBits = toBits === 32 ? 23 : 52, bias = toBits === 32 ? 127 : 1023;
  const sign = input.sign << BigInt(toBits - 1);
  const infinity = BigInt(toBits === 32 ? 255 : 2047) << BigInt(fractionBits);
  if (input.nan) return 'nan'; // Wasm does not select one NaN payload.
  if (input.special) return sign | infinity;
  if (!input.significand) return sign;
  let exponent = input.power + bitLength(input.significand) - 1;
  if (exponent > bias) return sign | infinity;
  if (exponent < 1 - bias) {
    const mantissa = roundShift(input.significand, (1 - bias - fractionBits) - input.power);
    return sign | mantissa; // Rounding can carry into the minimum normal value.
  }
  let significand = roundShift(input.significand, bitLength(input.significand) - 1 - fractionBits);
  if (significand === 1n << BigInt(fractionBits + 1)) { significand >>= 1n; ++exponent; }
  if (exponent > bias) return sign | infinity;
  return sign | (BigInt(exponent + bias) << BigInt(fractionBits)) | (significand - (1n << BigInt(fractionBits)));
}
export function saturatingFloatToInteger(raw, fromBits, unsigned) {
  const input = decodeFloat(raw, fromBits), minimum = unsigned ? 0n : -(1n << 31n);
  const maximum = unsigned ? (1n << 32n) - 1n : (1n << 31n) - 1n;
  if (input.nan) return 0n;
  if (input.special) return input.sign ? minimum : maximum;
  let integer = input.power >= 0 ? input.significand << BigInt(input.power) : input.significand >> BigInt(-input.power);
  if (input.sign) integer = -integer;
  return integer < minimum ? minimum : integer > maximum ? maximum : integer;
}
const clamp = (value, bits, unsigned) => {
  const min = unsigned ? 0n : -(1n << BigInt(bits - 1));
  const max = unsigned ? (1n << BigInt(bits)) - 1n : (1n << BigInt(bits - 1)) - 1n;
  return value < min ? min : value > max ? max : value;
};
const cycle = values => Array.from({ length: 64 }, (_, index) => BigInt(values[index % values.length]));
const f32Samples = cycle([
  0x00000000n,0x80000000n,0x00000001n,0x80000001n,0x3fc00000n,0xbfc00000n,
  0x4effffffn,0x4f000000n,0xcf000000n,0xcf000001n,0x4f7fffffn,0x4f800000n,
  0x7fc12345n,0xffc12345n,0x7f800000n,0xff800000n,0x3f800000n,0xbf800000n
]);
const f64Samples = cycle([
  0x0000000000000000n,0x8000000000000000n,0x0000000000000001n,0x8000000000000001n,
  0x3ff8000000000000n,0xbff8000000000000n,0x41dfffffffc00000n,0x41dffffffff00000n,
  0x41e0000000000000n,0xc1e0000000000000n,0xc1e0000000100000n,0x41efffffffe00000n,
  0x41efffffffe80000n,0x41f0000000000000n,0x7ff8123456789abcn,0xfff8123456789abcn,
  0x7ff0000000000000n,0xfff0000000000000n
]);
const f64RoundingSamples = cycle([
  0n,0x8000000000000000n,0x3ff0000000000000n,0x3ff0000010000000n,0x3ff0000030000000n,
  0x3ff0000010000001n,0x3ff000000fffffffn,0xbff0000010000000n,
  0x36a0000000000000n,0x3690000000000000n,0x3690000000000001n,0x3810000000000000n,
  0x380fffffc0000000n,0x47efffffe0000000n,0x47effffff0000000n,0x47f0000000000000n,
  0x7ff0000000000000n,0xfff0000000000000n,0x7ff8000000000001n,0xfff8000000001234n
]);
function add(profile) {
  if (profiles.some(item => item.id === profile.id)) throw new Error(`Duplicate conversion profile ${profile.id}`);
  profiles.push(profile);
}
for (const fromBits of [32,64]) for (const unsigned of [false,true]) {
  const suffix = unsigned ? 'u' : 's';
  add({ id: `trunc-sat-f${fromBits}-${suffix}`, source: `f${fromBits}`,
    result: fromBits === 32 ? 'i32' : unsigned ? 'u32' : 'i32', unsignedOutput: unsigned,
    semanticKind: 'saturating-float-to-integer', builtin: fromBits === 32
      ? `__builtin_wasm_trunc_saturate_${suffix}_i32x4_f32x4`
      : `__builtin_wasm_trunc_sat_${suffix}_zero_f64x2_i32x4`,
    inputs: fromBits === 32 ? f32Samples : f64Samples,
    requiredInstructions: [`i32x4.trunc_sat_f${fromBits}x${128/fromBits}_${suffix}${fromBits === 64 ? '_zero' : ''}`],
    expected: values => [...values.map(value => saturatingFloatToInteger(value,fromBits,unsigned)), ...(fromBits === 64 ? [0n,0n] : [])]
  });
}
for (const fromBits of [16,32]) for (const unsigned of [false,true]) {
  const toBits = fromBits / 2, sign = unsigned ? 'u' : 's';
  const min = -(1n << BigInt(toBits - 1)), max = (1n << BigInt(toBits - 1)) - 1n;
  const upper = (1n << BigInt(toBits)) - 1n;
  const values = cycle([-(1n << BigInt(fromBits-1)),min-1n,min,min+1n,-1n,0n,1n,max-1n,max,max+1n,upper-1n,upper,upper+1n,(1n<<BigInt(fromBits-1))-1n]);
  add({ id: `narrow-i${fromBits}-${sign}`, source: `i${fromBits}`, result: `${unsigned?'u':'i'}${toBits}`,
    semanticKind: 'saturating-integer-narrow', builtin: `__builtin_wasm_narrow_${sign}_i${toBits}x${128/toBits}_i${fromBits}x${128/fromBits}`,
    inputs: values, secondInputs: [...values].reverse(), requiredInstructions: [`i${toBits}x${128/toBits}.narrow_i${fromBits}x${128/fromBits}_${sign}`],
    expected: (left,right) => [...left,...right].map(value => clamp(value,toBits,unsigned))
  });
}
for (const fromBits of [8,16,32]) for (const unsigned of [false,true]) for (const high of [false,true]) {
  const toBits = 2*fromBits, source = `${unsigned?'u':'i'}${fromBits}`, result = `${unsigned?'u':'i'}${toBits}`;
  const half = 1n << BigInt(fromBits-1);
  const values = cycle(unsigned ? [0n,1n,2n,half-1n,half,half+1n,2n*half-2n,2n*half-1n] : [-half,-half+1n,-2n,-1n,0n,1n,half-2n,half-1n]);
  const count = 128/toBits, start = high ? count : 0;
  add({ id: `extend-${source}-${high?'high':'low'}`, source, result, inputs: values,
    semanticKind: 'integer-extend', requiredInstructions: [`i${toBits}x${count}.extend_${high?'high':'low'}_i${fromBits}x${128/fromBits}_${unsigned?'u':'s'}`],
    body: `typedef ${laneTypes[result].c} Wide __attribute__((vector_size(32)));\n  Wide all = __builtin_convertvector(a, Wide);\n  return (R){${Array.from({length:count},(_,index)=>`all[${start+index}]`).join(',')}};`,
    expected: values => values.slice(start,start+count)
  });
}
for (const unsigned of [false,true]) {
  const source=unsigned?'u32':'i32', values=cycle(unsigned
    ? [0n,1n,16777215n,16777216n,16777217n,16777219n,2147483648n,4294967295n]
    : [-2147483648n,-16777219n,-16777217n,-1n,0n,16777217n,16777219n,2147483647n]);
  add({ id:`convert-${source}-f32`, source, result:'f32', inputs:values, semanticKind:'integer-to-float',
    body:'return __builtin_convertvector(a, R);', requiredInstructions:[`f32x4.convert_i32x4_${unsigned?'u':'s'}`],
    expected:values=>values.map(value=>integerToFloatBits(value,32)) });
  for(const high of [false,true]) add({ id:`convert-${source}-f64-${high?'high':'low'}`, source, result:'f64', inputs:values,
    semanticKind:high?'synthesized-high-integer-to-float':'low-integer-to-float',
    body:`typedef double Wide __attribute__((vector_size(32)));\n  Wide all = __builtin_convertvector(a, Wide);\n  return (R){all[${high?2:0}],all[${high?3:1}]};`,
    requiredInstructions:[`f64x2.convert_low_i32x4_${unsigned?'u':'s'}`,...(high?['i8x16.shuffle']:[])],
    expected:values=>values.slice(high?2:0,high?4:2).map(value=>integerToFloatBits(value,64)) });
}
for(const high of [false,true]) add({id:`promote-f32-${high?'high':'low'}`,source:'f32',result:'f64',inputs:f32Samples,
  semanticKind:high?'synthesized-high-float-promotion':'low-float-promotion',
  body:`typedef double Wide __attribute__((vector_size(32)));\n  Wide all = __builtin_convertvector(a, Wide);\n  return (R){all[${high?2:0}],all[${high?3:1}]};`,
  requiredInstructions:['f64x2.promote_low_f32x4',...(high?['i8x16.shuffle']:[])],
  expected:values=>values.slice(high?2:0,high?4:2).map(value=>convertFloatBits(value,32,64)) });
add({id:'demote-f64-zero',source:'f64',result:'f32',inputs:f64RoundingSamples,semanticKind:'float-demote-zero',
  body:'typedef double Wide __attribute__((vector_size(32)));\n  Wide all = {a[0],a[1],0.0,0.0};\n  return __builtin_convertvector(all, R);',
  requiredInstructions:['f32x4.demote_f64x2_zero'],
  expected:values=>[...values.map(value=>convertFloatBits(value,64,32)),0n,0n] });
add({id:'pack-f64-f32',source:'f64',result:'f32',inputs:f64RoundingSamples,secondInputs:[...f64RoundingSamples].reverse(),semanticKind:'float-pack',
  body:'typedef double Wide __attribute__((vector_size(32)));\n  Wide all = {a[0],a[1],b[0],b[1]};\n  return __builtin_convertvector(all, R);',
  requiredInstructions:['f32x4.demote_f64x2_zero','i8x16.shuffle'],
  expected:(left,right)=>[...left,...right].map(value=>convertFloatBits(value,64,32)) });
for(const fromBits of [16,32,64]) {
  const toBits=fromBits/2, source=`u${fromBits}`, result=`u${toBits}`, mask=(1n<<BigInt(toBits))-1n;
  const max=(1n<<BigInt(fromBits))-1n;
  const values=cycle([0n,1n,mask,mask+1n,max,max-1n,(max>>1n), (0x123456789abcdef0n & max)]);
  const count=128/fromBits;
  add({id:`pack-truncate-${source}-${result}`,source,result,inputs:values,secondInputs:[...values].reverse(),semanticKind:'integer-truncating-pack',
    body:`typedef ${laneTypes[source].c} Wide __attribute__((vector_size(32)));\n  Wide all = {${['a','b'].flatMap(name=>Array.from({length:count},(_,index)=>`${name}[${index}]`)).join(',')}};\n  return __builtin_convertvector(all, R);`,
    requiredInstructions:['i8x16.shuffle'],expected:(left,right)=>[...left,...right].map(value=>value&mask) });
}
// Ordinary floating casts are tested only with representable inputs. NaN and
// overflow samples above are reserved for the explicit saturating operations.
for(const unsigned of [false,true]) {
  const result=unsigned?'u32':'i32';
  const valid32=cycle(unsigned?[0n,0x80000000n,0x3fc00000n,0x4f7fffffn]:[0n,0x80000000n,0x3fc00000n,0xbfc00000n,0xcf000000n,0x4effffffn]);
  add({id:`ordinary-f32-${result}`,source:'f32',result,inputs:valid32,semanticKind:'defined-float-to-integer',
    body:'return __builtin_convertvector(a, R);',requiredInstructions:[`i32x4.trunc_sat_f32x4_${unsigned?'u':'s'}`],
    expected:values=>values.map(value=>saturatingFloatToInteger(value,32,unsigned)) });
  const valid64=cycle(unsigned?[0n,0x8000000000000000n,0x3ff8000000000000n,0x41efffffffe80000n]:[0n,0x8000000000000000n,0x3ff8000000000000n,0xbff8000000000000n,0xc1e0000000000000n,0x41dffffffff00000n]);
  add({id:`pack-f64-${result}`,source:'f64',result,inputs:valid64,secondInputs:[...valid64].reverse(),semanticKind:'defined-float-to-integer-pack',
    body:'typedef double Wide __attribute__((vector_size(32)));\n  Wide all = {a[0],a[1],b[0],b[1]};\n  return __builtin_convertvector(all, R);',
    requiredInstructions:[`i32x4.trunc_sat_f64x2_${unsigned?'u':'s'}_zero`,'i8x16.shuffle'],
    expected:(left,right)=>[...left,...right].map(value=>saturatingFloatToInteger(value,64,unsigned)) });
}
// Wasm has no i64x2/f64x2 conversion opcode. These ordinary, defined casts
// exercise the existing scalar lowering while preserving the public v128 ABI.
for (const unsigned of [false,true]) {
  const integer = unsigned ? 'u64' : 'i64';
  const values = cycle(unsigned
    ? [0n,1n,(1n<<53n)-1n,1n<<53n,(1n<<53n)+1n,(1n<<53n)+3n,1n<<63n,(1n<<64n)-1n]
    : [-(1n<<63n),-(1n<<53n)-3n,-1n,0n,1n,(1n<<53n)+1n,(1n<<53n)+3n,(1n<<63n)-1n]);
  add({id:`fallback-${integer}-f64`,source:integer,result:'f64',inputs:values,semanticKind:'scalar-fallback-integer-to-float',
    body:'return __builtin_convertvector(a, R);',requiredInstructions:[],
    expected:values=>values.map(value=>integerToFloatBits(value,64))});
  const integers = unsigned ? [0n,1n,(1n<<53n)-1n,1n<<53n,(1n<<63n),(1n<<64n)-2048n]
    : [-(1n<<63n),-(1n<<53n),-1n,0n,1n,(1n<<53n),(1n<<63n)-1024n];
  const floats = cycle([...integers.map(value=>integerToFloatBits(value,64)),0x8000000000000000n,0x3ff8000000000000n,...(unsigned?[]:[0xbff8000000000000n])]);
  add({id:`fallback-f64-${integer}`,source:'f64',result:integer,inputs:floats,semanticKind:'scalar-fallback-float-to-integer',
    body:'return __builtin_convertvector(a, R);',requiredInstructions:[],
    expected:values=>values.map(raw=>{const value=decodeFloat(raw,64);const whole=value.power>=0?value.significand<<BigInt(value.power):value.significand>>BigInt(-value.power);return value.sign?-whole:whole;})});
}
function cInteger(value,unsigned,bits) {
  if(!unsigned&&bits===64&&value===-(1n<<63n))return '(-9223372036854775807LL-1)';
  return `${value}${unsigned?'ULL':'LL'}`;
}
function sourceArray(values,type,name) {
  return type.floating
    ? `static const unsigned ${type.bits===32?'int':'long long'} ${name}[64] = {${values.map(value=>`0x${value.toString(16)}${type.bits===32?'U':'ULL'}`).join(',')}};`
    : `static const ${type.c} ${name}[64] = {${values.map(value=>cInteger(value,!type.signed,type.bits)).join(',')}};`;
}
function token(value,type) {
  if(value==='nan')return value;
  return type.floating?value.toString(16).padStart(type.bits/4,'0'):String(value);
}
function makeCase(profile,language,optimization,simd=true) {
  const input=laneTypes[profile.source],output=laneTypes[profile.result],lanes=128/input.bits,outLanes=128/output.bits;
  const parameters=profile.secondInputs?'I a, I b':'I a';
  const invocation=profile.secondInputs?'a,b':'a';
  const body=profile.body||`return ${profile.builtin}(${invocation});`;
  const typeCheck=profile.builtin?`#ifdef __cplusplus\nstatic_assert(__is_same(decltype(${profile.builtin}(${profile.secondInputs?'I{},I{}':'I{}'})),R), "exact builtin result type");\n#else\n_Static_assert(__builtin_types_compatible_p(__typeof__(${profile.builtin}(${profile.secondInputs?'(I){0},(I){0}':'(I){0}'})),R), "exact builtin result type");\n#endif\n`:'';
  const load=(name,array)=>input.floating
    ? `${input.c} value_${name}; memcpy(&value_${name},&${array}[index],sizeof(value_${name})); ${name}[lane]=value_${name};`
    : `${name}[lane]=${array}[index];`;
  const print=output.floating
    ? `${output.c} value=result[lane]; unsigned ${output.bits===32?'int':'long long'} bits; memcpy(&bits,&value,sizeof(bits));\n      if ((bits & ${output.bits===32?'0x7f800000U':'0x7ff0000000000000ULL'}) == ${output.bits===32?'0x7f800000U':'0x7ff0000000000000ULL'} && (bits & ${output.bits===32?'0x007fffffU':'0x000fffffffffffffULL'})) printf("nan");\n      else printf("%0${output.bits/4}${output.bits===32?'x':'llx'}",bits);`
    : profile.unsignedOutput? 'printf("%llu",(unsigned long long)(unsigned int)result[lane]);'
    : `printf("%${output.signed?'lld':'llu'}",(${output.signed?'long long':'unsigned long long'})result[lane]);`;
  const rows=[];
  for(let block=0;block<64/lanes;block++) {
    const left=Array.from({length:lanes},(_,lane)=>profile.inputs[(block*lanes+lane+rotation)%64]);
    const right=profile.secondInputs&&Array.from({length:lanes},(_,lane)=>profile.secondInputs[(block*lanes+lane+rotation)%64]);
    const values=profile.expected(left,right);
    if(values.length!==outLanes)throw new Error(`Wrong oracle shape: ${profile.id}`);
    rows.push(values.map(value=>token(value,output)).join(' '));
  }
  return {id:`simd-convert-${profile.id}-${language}-o${optimization}${simd?'':'-disabled'}`,
    semanticKind:profile.semanticKind,builtin:profile.builtin,
    request:{language,standard:language==='cpp'?'gnu++17':'gnu11',optimization,simd,
      code:`#include <stdio.h>\n#include <string.h>\ntypedef ${input.c} I __attribute__((vector_size(16)));\ntypedef ${output.c} R __attribute__((vector_size(16)));\n${typeCheck}${sourceArray(profile.inputs,input,'input_values')}\n${profile.secondInputs?sourceArray(profile.secondInputs,input,'second_values')+'\n':''}__attribute__((noinline)) static R convert(${parameters}) {\n  ${body}\n}\nstatic R (*volatile conversion)(${parameters}) = convert;\nint main(void) {\n  unsigned rotation; if(scanf("%u",&rotation)!=1||rotation>=64)return 2;\n  for(unsigned block=0;block<${64/lanes};++block) {\n    I a${profile.secondInputs?',b':''};\n    for(unsigned lane=0;lane<${lanes};++lane) {\n      unsigned index=(block*${lanes}+lane+rotation)%64;\n      ${load('a','input_values')}\n      ${profile.secondInputs?load('b','second_values'):''}\n    }\n    R result=conversion(${invocation});\n    for(unsigned lane=0;lane<${outLanes};++lane) {\n      ${print}\n      putchar(lane+1==${outLanes}?'\\n':' ');\n    }\n  }\n  return 0;\n}\n`},
    stdin:`${rotation}\n`,stdout:rows.join('\n')+'\n',
    requiredInstructions:simd?profile.requiredInstructions:[],forbiddenInstructions:[]
  };
}
export const cases=profiles.flatMap(profile=>['c','cpp'].flatMap(language=>['0','2'].map(optimization=>makeCase(profile,language,optimization))));
export const disabledCases=profiles.filter(profile=>['convert-i32-f32','ordinary-f32-i32','pack-truncate-u16-u8'].includes(profile.id))
  .flatMap(profile=>['c','cpp'].flatMap(language=>['0','2'].map(optimization=>makeCase(profile,language,optimization,false))));
export const conversionProfiles=profiles.map(({expected,body,...profile})=>({...profile,inputs:profile.inputs.map(String),...(profile.secondInputs?{secondInputs:profile.secondInputs.map(String)}:{})}));
// Compile live exported functions so rejection comes from the builtin's real
// signature. SIMD-disabled/default tests additionally reuse all 32 valid
// builtin cases; ordinary vector casts remain valid scalar fallback controls.
export const diagnosticCases=profiles.filter(profile=>profile.builtin).flatMap(profile=>
  ['wrong-width','wrong-kind','too-few','too-many'].flatMap(kind=>
    ['c','cpp'].flatMap(language=>['0','2'].map(optimization=>{
      const input=laneTypes[profile.source],output=laneTypes[profile.result];
      const wrongInput=kind==='wrong-width'
        ? `typedef ${input.c} Input __attribute__((vector_size(8)));`
        :kind==='wrong-kind'?'typedef void *Input;':'typedef I Input;';
      const argumentsList=kind==='too-few'?(profile.secondInputs?'a':'')
        :kind==='too-many'?(profile.secondInputs?'a,b,a':'a,b')
        :profile.secondInputs?'a,b':'a';
      return {id:`simd-convert-${profile.id}-${kind}-${language}-o${optimization}`,
        builtin:profile.builtin,kind,
        diagnosticPattern:kind.startsWith('too-')?'too few arguments|too many arguments'
          :'incompatible type|cannot convert|could not convert|incompatible parameter|cannot initialize a parameter',
        request:{language,standard:language==='cpp'?'gnu++17':'gnu11',optimization,simd:true,
          code:`typedef ${input.c} I __attribute__((vector_size(16)));\n`+
            `typedef ${output.c} R __attribute__((vector_size(16)));\n${wrongInput}\n`+
            `__attribute__((noinline)) R invalid(Input a, Input b) {\n  return ${profile.builtin}(${argumentsList});\n}\n`},
        stdin:''};
    }))));
