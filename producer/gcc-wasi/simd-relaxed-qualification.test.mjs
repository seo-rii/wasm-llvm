import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { cases, disabledCases, diagnosticCases, relaxedProfiles } from './simd-relaxed-fixtures.mjs';
import { verifyRelaxedInstructions } from './simd-relaxed-inspect.mjs';
import { identity, relaxedCompilerArgs, relaxedExecutions, relaxedWasiRunner, verifyRelaxedSimdQualification,
  verifyRelaxedSimdQualificationOptions, verifyRelaxedSimdHeaderInstallation, assertRelaxedAssemblyReplay } from './simd-relaxed-qualification.mjs';

const hash = text => identity(Buffer.from(text));
const prerequisites = ['simdRelaxedQualification', 'simdHeaderQualification', 'simdConversionsQualification', 'simdSaturatingQualification',
  'simdExtendedQualification', 'simdQualification', 'vectorAbiQualification', 'nativeLinker'];

// Deliberately nonexistent paths: this is a metadata-contract fixture, never
// compilation evidence. The real reopener must read files and rerun the tools.
function contractReceipt() {
  const toolPaths = Object.fromEntries(['gcc', 'gccCpp', 'assembler', 'objdump', 'linker', 'node', 'validator'].map(name => [name, `/contract-only/tools/${name}`]));
  const headerRoots = { gcc: '/contract-only/gcc/include', target: '/contract-only/sysroot/include' };
  const report = { kind: 'gcc-wasi-native-simd-relaxed-qualification', status: 'passed', inputsUnchanged: true, sourcePath: '/contract-only/source',
    toolPaths, tools: Object.fromEntries(Object.keys(toolPaths).map(name => [name, hash(name)])), headerRoots, headers: { gcc: {}, target: {} },
    gccSource: {}, targetSource: {}, publicHeader: { source: hash('public header'), installed: hash('public header') },
    runtime: Object.fromEntries(['crt1-command.o', 'libc.a', 'libm.a', 'libclang_rt.builtins-wasm32.a'].map(name => [name, hash(name)])),
    executionRecipe: hash(relaxedWasiRunner), cases: [], defaultControls: [], diagnostics: [] };
  for (const key of ['sourceLock', 'nativeBuild', 'sourceRecipe', 'buildRecipe', 'featureRecipe', 'fixtures', 'testRecipe', 'inspectionRecipe', 'gateRecipe']) report[key] = hash(key);
  const command = (name, argv, stdout = '', status = 0, stderr = '') => ({ command: toolPaths[name], argv, stdout, stderr, status, signal: null });
  const library = '/contract-only/sysroot/lib/wasm32-wasi', builtins = path.resolve(toolPaths.linker, '../../lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a');
  for (const { fixture, profile, id } of relaxedExecutions()) {
    const directory = `/contract-only/output/${id}`, source = directory + (fixture.request.language === 'cpp' ? '/main.cc' : '/main.c');
    const assembly = directory + '/main.wat', object = directory + '/main.o', program = directory + '/main.wasm';
    const name = fixture.request.relaxedSimd ? 'relaxed' : 'add';
    const disassembly = `000000 func[0] <${name}>:\n` + (fixture.requiredInstructions.length ? fixture.requiredInstructions : ['i32.add']).map((opcode, i) => `00000${i + 1}: 00 | ${opcode}\n`).join('');
    const entry = { id, fixture: fixture.id, profile, status: 'passed', source: hash(fixture.request.code), fixtureValue: hash(JSON.stringify(fixture)), stdin: fixture.stdin, stdout: fixture.stdout,
      decoded: verifyRelaxedInstructions(fixture, disassembly), features: { ...(fixture.request.simd ? { simd128: '+' } : {}), ...(fixture.request.relaxedSimd ? { 'relaxed-simd': '+' } : {}) },
      imports: [{ module: 'wasi_snapshot_preview1', name: 'fd_write', kind: 'function' }], exports: [{ name: '_start', kind: 'function' }, { name: 'memory', kind: 'memory' }],
      commands: [
        command(fixture.request.language === 'cpp' ? 'gccCpp' : 'gcc', relaxedCompilerArgs(fixture, source, assembly, headerRoots, profile)),
        command('assembler', ['-r', '--enable-annotations', ...(fixture.request.relaxedSimd ? ['--enable-relaxed-simd'] : []), assembly, '-o', object]),
        command('objdump', ['-d', object], disassembly),
        command('linker', ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', program, path.join(library, 'crt1-command.o'), '-L' + library, object, '-lm', '-lc', builtins]),
        command('node', ['--no-warnings', '/contract-only/output/run-wasi.mjs', program], fixture.stdout)
      ], relaxedDisabledValidation: command('validator', [program], '', fixture.request.relaxedSimd ? 1 : 0) };
    (profile === 'default' ? report.defaultControls : report.cases).push(entry);
  }
  for (const fixture of diagnosticCases) {
    const directory = `/contract-only/output/${fixture.id}`, source = directory + (fixture.request.language === 'cpp' ? '/main.cc' : '/main.c');
    const stderr = fixture.profile === 'enabled-invalid' ? 'incompatible type' : '-mrelaxed-simd requires -msimd128';
    report.diagnostics.push({ id: fixture.id, profile: fixture.profile, source: hash(fixture.request.code), fixtureValue: hash(JSON.stringify(fixture)), emittedRelaxed: false,
      command: command(fixture.request.language === 'cpp' ? 'gccCpp' : 'gcc', relaxedCompilerArgs(fixture, source, directory + '/main.wat', headerRoots, fixture.profile), '', 1, stderr) });
  }
  return { report, expected: { ...structuredClone(report), cases, disabledCases, diagnosticCases } };
}

test('relaxed packaging requires all earlier SIMD and ABI qualification gates', () => {
  const patches = [{ path: 'patches/0022-relaxed-simd.patch' }];
  const options = Object.fromEntries(prerequisites.map(key => [key, '/proof']));
  verifyRelaxedSimdQualificationOptions(patches, options);
  verifyRelaxedSimdQualificationOptions([], {});
  for (const missing of prerequisites) {
    const partial = { ...options }; delete partial[missing];
    assert.throws(() => verifyRelaxedSimdQualificationOptions(patches, partial), new RegExp(missing));
  }
});

test('qualified header bytes and complete license notices survive every installation', () => {
  const source = Buffer.from('GPL-3.0-or-later WITH GCC-exception-3.1\n' + relaxedProfiles.map(profile => profile.name + ' (').join('\n') + ' '.repeat(1000));
  const licenses = { COPYING3: Buffer.alloc(30001, 1), 'COPYING.RUNTIME': Buffer.alloc(3001, 2) };
  const installation = { source, installed: source, browser: source, packaged: source, licenses, packagedLicenses: licenses };
  verifyRelaxedSimdHeaderInstallation(installation);
  for (const stage of ['installed', 'browser', 'packaged']) assert.throws(() => verifyRelaxedSimdHeaderInstallation({ ...installation, [stage]: Buffer.from('changed') }), /Changed/);
  assert.throws(() => verifyRelaxedSimdHeaderInstallation({ ...installation, packagedLicenses: { ...licenses, COPYING3: Buffer.from('notice only') } }), /Changed packaged/);
});

test('metadata contract pins fixtures, real command flags, runtime identities and all diagnostics', () => {
  const { report, expected } = contractReceipt();
  verifyRelaxedSimdQualification(report, expected);
  const mutations = [
    value => { value.sourcePath = '/different-source'; },
    value => { value.runtime['libc.a'] = hash('different archive'); },
    value => { value.featureRecipe = hash('different inspection'); },
    value => { value.cases[0].source = hash('hardcoded output'); },
    value => { value.cases[0].commands[0].argv.splice(1, 0, '-D__builtin_wasm_relaxed_swizzle_i8x16=fake'); },
    value => { value.cases[0].commands[1].argv = value.cases[0].commands[1].argv.filter(arg => arg !== '--enable-relaxed-simd'); },
    value => { value.cases[0].commands[3].argv.splice(1, 0, '--allow-undefined'); },
    value => { value.cases[0].commands[4].stderr = 'runtime warning'; },
    value => { value.cases[0].stdout = 'unknown\n'; },
    value => { value.cases[0].features['relaxed-simd'] = undefined; },
    value => { value.cases[0].relaxedDisabledValidation.status = 0; },
    value => { value.cases[0].commands[2].stdout = value.cases[0].commands[2].stdout.replace('<relaxed>', '<unrelated>'); },
    value => { value.defaultControls.pop(); },
    value => { value.diagnostics.pop(); },
    value => { value.diagnostics[0].command.status = 0; },
    value => { value.diagnostics[0].emittedRelaxed = true; }
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(report); mutate(changed);
    assert.throws(() => verifyRelaxedSimdQualification(changed, expected));
  }
});

const importA = '  (import "env" "alpha" (func $alpha (@sym) (param i32) (result i32)))';
const importB = '  (import "env" "beta" (func $beta (@sym) (param i32 i32) (result i32)))';
const replayWat = imports => `(module\n${imports.join('\n')}\n  (data (i32.const 0) "fake (import) and \\"quote\\"")\n  (; outer (; nested import comment ;) ;)\n  (func $main (result i32) (call $alpha (i32.const 7)))\n)\n`;

test('assembly replay permits complete import ordering while preserving strings and nested comments', () => {
  assertRelaxedAssemblyReplay(Buffer.from(replayWat([importA, importB])), Buffer.from(replayWat([importB, importA])));
  const escaped = '  (import "e(n)v" "quote\\\"(name)" (func $quoted (@sym) (result i64)))';
  assertRelaxedAssemblyReplay(replayWat([importA, escaped, importB]), replayWat([importB, importA, escaped]));
});

test('rehashed instructions, signatures, names, missing and duplicate imports cannot pass source replay', () => {
  const fresh = replayWat([importB, importA]), original = replayWat([importA, importB]);
  const attacks = [
    original.replace('i32.const 7', 'i32.const 8'),
    original.replace('(param i32 i32)', '(param i64 i32)'),
    original.replace('"alpha"', '"renamed"'),
    original.replace('$alpha', '$other'),
    replayWat([importA]),
    replayWat([importA, importB, importB]),
    original.replace('nested import comment', 'changed comment'),
    original.replace('fake (import)', 'different data')
  ];
  for (const stored of attacks) {
    const forgedReceipt = { assembly: hash(stored) };
    assert.deepEqual(identity(Buffer.from(stored)), forgedReceipt.assembly);
    assert.throws(() => assertRelaxedAssemblyReplay(stored, fresh), /changed beyond|single-line|Unclosed|Unbalanced/);
  }
});

test('import-order normalization rejects incomplete, multiline and late declarations', () => {
  const original = replayWat([importA, importB]);
  for (const changed of [
    original.replace(importB, importB.slice(0, -1)),
    original.replace(importB, importB.replace(' (func', '\n    (func')),
    original.replace(importB, importB + ' (func $injected)'),
    original.replace(importB + '\n', '').replace('\n)\n', '\n' + importB + '\n)\n')
  ]) assert.throws(() => assertRelaxedAssemblyReplay(original, changed));
  assert.throws(() => assertRelaxedAssemblyReplay(Buffer.from(original), Buffer.from('\uFEFF' + original)), /Expected GCC module/);
  assert.throws(() => assertRelaxedAssemblyReplay(Buffer.from(original), Buffer.concat([Buffer.from(original), Buffer.from([0xff])])), /encoded data/);
});
