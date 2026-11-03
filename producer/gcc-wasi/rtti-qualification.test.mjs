import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { units, cases, diagnostics, exceptionBoundaries, requiredCounts, wasiRunnerSource } from './rtti-fixtures.mjs';
import { verifyRttiQualificationOptions, verifyRttiRuntimeProfile, verifyRttiQualification } from './rtti-qualification.mjs';

const runtime = rtti => ({ rtti, exceptions: false, threads: false,
  timezoneDatabase: false, debugger: false, stdModules: false,
  ...(rtti ? { compilerFlags: { CXXFLAGS: '-O0 -fno-exceptions -frtti', EXTRA_CXX_FLAGS: '-fno-exceptions' } } : {}) });
const qualified = () => ({ status: 'passed', rtti: true, exceptions: false,
  profiles: { disabled: 2, default: 1, enabled: 2 },
  cases: [['stl-static-multiple', 'disabled'], ['iostream', 'disabled'], ['rtti-gnu-default', 'default'], ['rtti-gnu-enabled', 'enabled'], ['rtti-streambuf-print', 'enabled']].map(([id, rtti]) => ({
    id, rtti, status: 'passed', exitCode: 0,
    command: ['g++', '-fno-exceptions', ...(rtti === 'default' ? [] : [rtti === 'enabled' ? '-frtti' : '-fno-rtti'])]
  })) });

test('RTTI source or explicit proof requires the native proof, linker and GNU runtime', () => {
  const patches = [{ path: 'patches/0019-rtti-one-only.patch' }];
  const options = { rttiQualification: 'proof.json', nativeLinker: 'wasm-ld', libstdcxx: 'gnu' };
  verifyRttiQualificationOptions(patches, options);
  verifyRttiQualificationOptions([], options);
  verifyRttiQualificationOptions([], {});
  for (const name of Object.keys(options)) {
    const changed = { ...options }; delete changed[name];
    assert.throws(() => verifyRttiQualificationOptions(patches, changed), new RegExp(name));
  }
  assert.throws(() => verifyRttiQualificationOptions([], { rttiQualification: 'proof' }), /nativeLinker/);
});

test('the unchanged false runtime and a qualified true runtime are distinct package profiles', () => {
  verifyRttiRuntimeProfile(runtime(false), runtime(false), false);
  verifyRttiRuntimeProfile(runtime(true), runtime(true), true, qualified());
  for (const build of [false, true]) for (const receipt of [false, true]) for (const proof of [false, true]) {
    if (build === receipt && receipt === proof) continue;
    assert.throws(() => verifyRttiRuntimeProfile(runtime(build), runtime(receipt), proof), /qualification differ/);
  }
});

test('configure overrides and incomplete GNU default/off runs cannot enable the capability', () => {
  for (const change of [
    build => { build.compilerFlags.EXTRA_CXX_FLAGS += ' -fno-rtti'; },
    build => { build.compilerFlags.CXXFLAGS = '-fno-exceptions'; },
    build => { build.compilerFlags.EXTRA_CXX_FLAGS += ' -fexceptions'; }
  ]) {
    const build = runtime(true); change(build);
    assert.throws(() => verifyRttiRuntimeProfile(build, runtime(true), true, qualified()));
  }
  for (const change of [
    report => { report.cases.pop(); },
    report => { report.cases[0] = report.cases[1]; },
    report => { report.cases[0].exitCode = 1; },
    report => { report.cases[2].command.push('-frtti'); },
    report => { report.cases[3].command.push('-fno-rtti'); },
    report => { report.cases[1].command.push('-fexceptions'); },
    report => { report.rtti = false; }
  ]) {
    const report = qualified(); change(report);
    assert.throws(() => verifyRttiRuntimeProfile(runtime(true), runtime(true), true, report));
  }
});

test('a missing or nonboolean RTTI capability cannot qualify a runtime', () => {
  for (const value of [undefined, null, 0, 1, 'true', {}, []]) {
    assert.throws(() => verifyRttiRuntimeProfile(runtime(value), runtime(true), true));
    assert.throws(() => verifyRttiRuntimeProfile(runtime(true), runtime(value), true));
    assert.throws(() => verifyRttiRuntimeProfile(runtime(true), runtime(true), value));
  }
});

test('RTTI cannot silently enable exceptions or unrelated GNU runtime features', () => {
  for (const feature of ['exceptions', 'threads', 'timezoneDatabase', 'debugger', 'stdModules']) {
    assert.throws(() => verifyRttiRuntimeProfile({ ...runtime(true), [feature]: true }, runtime(true), true), new RegExp(feature));
    assert.throws(() => verifyRttiRuntimeProfile(runtime(true), { ...runtime(true), [feature]: true }, true), new RegExp(feature));
  }
});

const hash = value => createHash('sha256').update(value).digest('hex');
const receipt = name => ({ path: '/synthetic/' + name, bytes: 1, sha256: hash(name) });
const bytes = value => ({ bytes: Buffer.byteLength(value), sha256: hash(value) });
const command = (tool, argv, more = {}) => ({ command: tool.path, argv, status: 0, signal: null,
  stdin: null, stdout: '', stderr: '', ...more });

