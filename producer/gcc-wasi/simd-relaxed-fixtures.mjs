// Independent integer/IEEE arithmetic and explicit input bit patterns. The guest
// only calls the real public header; it contains no replacement implementation.
// Relaxed host choices are fixed within a program. Whole-output alternatives
// therefore preserve one projection across every lane and repeated invocation.
export const specification = {
  core: 'https://github.com/WebAssembly/spec/tree/859d3232a55cdbb9d75343a072b05cd0a2172e1a',
  relaxed: 'https://github.com/WebAssembly/relaxed-simd/blob/c3f9359af2cd607cc46b0a3274f90ea52543a2f2/document/core/exec/numerics.rst',
  note: 'The pinned relaxed numerics defines fixed host projections. Unsigned invalid truncation permits UINT_MAX, UINT_MAX-1 and 0x80000000 as well as saturation. Lane selection includes bitwise, whole-lane and per-byte top-bit selection; canonical full/zero masks remain deterministic.'
};
const mask = bits => (1n << BigInt(bits)) - 1n;
const unsigned = (value, bits) => BigInt.asUintN(bits, BigInt(value));
const signed = (value, bits) => BigInt.asIntN(bits, BigInt(value));
const hex = (value, bits) => unsigned(value, bits).toString(16).padStart(bits / 4, '0');
const unique = values => [...new Set(values)];
const bitLength = value => value === 0n ? 0 : value.toString(2).length;
const formats = { 32: { fraction: 23, bias: 127, exponent: 8 }, 64: { fraction: 52, bias: 1023, exponent: 11 } };
function decoded(raw, bits) {
  raw = unsigned(raw, bits);
  const { fraction, bias, exponent } = formats[bits];
  const e = Number(raw >> BigInt(fraction) & mask(exponent)), f = raw & mask(fraction);
  return { raw, sign: (raw >> BigInt(bits - 1)) !== 0n, nan: e === Number(mask(exponent)) && f !== 0n,
    infinity: e === Number(mask(exponent)) && f === 0n,
    integer: f | (e && e !== Number(mask(exponent)) ? 1n << BigInt(fraction) : 0n),
    power: (e ? e - bias : 1 - bias) - fraction };
}
function roundedShift(value, shift) {
  if (shift <= 0) return value << BigInt(-shift);
  const n = BigInt(shift), q = value >> n, r = value & mask(shift), halfway = 1n << (n - 1n);
  return q + (r > halfway || (r === halfway && (q & 1n)) ? 1n : 0n);
}
export function encodeDyadic(integer, power, bits, negativeZero = false) {
  integer = BigInt(integer);
  const negative = integer < 0n || (integer === 0n && negativeZero);
  if (integer < 0n) integer = -integer;
  const { fraction, bias, exponent: exponentBits } = formats[bits];
  const sign = negative ? 1n << BigInt(bits - 1) : 0n;
  if (!integer) return sign;
  let exponent = bitLength(integer) - 1 + power;
  if (exponent < 1 - bias) return sign | roundedShift(integer, (1 - bias - fraction) - power);
  let significand = roundedShift(integer, bitLength(integer) - 1 - fraction);
  if (significand === 1n << BigInt(fraction + 1)) { significand >>= 1n; ++exponent; }
  if (exponent > bias) return sign | (mask(exponentBits) << BigInt(fraction));
  return sign | (BigInt(exponent + bias) << BigInt(fraction)) | (significand & mask(fraction));
}
function sumDyadic(a, b, bits) {
  const power = Math.min(a.power, b.power);
  const av = (a.sign ? -a.integer : a.integer) << BigInt(a.power - power);
  const bv = (b.sign ? -b.integer : b.integer) << BigInt(b.power - power);
  return encodeDyadic(av + bv, power, bits, a.sign && b.sign);
}
export function multiplyAddBits(aBits, bBits, cBits, bits, fused, negative = false) {
  let a = decoded(aBits, bits), b = decoded(bBits, bits), c = decoded(cBits, bits);
  if (negative) a = { ...a, sign: !a.sign };
  const { fraction, exponent } = formats[bits];
  const infinity = mask(exponent) << BigInt(fraction), nan = infinity | (1n << BigInt(fraction - 1));
  const special = (sign, magnitude) => (sign ? 1n << BigInt(bits - 1) : 0n) | magnitude;
  if (a.nan || b.nan || c.nan) return nan;
  if ((a.infinity && !b.infinity && !b.integer) || (b.infinity && !a.infinity && !a.integer)) return nan;
  const product = { integer: a.integer * b.integer, power: a.power + b.power, sign: a.sign !== b.sign };
  if (a.infinity || b.infinity) return c.infinity && c.sign !== product.sign ? nan : special(product.sign, infinity);
  if (fused) return c.infinity ? special(c.sign, infinity) : sumDyadic(product, c, bits);
  const rounded = decoded(encodeDyadic(product.sign ? -product.integer : product.integer, product.power, bits, product.sign), bits);
  if (rounded.infinity) return c.infinity && c.sign !== rounded.sign ? nan : special(rounded.sign, infinity);
  if (c.infinity) return special(c.sign, infinity);
  return sumDyadic(rounded, c, bits);
}
export function relaxedTrunc(raw, bits, unsignedResult, projection = 0) {
  const value = decoded(raw, bits), minimum = unsignedResult ? 0n : -(1n << 31n), maximum = unsignedResult ? mask(32) : (1n << 31n) - 1n;
  let integer;
  if (!value.nan && !value.infinity) {
    integer = value.power < 0 ? value.integer >> BigInt(-value.power) : value.integer << BigInt(value.power);
    if (value.sign) integer = -integer;
    if (integer >= minimum && integer <= maximum) return unsigned(integer, 32);
  }
  if (projection) return unsignedResult ? [0n, mask(32), mask(32) - 1n, 1n << 31n][projection] : 1n << 31n;
  if (value.nan) return 0n;
  return unsigned(value.sign ? minimum : maximum, 32);
}
export function relaxedDot(a, b, accumulator, unsignedSecond, widePairs = false) {
  const bits = widePairs ? 32 : 16;
  const pairs = Array.from({ length: 8 }, (_, index) => {
    let value = [0, 1].reduce((sum, offset) => {
      const lane = index * 2 + offset;
      return sum + signed(a[lane], 8) * (unsignedSecond ? unsigned(b[lane], 8) : signed(b[lane], 8));
    }, 0n);
    if (unsignedSecond) { const half = 1n << BigInt(bits - 1); value = value < -half ? -half : value > half - 1n ? half - 1n : value; }
    return signed(value, bits);
  });
  if (!accumulator) return pairs.map(value => unsigned(value, 16));
  return accumulator.map((value, index) => unsigned(BigInt(value) + pairs[2 * index] + pairs[2 * index + 1], 32));
}
const rawFloat = (number, bits) => {
  const array = new ArrayBuffer(bits / 8), view = new DataView(array);
  if (bits === 32) { view.setFloat32(0, number, true); return BigInt(view.getUint32(0, true)); }
  view.setFloat64(0, number, true); return view.getBigUint64(0, true);
};
function floatToken(raw, bits) {
  // Inputs contain only canonical quiet NaNs, so all arithmetic NaN results
  // must remain canonical (either sign). Noncanonical payloads are NOT erased.
  const { fraction, exponent } = formats[bits];
  return (unsigned(raw, bits) & mask(bits - 1)) === ((mask(exponent) << BigInt(fraction)) | (1n << BigInt(fraction - 1))) ? 'nan' : hex(raw, bits);
}
const row = (a, b, c) => [a, b, c].filter(value => value !== undefined);
const profiles = [];
function add(profile) { profiles.push(profile); }
const bytes = Array.from({ length: 16 }, (_, i) => BigInt(11 + i * 13));
add({ name: 'wasm_i8x16_relaxed_swizzle', opcode: 'i8x16.relaxed_swizzle', bits: 8, inputs: [8, 8], projections: 2,
  rows: [row(bytes, [0, 15, 16, 17, 31, 63, 127, 128, 129, 255, 14, 1, 32, 48, 7, 8]), row([...bytes].reverse(), [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0])],
  evaluate: ([a, b], projection) => b.map(value => value < 16 ? a[value] : value >= 128 || projection === 0 ? 0n : a[value % 16]) });
