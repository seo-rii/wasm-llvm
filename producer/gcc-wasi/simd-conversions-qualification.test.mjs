import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identity } from '../clang-browser/cross/package.mjs';
import { verifySimdConversionsQualification, verifySimdConversionsQualificationOptions } from './package.mjs';
import { cases, disabledCases, diagnosticCases } from './simd-conversions-fixtures.mjs';
import { conversionInstructions } from './simd-conversions-inspect.mjs';

const receipt = label => identity(Buffer.from(`synthetic ${label} receipt bytes`));
function proof() {
  const names = { gcc: 'cc1', gccCpp: 'cc1plus', assembler: 'wat2wasm', objdump: 'wasm-objdump', linker: 'wasm-ld', validator: 'wasm-validate', node: 'node' };
  const tools = Object.fromEntries(Object.keys(names).map(name => [name, receipt(name)]));
  const toolPaths = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, `/measured/${name}`]));
  const report = { kind: 'gcc-wasi-native-simd-conversions-qualification', status: 'passed', inputsUnchanged: true,
    gccCommit: 'synthetic-pinned-gcc-commit', compiler: tools.gcc, compilerCpp: tools.gccCpp,
    assembler: tools.assembler, objdump: tools.objdump, linker: tools.linker, node: tools.node, validator: tools.validator,
    fixture: receipt('fixture'), testRecipe: receipt('harness'), inspectionRecipe: receipt('inspector'),
    sourceLock: receipt('lock'), gccSource: { patches: [{ path: 'patches/0015-simd-conversions.patch', sha256: 'a'.repeat(64) }] },
    headers: { gcc: { 'limits.h': receipt('gcc header') }, target: { 'stdio.h': receipt('target header') } },
    targetSource: { 'simd.md': receipt('simd md') }, runtime: { 'libc.a': receipt('libc') },
    toolPaths, inputs: Object.fromEntries(Object.entries(tools).map(([key, value]) => [toolPaths[key], value])), cases: [], defaultControls: [], diagnostics: [] };
  const command = (key, argv, stdout = '', status = 0, stderr = '') => ({ command: toolPaths[key], argv, status, signal: null, stdout, stderr });
  const options = (fixture, profile) => [`-O${fixture.request.optimization}`, `-std=${fixture.request.standard}`,
    ...(profile === 'default' ? [] : [profile === 'disabled' ? '-mno-simd128' : '-msimd128'])];
  function execution(fixture, profile) {
    let instructions = [...fixture.requiredInstructions];
    if (fixture.semanticKind === 'scalar-fallback-integer-to-float') instructions.push('f64.convert_i64_s');
    if (fixture.semanticKind === 'scalar-fallback-float-to-integer') instructions.push('i64.trunc_f64_u');
    if (!instructions.length) instructions = ['i32.const'];
    instructions.push('end');
    const name = fixture.request.language === 'cpp' ? '_ZL7convertDv4_f' : 'convert';
    const disassembly = `000010 func[2] <${name}>:\n` + instructions.map((opcode, index) => ` ${(0x11 + index).toString(16)}: fd f8 01 | ${opcode}`).join('\n');
    return { id: fixture.id + (profile === 'default' ? '-default' : ''), fixture: fixture.id, profile, semanticKind: fixture.semanticKind,
      status: 'passed', source: identity(Buffer.from(fixture.request.code)), stdin: fixture.stdin, stdout: fixture.stdout,
      assembly: receipt('assembly'), object: receipt('object'), wasm: receipt('program'), instructions,
      conversionFunction: conversionInstructions(disassembly),
      imports: [{ module: 'wasi_snapshot_preview1', name: 'fd_write', kind: 'function' }], exports: [{ name: 'memory', kind: 'memory' }, { name: '_start', kind: 'function' }],
      commands: [command(fixture.request.language === 'cpp' ? 'gccCpp' : 'gcc', options(fixture, profile)), command('assembler', ['-r', '--enable-annotations']),
        command('objdump', ['-d'], disassembly), command('linker', ['--fatal-warnings']), command('node', ['main.wasm'], fixture.stdout)],
      simdDisabledValidation: command('validator', ['--disable-simd', 'main.wasm'], '', fixture.request.simd ? 1 : 0) };
  }
  report.cases = [...cases, ...disabledCases].map(fixture => execution(fixture, fixture.request.simd ? 'enabled' : 'disabled'));
  report.defaultControls = disabledCases.map(fixture => execution(fixture, 'default'));
  const matrix = [...cases.filter(fixture => fixture.builtin).flatMap(fixture => ['disabled', 'default'].map(profile => ({ fixture, profile }))),
    ...diagnosticCases.map(fixture => ({ fixture, profile: 'enabled-invalid' }))];
  report.diagnostics = matrix.map(({ fixture, profile }) => ({ id: `${fixture.id}-${profile}`, fixture: fixture.id, profile,
    source: identity(Buffer.from(fixture.request.code)), emittedSimd: false,
    command: command(fixture.request.language === 'cpp' ? 'gccCpp' : 'gcc', options(fixture, profile), '', 1,
      profile !== 'enabled-invalid' ? 'SIMD128 is disabled' : fixture.kind.startsWith('too-') ? `${fixture.kind.replace('-', ' ')} arguments` : 'incompatible type') }));
  report.disabledDiagnostic = report.diagnostics[0].command; report.defaultDiagnostic = report.diagnostics[1].command;
  const expected = { gccCommit: report.gccCommit, compilerSha256: tools.gcc.sha256, compilerCppSha256: tools.gccCpp.sha256,
    ...Object.fromEntries(['assembler', 'objdump', 'linker', 'node', 'validator', 'fixture', 'testRecipe', 'inspectionRecipe', 'sourceLock', 'gccSource', 'headers', 'targetSource', 'runtime'].map(key => [key, report[key]])) };
  return { report, expected };
}