// Synthetic admission records are never executed, reopened or included in a
// bundle. Mutations below cover the proof gate independently of compiler tests.
function matrix() {
  const tools = Object.fromEntries(['gcc', 'gccCpp', 'xgcc', 'clang', 'clangCpp', 'assembler', 'objdump', 'validator', 'linker', 'node'].map(name => [name, receipt(name)]));
  const archives = Object.fromEntries(['crt', 'libc', 'libm', 'libstdcxx', 'libsupcxx', 'builtins'].map(name => [name, receipt('lib/' + name)]));
  const runtime = { archives, sysroot: '/synthetic/sysroot', gnuSysroot: '/synthetic/gnu',
    headers: {}, headerRoots: { gcc: '/synthetic/gcc/include' },
    gnuIncludePaths: ['/synthetic/gnu/include/c++/17', '/synthetic/gnu/include/c++/17/wasm32-wasi',
      '/synthetic/gnu/include/c++/17/backward', '/synthetic/gcc/include', '/synthetic/sysroot/include/wasm32-wasi'],
    gnuBuild: receipt('gnu-build'), gnuReceipt: receipt('gnu-receipt'), gnuQualification: receipt('gnu-qualification') };
  const expected = { tools, runtime, recipes: { harness: receipt('harness') }, sourceLock: receipt('lock'),
    nativeBuild: receipt('native'), fixtures: receipt('fixtures'), assemblerProvenance: receipt('wabt'),
    gccSource: { source: 'gcc-test' }, assemblerSource: { source: 'wabt-test' } };
  const report = { ...structuredClone(expected), schemaVersion: 1, kind: 'gcc-wasi-native-rtti-qualification',
    status: 'passed', inputsUnchanged: true, counts: structuredClone(requiredCounts),
    runner: { ...receipt('runner.mjs'), ...bytes(wasiRunnerSource) }, units: [], cases: [], diagnostics: [], exceptionBoundaries: [] };
  function compile(unit, rejected = false) {
    const cpp = unit.language === 'cpp', gcc = unit.compiler === 'gcc';
    const dir = '/synthetic/' + unit.id.replaceAll(':', '--');
    const source = { ...receipt('source'), path: dir + (cpp ? '/source.cc' : '/source.c'), ...bytes(unit.code) };
    const assembly = { ...receipt('assembly'), path: dir + '/source.wat' }, object = { ...receipt('object'), path: dir + '/source.o' };
    const common = ['-O' + unit.optimization, '-std=' + unit.standard, '-mno-simd128', '-fdiagnostics-color=never',
      '-Werror=attributes', '-D__GCC_WASI_SINGLE_THREAD__=1', ...unit.flags,
      ...(cpp ? ['-fno-exceptions', '-fuse-cxa-atexit', '-fno-threadsafe-statics',
        ...(unit.rtti === 'enabled' ? ['-frtti'] : unit.rtti === 'disabled' ? ['-fno-rtti'] : [])]
        : ['-Werror=implicit-function-declaration'])];
    const includePaths = cpp ? runtime.gnuIncludePaths.filter(name => gcc || name !== runtime.headerRoots.gcc)
      : [...(gcc ? [runtime.headerRoots.gcc] : []), '/synthetic/sysroot/include/wasm32-wasi'];
    const argv = gcc ? ['-quiet', '-nostdinc', ...common, ...includePaths.flatMap(name => ['-isystem', name]), source.path, '-o', assembly.path]
      : ['--target=wasm32-wasi', '--sysroot=/synthetic/sysroot', ...(cpp ? ['-nostdinc++'] : []), ...common,
        ...includePaths.flatMap(name => ['-isystem', name]), '-c', source.path, '-o', object.path];
    return { id: unit.id, status: 'passed', fixtureSha256: hash(JSON.stringify(unit)), source,
      headers: Object.fromEntries(Object.entries(unit.headers).map(([name, code]) => [name, { path: dir + '/' + name, ...bytes(code) }])),
      ...(rejected ? { requiredDiagnostics: unit.requiredDiagnostics } : { object, ...(gcc ? { assembly } : {}) }),
      commands: { compile: command(tools[unit.compiler + (cpp ? 'Cpp' : '')], argv,
        rejected ? { status: 1, stderr: unit.requiredDiagnostics.join('\n') } : {}),
      ...(!rejected && gcc ? { assemble: command(tools.assembler, ['-r', '--enable-annotations', assembly.path, '-o', object.path]) } : {}),
      ...(!rejected ? { validate: command(tools.validator, [object.path]) } : {}) } };
  }
  report.units = units.map(unit => compile(unit));
  report.diagnostics = diagnostics.map(unit => compile(unit, true));
  const byId = new Map(report.units.map(entry => [entry.id, entry]));
  function link(fixture, boundary = false) {
    const rejected = fixture.expectedLinkRejection;
    const program = receipt(fixture.id.replaceAll(':', '--') + '/program.wasm');
    const argv = ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', program.path, archives.crt.path, '-L/synthetic/lib',
      ...fixture.units.map(id => byId.get(id).object.path), ...(fixture.runtime === 'gnu' ? [archives.libstdcxx.path, archives.libsupcxx.path] : []),
      '-lm', '-lc', archives.builtins.path];
    return { ...structuredClone(fixture), status: 'passed', fixtureSha256: hash(JSON.stringify(fixture)),
      expectedStdout: fixture.stdout, ...(rejected ? {} : { program }),
      ...(!boundary ? { outcome: rejected ? 'link-rejection' : 'runtime-pass', ...(rejected ? {} : { stdout: fixture.stdout, stderr: '' }) } : {}),
      commands: { link: command(tools.linker, argv, rejected ? { status: 1, stderr: fixture.requiredLinkDiagnostics.join('\n') } : {}),
        ...(!rejected && !boundary ? { run: command(tools.node, ['--no-warnings', report.runner.path, program.path], { stdin: fixture.stdin, stdout: fixture.stdout }) } : {}) } };
  }
  report.cases = cases.map(fixture => link(fixture));
  report.exceptionBoundaries = exceptionBoundaries.map(fixture => link(fixture, true));
  return { report, expected };
}