for (const bits of [32, 64]) for (const unsignedResult of [false, true]) {
  const values = [0, -0, 1.875, -1.875, 2147483648, -2147483648, 4294967296, -4294967296, NaN, Infinity, -Infinity, -0.875, 2147483520, 4294967040, 42.75, -42.75];
  if (bits === 64) values.push(2147483647.75, -2147483648.75, 4294967295.75, -0.9999999999999999);
  const lanes = 128 / bits;
  add({ name: `wasm_${unsignedResult ? 'u' : 'i'}32x4_relaxed_trunc_f${bits}x${lanes}${bits === 64 ? '_zero' : ''}`,
    opcode: `i32x4.relaxed_trunc_f${bits}x${lanes}_${unsignedResult ? 'u' : 's'}${bits === 64 ? '_zero' : ''}`, bits: 32, inputs: [bits], projections: unsignedResult ? 4 : 2,
    rows: Array.from({ length: values.length / lanes }, (_, i) => row(values.slice(i * lanes, (i + 1) * lanes).map(value => rawFloat(value, bits)))),
    evaluate: ([a], projection) => [...a.map(value => relaxedTrunc(value, bits, unsignedResult, projection)), ...(bits === 64 ? [0n, 0n] : [])] });
}
for (const bits of [32, 64]) for (const negative of [false, true]) {
  const p = formats[bits].fraction, one = rawFloat(1, bits), sign = 1n << BigInt(bits - 1);
  const maximum = ((mask(formats[bits].exponent) - 1n) << BigInt(p)) | mask(p), least = 1n;
  const triples = [
    [one + 1n, one - 2n, rawFloat(negative ? 1 : -1, bits)],
    [rawFloat(3, bits), rawFloat(7, bits), rawFloat(5, bits)],
    [maximum, rawFloat(2, bits), maximum | (negative ? 0n : sign)],
    [least, rawFloat(0.5, bits), negative ? least | sign : least],
    [rawFloat(Infinity, bits), rawFloat(0, bits), rawFloat(1, bits)],
    [rawFloat(-0, bits), rawFloat(2, bits), rawFloat(negative ? 0 : -0, bits)],
    [rawFloat(-4.5, bits), rawFloat(2, bits), rawFloat(10.25, bits)],
    [rawFloat(Infinity, bits), rawFloat(2, bits), rawFloat(1, bits)],
    [maximum, rawFloat(2, bits), rawFloat(negative ? Infinity : -Infinity, bits)],
    [maximum, rawFloat(2, bits), rawFloat(negative ? -Infinity : Infinity, bits)],
    [rawFloat(NaN, bits), rawFloat(1, bits), rawFloat(4, bits)],
    [rawFloat(1, bits), rawFloat(4, bits), rawFloat(NaN, bits)]
  ];
  const lanes = 128 / bits;
  add({ name: `wasm_f${bits}x${lanes}_relaxed_${negative ? 'nmadd' : 'madd'}`, opcode: `f${bits}x${lanes}.relaxed_${negative ? 'nmadd' : 'madd'}`,
    bits, floating: true, inputs: [bits, bits, bits], projections: 2,
    rows: Array.from({ length: triples.length / lanes }, (_, block) => [0, 1, 2].map(input => triples.slice(block * lanes, (block + 1) * lanes).map(triple => triple[input]))),
    evaluate: ([a, b, c], projection) => a.map((value, i) => multiplyAddBits(value, b[i], c[i], bits, projection === 1, negative)) });
}
for (const bits of [8, 16, 32, 64]) {
  const lanes = 128 / bits, m = mask(bits), high = 1n << BigInt(bits - 1);
  const masks = [0n, m, high, high - 1n, m / 3n, (m / 3n) * 2n, 1n, m - 1n];
  add({ name: `wasm_i${bits}x${lanes}_relaxed_laneselect`, opcode: `i${bits}x${lanes}.relaxed_laneselect`, bits, inputs: [bits, bits, bits], projections: 5,
    rows: Array.from({ length: Math.max(2, 8 / lanes) }, (_, block) => row(
      Array.from({ length: lanes }, (_, i) => unsigned(0x13579bdf2468ace0n + BigInt(i + block * lanes) * 17n, bits)),
      Array.from({ length: lanes }, (_, i) => unsigned(0xfedcba9876543210n - BigInt(i + block * lanes) * 31n, bits)),
      Array.from({ length: lanes }, (_, i) => masks[(i + block * lanes) % masks.length]))),
    evaluate: ([a, b, c], projection) => a.map((value, i) => {
      if (c[i] === m) return value;
      if (c[i] === 0n) return b[i];
      if (projection === 1) return c[i] & high ? value : b[i];
      if (projection === 2) return value;
      if (projection === 3) return b[i];
      if (projection === 4) {
        let selected = 0n;
        for (let shift = 0n; shift < BigInt(bits); shift += 8n)
          selected |= ((c[i] & (0x80n << shift) ? value : b[i]) & (0xffn << shift));
        return selected;
      }
      return (value & c[i]) | (b[i] & (m ^ c[i]));
    }) });
}
for (const bits of [32, 64]) for (const isMin of [true, false]) {
  const pairs = [[1, 2], [2, 1], [-0, 0], [0, -0], [NaN, 7], [7, NaN], [NaN, NaN], [-Infinity, Infinity], [-9, -4], [0.5, 0.25], [Infinity, 2], [-Infinity, -2]];
  const lanes = 128 / bits;
  add({ name: `wasm_f${bits}x${lanes}_relaxed_${isMin ? 'min' : 'max'}`, opcode: `f${bits}x${lanes}.relaxed_${isMin ? 'min' : 'max'}`,
    bits, floating: true, inputs: [bits, bits], projections: 4,
    rows: Array.from({ length: pairs.length / lanes }, (_, block) => [0, 1].map(input => pairs.slice(block * lanes, (block + 1) * lanes).map(pair => rawFloat(pair[input], bits)))),
    evaluate: ([a, b], projection) => a.map((value, i) => {
      const x = decoded(value, bits), y = decoded(b[i], bits), nan = rawFloat(NaN, bits);
      if (x.nan) return [nan, value, b[i], b[i]][projection];
      if (y.nan) return [nan, value, b[i], value][projection];
      if (!x.integer && !x.infinity && !y.integer && !y.infinity && x.sign !== y.sign) return [rawFloat(isMin ? -0 : 0, bits), value, b[i], rawFloat(isMin ? -0 : 0, bits)][projection];
      const view = new DataView(new ArrayBuffer(bits / 8));
      const number = raw => { if (bits === 32) { view.setUint32(0, Number(raw), true); return view.getFloat32(0, true); } view.setBigUint64(0, raw, true); return view.getFloat64(0, true); };
      return (isMin ? number(value) < number(b[i]) : number(value) > number(b[i])) ? value : b[i];
    }) });
}
add({ name: 'wasm_i16x8_relaxed_q15mulr', opcode: 'i16x8.relaxed_q15mulr_s', bits: 16, inputs: [16, 16], projections: 2,
  rows: [row([-32768, -32768, 32767, 16384, 1, -1, 12345, -12345], [-32768, 32767, 32767, 16384, 16384, 16384, -23456, -23456]),
    row([0, 1, -1, 16383, 16384, 16385, -32768, 32767], [32767, -32768, -32768, 1, 1, 1, 1, -1])],
  evaluate: ([a, b], projection) => a.map((value, i) => value === -32768 && b[i] === -32768 ? (projection ? -32768n : 32767n) : (BigInt(value) * BigInt(b[i]) + 0x4000n) >> 15n) });
