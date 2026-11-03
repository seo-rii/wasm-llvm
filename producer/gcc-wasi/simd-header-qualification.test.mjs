import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { simdHeaderApis, simdHeaderReference } from './simd-header-api.mjs';
import { verifyHeaderApiCoverage, headerDiagnosticProfile, verifySimdHeaderQualificationOptions,
  verifySimdHeaderQualification, simdHeaderWasiRunner } from './simd-header-qualification.mjs';

const identity = text => ({ bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });
// Synthetic receipt-only unit inputs. They are never executed or published as
// real compiler qualification; artifact reopening belongs to the integration gate.
const cases = ['c', 'cpp'].flatMap(language => ['0', '2'].map(optimization => ({
  id: `coverage-${language}-${optimization}`, apis: [...simdHeaderApis],
  request: { language, optimization, standard: language === 'c' ? 'gnu11' : 'gnu++17', simd: true,
    code: '#include <wasm_simd128.h>\n' + simdHeaderApis.map(name => name + '();').join('\n') },
  stdin: '1\n', stdout: '2\n', requiredInstructions: ['i32x4.add'], forbiddenInstructions: ['i32x4.sub']
})));
const disabledCases = ['c', 'cpp'].flatMap(language => ['0', '2'].map(optimization => ({
  id: `disabled-${language}-${optimization}`, apis: [], request: { language, optimization,
    standard: language === 'c' ? 'gnu11' : 'gnu++17', simd: false, code: 'int main(void){return 0;}\n' },
  stdin: '', stdout: '', requiredInstructions: [], forbiddenInstructions: []
})));
const diagnosticCases = ['enabled-invalid', 'disabled', 'default'].map(profile => ({
  id: `diagnostic-${profile}`, profile, request: { language: 'c', optimization: '0', standard: 'gnu11',
    simd: profile === 'enabled-invalid', code: '#include <wasm_simd128.h>\nint nope;\n' }, diagnosticPattern: 'SIMD lane index|requires.*simd128'
}));

test('requires every declared API in all four language and optimization profiles', () => {
  assert.equal(Object.keys(verifyHeaderApiCoverage(cases, disabledCases)).length, 169);
  assert.throws(() => verifyHeaderApiCoverage(cases.slice(1), disabledCases), /Incomplete/);
  const changed = structuredClone(cases); changed[0].request.code = changed[0].request.code.replace('wasm_v128_load();', '');
  assert.throws(() => verifyHeaderApiCoverage(changed, disabledCases), /not called/);
  const unknown = structuredClone(cases); unknown[0].apis.push('wasm_nonexistent');
  assert.throws(() => verifyHeaderApiCoverage(unknown, disabledCases), /Unknown/);
});

test('diagnostic profiles explicitly distinguish default, disabled and invalid enabled calls', () => {
  assert.deepEqual(diagnosticCases.map(headerDiagnosticProfile), ['enabled-invalid', 'disabled', 'default']);
  assert.throws(() => headerDiagnosticProfile({ ...diagnosticCases[0], profile: undefined }), /explicit/);
  assert.throws(() => headerDiagnosticProfile({ ...diagnosticCases[0], profile: 'default' }));
});

test('patch 0016 requires header evidence and its prior SIMD prerequisites', () => {
  const patch = [{ path: 'patches/0016-wasm-simd128-header.patch' }];
  const options = Object.fromEntries(['simdHeaderQualification', 'simdConversionsQualification', 'simdSaturatingQualification', 'simdExtendedQualification', 'simdQualification', 'vectorAbiQualification', 'nativeLinker'].map(key => [key, '/proof/' + key]));
  verifySimdHeaderQualificationOptions(patch, options);
  for (const field of Object.keys(options)) assert.throws(() => verifySimdHeaderQualificationOptions(patch, { ...options, [field]: undefined }));
  verifySimdHeaderQualificationOptions([], {});
});