test('RTTI proof requires every hierarchy, profile, C common, diagnostic and exception-boundary case', () => {
  const { report, expected } = matrix();
  verifyRttiQualification(report, expected);
  for (const field of ['units', 'cases', 'diagnostics', 'exceptionBoundaries']) {
    const missing = structuredClone(report); missing[field].pop();
    assert.throws(() => verifyRttiQualification(missing, expected), /Incomplete/);
    const duplicate = structuredClone(report); duplicate[field][0] = duplicate[field][1];
    assert.throws(() => verifyRttiQualification(duplicate, expected), /Incomplete/);
  }
});

test('RTTI source, header, tool, archive and runner changes invalidate qualification', () => {
  const { report, expected } = matrix();
  for (const edit of [
    value => { value.units[0].source.sha256 = '0'.repeat(64); },
    value => { value.units[0].headers['classes.hpp'].bytes++; },
    value => { value.units[0].headers['classes.hpp'].path = '/wrong/classes.hpp'; },
    value => { value.units[0].fixtureSha256 = '0'.repeat(64); },
    value => { value.tools.gccCpp.sha256 = '0'.repeat(64); },
    value => { value.recipes.harness.bytes++; },
    value => { value.runtime.archives.libsupcxx.bytes++; },
    value => { value.runtime.gnuBuild.bytes++; },
    value => { value.runner.sha256 = '0'.repeat(64); },
    value => { value.gccSource.source = 'another-source'; }
  ]) {
    const changed = structuredClone(report); edit(changed);
    assert.throws(() => verifyRttiQualification(changed, expected));
  }
});

test('RTTI proof binds exact compiler/include/link arguments and original runtime stdin/stdout', () => {
  const { report, expected } = matrix();
  for (const edit of [
    value => { value.units[0].commands.compile.argv.push('-fno-rtti'); },
    value => { value.units[0].commands.compile.argv.push('-isystem', '/another/include'); },
    value => { value.units[0].commands.compile.argv.push('-fsyntax-only'); },
    value => { value.units[0].commands.compile.command = '/another/cc1plus'; },
    value => { value.cases[0].commands.link.argv.shift(); },
    value => { value.cases[0].commands.link.argv.splice(9, 2, ...value.cases[0].commands.link.argv.slice(9, 11).reverse()); },
    value => { value.cases[0].commands.run.stdin = '0 7\n'; },
    value => { value.cases[0].commands.run.stdout = 'wrong\n'; },
    value => { value.cases[0].commands.run.argv.push('another-program'); },
    value => { value.units.find(entry => entry.id.endsWith(':default')).commands.compile.argv.push('-frtti'); }
  ]) {
    const changed = structuredClone(report); edit(changed);
    assert.throws(() => verifyRttiQualification(changed, expected));
  }
});

test('strict ABI/duplicate rejection and exception-only linkage cannot become successful RTTI execution', () => {
  const { report, expected } = matrix();
  for (const edit of [
    value => { value.cases.find(entry => entry.expectedLinkRejection).commands.link.status = 0; },
    value => { value.cases.find(entry => entry.expectedLinkRejection).commands.link.stderr = 'unrelated error'; },
    value => { value.exceptionBoundaries[0].commands.run = value.cases[0].commands.run; },
    value => { value.exceptionBoundaries[0].execution = 'successful execution'; },
    value => { value.diagnostics[0].commands.compile.stderr = 'unrelated error'; },
    value => { value.diagnostics[0].commands.compile.status = 0; }
  ]) {
    const changed = structuredClone(report); edit(changed);
    assert.throws(() => verifyRttiQualification(changed, expected));
  }
});