const dotRows = [
  row(Array.from({ length: 16 }, (_, i) => i), Array.from({ length: 16 }, (_, i) => i), [0, 1, 2, 3]),
  row([-128, -128, -128, -128, 127, 127, 127, 127, -1, 1, -2, 2, -3, 3, -4, 4], Array(16).fill(127), [1, 2, -2147483648, 2147483647]),
  row([-128, -128, -128, -128, -128, -128, -128, -128, 127, 127, 127, 127, 127, 127, 127, 127], [-128, -128, -128, -128, -127, -127, -127, -127, -128, -128, -128, -128, -1, -1, -1, -1], [1, 2, 3, 4])
];
for (const addend of [false, true]) add({ name: `wasm_${addend ? 'i32x4' : 'i16x8'}_relaxed_dot_i8x16_i7x16${addend ? '_add' : ''}`,
  opcode: `${addend ? 'i32x4' : 'i16x8'}.relaxed_dot_i8x16_i7x16${addend ? '_add' : ''}_s`, bits: addend ? 32 : 16, inputs: addend ? [8, 8, 32] : [8, 8], projections: addend ? 4 : 2,
  rows: dotRows.map(values => values.slice(0, addend ? 3 : 2)),
  evaluate: ([a, b, c], projection) => relaxedDot(a, b, c, Boolean(projection & 1), Boolean(projection & 2)) });