function proof() {
  const receipt = identity('unit-fixture'), tools = Object.fromEntries(['gcc', 'gccCpp', 'clang', 'clangCpp', 'assembler', 'objdump', 'linker', 'node', 'validator'].map(name => [name, receipt]));
  const toolPaths = Object.fromEntries(Object.keys(tools).map(name => [name, '/tools/' + name]));
  const headerRoots = { gcc: '/work/gcc/include', clang: '/sdk/lib/clang/22/include', target: '/runtime/include' };
  const expected = { cases, disabledCases, diagnosticCases, gccSource: { commit: 'unit' }, sourceLock: receipt,
    targetSource: { 'wasm_simd128.h': receipt }, tools, headerRoots, headers: { gcc: receipt, clang: receipt, target: receipt }, runtime: receipt,
    publicHeader: { source: receipt, installed: receipt, clangReference: { bytes: 1, sha256: simdHeaderReference.headerSha256 } },
    licenses: { COPYING3: { bytes: 35147, sha256: receipt.sha256 }, 'COPYING.RUNTIME': { bytes: 3324, sha256: receipt.sha256 } },
    fixtures: receipt, fixtureDependencies: receipt, apiContract: receipt, testRecipe: receipt, inspectionRecipe: receipt, gateRecipe: receipt };
  const report = { ...structuredClone(expected), kind: 'gcc-wasi-native-simd-header-qualification', status: 'passed', inputsUnchanged: true,
    toolPaths, apis: [...simdHeaderApis], coverage: verifyHeaderApiCoverage(cases, disabledCases), executionRecipe: identity(simdHeaderWasiRunner), cases: [], defaultControls: [], diagnostics: [] };
  function command(name, argv, stdout = '') { return { command: toolPaths[name], argv, status: 0, signal: null, stdout, stderr: '' }; }
  function compile(fixture, profile, family) {
    return command(family + (fixture.request.language === 'cpp' ? 'Cpp' : ''), [
      ...(family === 'clang' ? ['--target=wasm32-wasip1', '-c'] : []), '-O' + fixture.request.optimization, '-std=' + fixture.request.standard,
      '-nostdinc', '-isystem', headerRoots[family], '-isystem', '/runtime/include/wasm32-wasi', '-Werror=attributes', '-Werror=pragmas',
      ...(fixture.request.language === 'cpp' ? ['-fno-exceptions', '-fno-rtti'] : []),
      ...(profile === 'default' ? [] : [profile === 'disabled' ? '-mno-simd128' : '-msimd128'])]);
  }
  for (const { fixture, profile } of [...cases, ...disabledCases].map(fixture => ({ fixture, profile: fixture.request.simd ? 'enabled' : 'disabled' })).concat(disabledCases.map(fixture => ({ fixture, profile: 'default' })))) {
    const entry = { id: fixture.id + (profile === 'default' ? '-default' : ''), fixture: fixture.id, profile, status: 'passed',
      source: identity(fixture.request.code), fixtureValue: identity(JSON.stringify(fixture)), apis: fixture.apis, stdin: fixture.stdin, results: {} };
    for (const family of profile === 'default' ? ['gcc'] : ['gcc', 'clang']) {
      const text = '000001 func[0] <convert>:\n 000002: fd 6e | ' + (fixture.request.simd ? 'i32x4.add' : 'i32.add') + '\n';
      const commands = [compile(fixture, profile, family), ...(family === 'gcc' ? [command('assembler', ['-r', '--enable-annotations'])] : []),
        command('objdump', ['-d'], text), command('linker', ['--fatal-warnings']), command('node', [], fixture.stdout)];
      entry.results[family] = { status: 'passed', stdout: fixture.stdout, commands, instructions: [fixture.request.simd ? 'i32x4.add' : 'i32.add'],
        imports: [{ module: 'wasi_snapshot_preview1', kind: 'function', name: 'fd_write' }], exports: [{ name: '_start', kind: 'function' }, { name: 'memory', kind: 'memory' }],
        ...(fixture.request.simd && family === 'gcc' ? { convertFunction: { index: 0, name: 'convert', instructions: ['i32x4.add'] } } : {}),
        simdDisabledValidation: { ...command('validator', ['--disable-simd']), status: fixture.request.simd ? 1 : 0 } };
    }
    (profile === 'default' ? report.defaultControls : report.cases).push(entry);
  }
  for (const fixture of diagnosticCases) report.diagnostics.push({ id: fixture.id, profile: fixture.profile,
    source: identity(fixture.request.code), fixtureValue: identity(JSON.stringify(fixture)), emittedSimd: false,
    command: { ...compile(fixture, fixture.profile, 'gcc'), status: 1, stderr: 'SIMD lane index must be constant; requires -msimd128' } });
  return { report, expected };
}

test('complete same-source GCC and independent original-header Clang receipt passes structural gate', () => {
  const { report, expected } = proof(); verifySimdHeaderQualification(report, expected);
});

for (const [name, mutate] of [
  ['stale installed header', report => { report.publicHeader.installed.sha256 = '1'.repeat(64); }],
  ['different original Clang header', report => { report.publicHeader.clangReference.sha256 = '1'.repeat(64); }],
  ['omitted Clang execution', report => { delete report.cases[0].results.clang; }],
  ['changed source passed to GCC', report => { report.cases[0].source = identity('replacement'); }],
  ['opcode appears only outside convert', report => { report.cases[0].results.gcc.convertFunction.instructions = []; }],
  ['instruction inventory differs from real disassembly', report => { report.cases[0].results.clang.instructions = []; }],
  ['different actual expected stdout', report => { report.cases[0].results.clang.stdout = 'wrong\n'; }],
  ['omitted default scalar controls', report => { report.defaultControls.pop(); }],
  ['default profile silently uses a disabling flag', report => { report.defaultControls[0].results.gcc.commands[0].argv.push('-mno-simd128'); }],
  ['wrong diagnostic language or optimization', report => { report.diagnostics[0].command.argv[0] = '-O2'; }],
  ['diagnostic produced SIMD', report => { report.diagnostics[0].emittedSimd = true; }],
  ['substitute Node runner', report => { report.executionRecipe = identity('console.log("2")'); }],
  ['missing full Runtime Exception notice', report => { report.licenses['COPYING.RUNTIME'].bytes = 20; }]
]) test('rejects ' + name, () => {
  const { report, expected } = proof(); mutate(report); assert.throws(() => verifySimdHeaderQualification(report, expected));
});