test('patch0015 requires its own proof and every preceding SIMD/vector gate', () => {
  const patches = [{ path: 'patches/0015-simd-conversions.patch' }];
  const options = Object.fromEntries(['simdQualification', 'simdExtendedQualification', 'simdSaturatingQualification', 'simdConversionsQualification', 'vectorAbiQualification', 'nativeLinker'].map(key => [key, 'proof']));
  verifySimdConversionsQualificationOptions(patches, options);
  verifySimdConversionsQualificationOptions([], {});
  for (const key of Object.keys(options)) assert.throws(() => verifySimdConversionsQualificationOptions(patches, { ...options, [key]: undefined }), new RegExp(key));
});

test('conversion proof binds176 canonical cases,12 default controls and192 rejections (synthetic receipts)', () => {
  const { report, expected } = proof();
  assert.equal(report.cases.length, 176); assert.equal(report.defaultControls.length, 12); assert.equal(report.diagnostics.length, 192);
  verifySimdConversionsQualification(report, expected);
  const reject = mutation => { const changed = structuredClone(report); mutation(changed); assert.throws(() => verifySimdConversionsQualification(changed, expected)); };
  for (const field of ['fixture', 'testRecipe', 'inspectionRecipe', 'sourceLock', 'objdump', 'validator', 'node'])
    reject(report => { report[field] = receipt('stale ' + field); });
  reject(report => { report.kind = 'gcc-wasi-native-simd-saturating-qualification'; });
  reject(report => { report.inputsUnchanged = false; });
  reject(report => { report.compiler.sha256 = 'f'.repeat(64); });
  reject(report => { report.compilerCpp.sha256 = 'f'.repeat(64); });
  reject(report => { report.gccSource.patches = []; });
  reject(report => { report.headers.gcc['limits.h'] = receipt('changed header'); });
  reject(report => { report.toolPaths.gcc = '/unmeasured/cc1'; });
  reject(report => { report.cases.pop(); });
  reject(report => { report.cases[0].semanticKind = 'another conversion'; });
  reject(report => { delete report.cases[0].object; });
  reject(report => { report.cases[0].stdin = '4\n'; });
  reject(report => { report.cases[0].simdDisabledValidation.status = 0; });
  reject(report => { report.defaultControls.pop(); });
  reject(report => { report.defaultControls[0].commands[0].argv.push('-mno-simd128'); });
  reject(report => { report.defaultControls[0].stdout = 'incorrect'; });
  reject(report => { report.defaultControls[0].exports = []; });
  reject(report => { report.defaultControls[0].commands[4].status = 1; });
  reject(report => { report.defaultControls[0].simdDisabledValidation.status = 1; });
  reject(report => { report.diagnostics.pop(); });
  reject(report => { report.diagnostics[0].command.status = 0; });
  reject(report => { report.diagnostics[0].emittedSimd = true; });
  reject(report => { report.diagnostics[1].command.argv.push('-mno-simd128'); });
  reject(report => { report.diagnostics.at(-1).source = receipt('different invalid source'); });
  reject(report => { report.diagnostics.at(-1).command.stderr = 'unrelated failure'; });
  reject(report => { report.cases[0].commands[2].stdout = report.cases[0].commands[2].stdout.replace('<convert>', '<unrelated>'); });
  reject(report => {
    const entry = report.cases[0], opcode = entry.instructions[0];
    entry.commands[2].stdout = `000001 func[1] <unrelated>:\n 000002: fd f8 01 | ${opcode}\n000010 func[2] <convert>:\n 000011: 0b | end\n`;
    entry.instructions = [opcode, 'end']; entry.conversionFunction = conversionInstructions(entry.commands[2].stdout);
  });
  reject(report => {
    const entry = report.cases.find(entry => entry.semanticKind === 'scalar-fallback-integer-to-float');
    entry.commands[2].stdout = '000010 func[2] <convert>:\n 000011: fd 00 | v128.load\n 000014: 0b | end\n';
    entry.instructions = ['v128.load', 'end']; entry.conversionFunction = conversionInstructions(entry.commands[2].stdout);
  });
});