function words(values, bits) {
  let packed = values.reduce((value, lane, index) => value | (unsigned(lane, bits) << BigInt(index * bits)), 0n);
  return Array.from({ length: 4 }, () => { const value = packed & mask(32); packed >>= 32n; return `0x${hex(value, 32)}u`; });
}
function source(profile) {
  const inputs = profile.inputs.length, lanes = 128 / profile.bits, rowCount = profile.rows.length;
  const table = profile.rows.map(values => `{${values.map((value, i) => `{${words(value, profile.inputs[i]).join(',')}}`).join(',')}}`).join(',\n');
  const type = { 8: 'unsigned char', 16: 'unsigned short', 32: 'unsigned int', 64: 'unsigned long long' }[profile.bits];
  const format = profile.bits === 64 ? '%016llx' : `%0${profile.bits / 4}x`;
  const canonical = profile.floating ? `(bits & ${hex(mask(profile.bits - 1), profile.bits)}${profile.bits === 64 ? 'ull' : 'u'}) == 0x${hex(rawFloat(NaN, profile.bits), profile.bits)}${profile.bits === 64 ? 'ull' : 'u'}` : '0';
  const names = ['a', 'b', 'c'].slice(0, inputs);
  return `#include <stdio.h>\n#include <wasm_relaxed_simd.h>\nstatic const unsigned data[${rowCount}][${inputs}][4] = {${table}};\ntypedef ${type} Lane;\n__attribute__((noinline, noclone)) static v128_t relaxed(${names.map(name => `v128_t ${name}`).join(', ')}) {\n  return ${profile.name}(${names.join(', ')});\n}\nstatic v128_t (* volatile call_relaxed)(${names.map(() => 'v128_t').join(', ')}) = relaxed;\nint main(void) {\n  unsigned rotation;\n  if (scanf("%u", &rotation) != 1 || rotation >= ${rowCount}) return 2;\n  for (unsigned repeat = 0; repeat < 2; ++repeat) for (unsigned i = 0; i < ${rowCount}; ++i) {\n    unsigned index = (i + rotation) % ${rowCount};\n    ${names.map((name, i) => `v128_t ${name}; __builtin_memcpy(&${name}, data[index][${i}], 16);`).join('\n    ')}\n    v128_t result = call_relaxed(${names.join(', ')});\n    Lane values[${lanes}]; __builtin_memcpy(values, &result, 16);\n    for (unsigned lane = 0; lane < ${lanes}; ++lane) {\n      Lane bits = values[lane];\n      if (${canonical.replace('(bits & ', '(bits & 0x')}) printf("nan");\n      else printf("${format}", ${profile.bits === 64 ? '' : '(unsigned)'}bits);\n      putchar(lane + 1 == ${lanes} ? '\\n' : ' ');\n    }\n  }\n  return 0;\n}\n`;
}
export const relaxedProfiles = profiles.map(profile => {
  const outputs = Array.from({ length: profile.projections }, (_, projection) => {
    const text = profile.rows.map((_, index) => profile.evaluate(profile.rows[(index + 1) % profile.rows.length], projection).map(value => profile.floating ? floatToken(value, profile.bits) : hex(value, profile.bits)).join(' ') + '\n').join('');
    return text + text;
  });
  return { name: profile.name, opcode: profile.opcode, bits: profile.bits, inputs: profile.inputs, floating: Boolean(profile.floating),
    rows: profile.rows.map(values => values.map(value => value.map(String))), code: source(profile), stdoutAlternatives: unique(outputs) };
});
const languages = [{ language: 'c', standard: 'gnu11' }, { language: 'cpp', standard: 'gnu++17' }];
export const cases = relaxedProfiles.flatMap(profile => languages.flatMap(language => ['0', '2'].map(optimization => ({
  id: `simd-relaxed-${profile.name.slice(5)}-${language.language}-o${optimization}`,
  request: { ...language, optimization, simd: true, relaxedSimd: true, code: profile.code }, stdin: '1\n',
  stdout: profile.stdoutAlternatives[0], stdoutAlternatives: profile.stdoutAlternatives,
  apis: [profile.name], requiredInstructions: [profile.opcode], forbiddenInstructions: relaxedProfiles.filter(other => other !== profile).map(other => other.opcode)
}))));
const control = simd => `#include <stdio.h>\n${simd ? '#include <wasm_simd128.h>\ntypedef int V __attribute__((vector_size(16)));\n__attribute__((noinline,noclone)) static V add(V a,V b) { return a+b; }' : '__attribute__((noinline,noclone)) static unsigned add(unsigned a,unsigned b) { return a+b; }'}\nint main(void) { unsigned a,b; if(scanf("%u %u",&a,&b)!=2||a>1000||b>1000) return 2;\n${simd ? 'V x={(int)a,1,2,3}, y={(int)b,4,5,6}; V z=add(x,y); printf("%d %d %d %d\\n",z[0],z[1],z[2],z[3]);' : 'printf("%u\\n",add(a,b));'}\n#ifdef __wasm_relaxed_simd__\n puts("unexpected relaxed macro");\n return 3;\n#endif\n return 0; }\n`;
export const disabledCases = [false, true].flatMap(simd => languages.flatMap(language => ['0', '2'].map(optimization => ({
  id: `simd-relaxed-${simd ? 'simd-only' : 'scalar'}-${language.language}-o${optimization}`,
  request: { ...language, optimization, simd, relaxedSimd: false, code: control(simd) }, stdin: '3 17\n', stdout: simd ? '20 5 7 9\n' : '20\n',
  apis: [], requiredInstructions: simd ? ['i32x4.add'] : [], forbiddenInstructions: relaxedProfiles.map(profile => profile.opcode)
}))));
const builtinSignatures = [
  ['__builtin_wasm_relaxed_swizzle_i8x16', 'i8', ['i8', 'i8']],
  ['__builtin_wasm_relaxed_trunc_s_i32x4_f32x4', 'i32', ['f32']],
  ['__builtin_wasm_relaxed_trunc_u_i32x4_f32x4', 'u32', ['f32']],
  ['__builtin_wasm_relaxed_trunc_s_zero_i32x4_f64x2', 'i32', ['f64']],
  ['__builtin_wasm_relaxed_trunc_u_zero_i32x4_f64x2', 'u32', ['f64']],
  ...['f32', 'f64'].flatMap(type => ['madd', 'nmadd'].map(operation => [`__builtin_wasm_relaxed_${operation}_${type}x${type === 'f32' ? 4 : 2}`, type, [type, type, type]])),
  ...['i8', 'i16', 'i32', 'i64'].map(type => [`__builtin_wasm_relaxed_laneselect_${type}x${128 / Number(type.slice(1))}`, type, [type, type, type]]),
  ...['f32', 'f64'].flatMap(type => ['min', 'max'].map(operation => [`__builtin_wasm_relaxed_${operation}_${type}x${type === 'f32' ? 4 : 2}`, type, [type, type]])),
  ['__builtin_wasm_relaxed_q15mulr_s_i16x8', 'i16', ['i16', 'i16']],
  ['__builtin_wasm_relaxed_dot_i8x16_i7x16_s_i16x8', 'i16', ['i8', 'i8']],
  ['__builtin_wasm_relaxed_dot_i8x16_i7x16_add_s_i32x4', 'i32', ['i8', 'i8', 'i32']]
];
const declarations = Object.entries({i8:'signed char',i16:'short',i32:'int',u32:'unsigned int',i64:'long long',f32:'float',f64:'double'})
  .map(([name,type]) => `typedef ${type} ${name} __attribute__((vector_size(16)));`).join('\n');
