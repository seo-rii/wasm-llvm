import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { identity } from '../clang-browser/cross/package.mjs';
import { verifyRelaxedSimdDriverQualificationOptions, verifyRelaxedSimdDriverQualification } from './simd-relaxed-driver-qualification.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hash = value => identity(Buffer.from(value));
function receipt() {
  const work = '/qualified/work', sysroot = '/qualified/sysroot', root = '/qualified/driver';
  const compiler = work + '/gcc-native/gcc';
  const expected = { work, sysroot, nativeBuild: hash('native build'), recipes: { driver: hash('driver recipe') },
    specs: { overlay: hash('specs') }, tools: Object.fromEntries(['assembler', 'xgcc', 'cc1', 'cc1plus'].map(name => [name, hash(name)])),
    headers: { gcc: { 'wasm_simd128.h': hash('SIMD header'), 'wasm_relaxed_simd.h': hash('relaxed header') } } };
  const inputs = { [path.join(here, 'test-simd-relaxed-driver.py')]: expected.recipes.driver,
    [work + '/native-build.json']: expected.nativeBuild, [work + '/native-driver.specs']: expected.specs.overlay,
    [work + '/wabt-native/wat2wasm']: expected.tools.assembler,
    ...Object.fromEntries(['xgcc', 'cc1', 'cc1plus'].map(name => [compiler + '/' + name, expected.tools[name]])),
    ...Object.fromEntries(Object.entries(expected.headers.gcc).map(([name, value]) => [compiler + '/include/' + name, value])) };
  const profiles = [
    { name: 'enabled', flags: ['-msimd128', '-mrelaxed-simd'], enabled: true },
    { name: 'disable-then-enable', flags: ['-msimd128', '-mno-relaxed-simd', '-mrelaxed-simd'], enabled: true },
    { name: 'enable-then-disable', flags: ['-msimd128', '-mrelaxed-simd', '-mno-relaxed-simd'], enabled: false },
    { name: 'simd-only', flags: ['-msimd128'], enabled: false }, { name: 'default', flags: [], enabled: false },
    { name: 'missing-simd', flags: ['-mrelaxed-simd'], enabled: true, reject: true },
    { name: 'disable-simd-last', flags: ['-msimd128', '-mrelaxed-simd', '-mno-simd128'], enabled: true, reject: true }
  ];
  const positive = '#include <wasm_relaxed_simd.h>\n#ifndef __wasm_relaxed_simd__\n#error missing relaxed macro\n#endif\nv128_t probe(v128_t a, v128_t b) { return wasm_i8x16_relaxed_swizzle(a, b); }\n';
  const negative = '#ifdef __wasm_relaxed_simd__\n#error unexpected relaxed macro\n#endif\nint probe(int value) { return value + 1; }\n';
  const cases = ['c', 'c++'].flatMap(language => ['0', '2'].flatMap(level => profiles.map(profile => {
    const id = `${profile.name}-${language === 'c' ? 'c' : 'cpp'}-o${level}`;
    const source = root + '/' + id + (language === 'c' ? '.c' : '.cc'), object = root + '/' + id + '.o';
    return { id, status: 'passed', exitCode: profile.reject ? 1 : 0, stdout: '', stderr: profile.reject ? '-mrelaxed-simd requires -msimd128' : 'actual verbose driver output',
      source: hash(profile.enabled ? positive : negative),
      command: [compiler + '/xgcc', '-B' + root + '/', '-B' + compiler + '/', '-specs=' + work + '/native-driver.specs',
        '-O' + level, '-x', language, '-v', '-nostdinc', '-isystem', compiler + '/include', '-isystem', sysroot + '/include/wasm32-wasi',
        ...profile.flags, '-c', source, '-o', object],
      ...(!profile.reject ? { object: hash('real object placeholder'), targetFeatures: profile.enabled ? { 'relaxed-simd': '+', simd128: '+' } : {},
        assemblerArgv: [root + '/as', '-r', '--enable-annotations', ...(profile.enabled ? ['--enable-relaxed-simd'] : []), '-v', '-o', object, root + '/tmp/ccfixture.s'] } : {}) };
  })));
  return { expected, file: root + '/qualification.json', report: { kind: 'gcc-wasi-relaxed-simd-driver-qualification', status: 'passed', inputsUnchanged: true,
    counts: { cases: 28, objectEmissions: 20, rejections: 8 }, inputs, cases } };
}

test('patch 0022 requires both actual frontend and native driver qualification', () => {
  const patches = [{ path: 'patches/0022-relaxed-simd.patch' }], options = { simdRelaxedQualification: '/compiler.json', simdRelaxedDriverQualification: '/driver.json' };
  verifyRelaxedSimdDriverQualificationOptions(patches, options);
  verifyRelaxedSimdDriverQualificationOptions([], {});
  for (const field of Object.keys(options)) assert.throws(() => verifyRelaxedSimdDriverQualificationOptions(patches, { ...options, [field]: undefined }), new RegExp(field));
});

test('driver receipt binds all 28 real commands, source probes, flag precedence and compiler inputs', () => {
  const { expected, file, report } = receipt();
  verifyRelaxedSimdDriverQualification(report, file, expected);
  for (const mutate of [
    value => { value.status = 'failed'; }, value => { value.inputsUnchanged = false; },
    value => { value.cases.pop(); }, value => { value.cases[0] = structuredClone(value.cases[1]); },
    value => { value.counts.rejections = 0; }, value => { delete value.inputs[expected.work + '/native-build.json']; },
    value => { value.inputs[expected.work + '/gcc-native/gcc/xgcc'] = hash('different driver'); },
    value => { value.inputs[path.join(here, 'test-simd-relaxed-driver.py')] = hash('stale recipe'); },
    value => { value.cases[0].command[0] = '/substitute/compiler'; },
    value => { value.cases[0].source = hash('int probe() { return 0; }'); },
    value => { value.cases[2].command.splice(-4, 0, '-mrelaxed-simd'); },
    value => { value.cases[2].targetFeatures = { 'relaxed-simd': '+' }; },
    value => { value.cases[0].assemblerArgv = value.cases[0].assemblerArgv.filter(arg => arg !== '--enable-relaxed-simd'); },
    value => { value.cases[2].assemblerArgv.splice(3, 0, '--enable-relaxed-simd'); },
    value => { value.cases[5].exitCode = 0; }, value => { value.cases[5].object = hash('invalid option object'); },
    value => { value.cases[5].stderr = 'unrelated driver error'; },
    value => { value.cases[0].assemblerArgv[value.cases[0].assemblerArgv.length - 1] = '/outside/input.s'; }
  ]) {
    const changed = structuredClone(report); mutate(changed);
    assert.throws(() => verifyRelaxedSimdDriverQualification(changed, file, expected));
  }
});