export const diagnosticCases = builtinSignatures.flatMap(([builtin, result, arguments_]) => languages.flatMap(language => ['0', '2'].flatMap(optimization =>
  ['default', 'simd-only', 'disabled-relaxed', 'enabled-invalid'].map(profile => ({
    id: `simd-relaxed-${builtin.slice(15)}-${language.language}-o${optimization}-${profile}`,
    builtin, profile,
    diagnosticPattern: profile === 'enabled-invalid' ? 'incompatible type|cannot convert|could not convert' : 'requires.*relaxed|relaxed SIMD|relaxed-simd|SIMD128 is disabled',
    request: { ...language, optimization, simd: profile !== 'default', relaxedSimd: profile === 'enabled-invalid',
      code: `${declarations}\ntypedef signed char Wrong __attribute__((vector_size(8)));\n${result} invalid(${arguments_.map((type, i) => `${i === 0 && profile === 'enabled-invalid' ? 'Wrong' : type} a${i}`).join(', ')}) {\n return ${builtin}(${arguments_.map((_, i) => `a${i}`).join(', ')});\n}\n` }
  })))));
for (const fixture of diagnosticCases.filter(fixture => fixture.builtin === builtinSignatures[0][0] && fixture.profile === 'default'))
  diagnosticCases.push({ ...fixture, id: fixture.id.replace(/-default$/, '-relaxed-only'), profile: 'relaxed-only',
    diagnosticPattern: 'relaxed-simd.*requires.*simd128', request: { ...fixture.request, relaxedSimd: true } });
