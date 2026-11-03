import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { units, cases, requiredCounts } from './weakref-fixtures.mjs';
import { verifyWeakrefQualification, verifyWeakrefQualificationOptions, weakrefWasiRunner } from './weakref-qualification.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const receipt = name => ({ path: '/synthetic/' + name, bytes: 1, sha256: hash(name) });
const command = (tool, argv, extra = {}) => ({ command: tool.path, argv, status: 0, signal: null, stdin: '', stdout: '', stderr: '', ...extra });

// Synthetic records exercise admission failures only. They are never reopened,
// executed, packaged, or presented as compiler qualification evidence.
function fixture() {
  const tools = Object.fromEntries(['gcc', 'gccCpp', 'xgcc', 'clang', 'clangCpp', 'assembler', 'objdump', 'validator', 'linker', 'node'].map(name => [name, receipt(name)]));
  const archives = Object.fromEntries(['crt', 'libc', 'libm', 'libstdcxx', 'libsupcxx', 'builtins'].map(name => [name, receipt('lib/' + name)]));
  const expected = { sourceLock: receipt('lock'), nativeBuild: receipt('native'), fixtures: receipt('fixtures'),
    assemblerProvenance: receipt('assembler-provenance'), gccSource: { source: 'test-gcc' }, assemblerSource: { source: 'test-wabt' },
    tools, recipes: { harness: receipt('harness') }, runtime: { archives, headers: {}, sysroot: '/synthetic/sysroot', gnuSysroot: '/synthetic/gnu', headerRoots: { gcc: '/synthetic/include' }, gnuIncludePaths: ['/synthetic/gnu/include/c++/17', '/synthetic/gnu/include/c++/17/wasm32-wasi', '/synthetic/gnu/include/c++/17/backward', '/synthetic/include', '/synthetic/sysroot/include/wasm32-wasi'],
      gnuBuild: receipt('gnu-build'), gnuQualification: receipt('gnu-qualification'), gnuReceipt: receipt('gnu-receipt') } };
  const report = { ...structuredClone(expected), schemaVersion: 1, kind: 'gcc-wasi-native-weakref-qualification',
    status: 'passed', inputsUnchanged: true, counts: structuredClone(requiredCounts), runner: { ...receipt('runner.mjs'), bytes: Buffer.byteLength(weakrefWasiRunner), sha256: hash(weakrefWasiRunner) }, units: [], cases: [] };
  for (const unit of units) {
    const source = { ...receipt(unit.id + '.c'), bytes: Buffer.byteLength(unit.code), sha256: hash(unit.code) };
    const object = receipt(unit.id + '.o'), assembly = unit.compiler === 'gcc' ? receipt(unit.id + '.wat') : undefined;
    const tool = tools[unit.compiler + (unit.language === 'cpp' ? 'Cpp' : '')];
    const cpp = unit.language === 'cpp', gcc = unit.compiler === 'gcc';
    const output = [source.path, '-o', (assembly || object).path];
    const cHeaders = ['-isystem', '/synthetic/sysroot/include/wasm32-wasi'];
    const gccHeaders = ['-nostdinc', '-isystem', '/synthetic/include', ...cHeaders];
    const target = ['--target=wasm32-wasi', '--sysroot=/synthetic/sysroot'];
    let argv;
    if (unit.suite === 'core') {
      const common = ['-O' + unit.optimization, cpp ? '-std=gnu++17' : '-std=gnu11', '-fdiagnostics-color=never'];
      argv = gcc ? ['-quiet', ...common, '-Werror=attributes', '-D__GCC_WASI_SINGLE_THREAD__=1', ...gccHeaders,
        ...(cpp ? ['-fno-exceptions', '-fno-rtti'] : ['-Werror=implicit-function-declaration']), ...output]
        : [...target, ...common, '-Werror=ignored-attributes', ...cHeaders, ...(cpp ? ['-fno-exceptions', '-fno-rtti', '-nostdinc++'] : []), '-c', ...output];
    } else if (unit.suite === 'gnu') {
      const common = ['-O' + unit.optimization, '-std=gnu++17', '-fno-exceptions', '-fno-rtti', '-fuse-cxa-atexit', '-fno-threadsafe-statics', '-fdiagnostics-color=never', '-Werror=attributes'];
      argv = gcc ? ['-quiet', ...common, '-nostdinc', '-D__GCC_WASI_SINGLE_THREAD__=1', ...expected.runtime.gnuIncludePaths.flatMap(root => ['-isystem', root]), ...output]
        : [...target, ...common, ...cHeaders, '-c', ...output];
    } else {
      const common = ['-O' + unit.optimization, cpp ? '-std=gnu++17' : '-std=gnu11', '-mno-simd128', '-fdiagnostics-color=never', '-Werror=attributes', '-D__GCC_WASI_SINGLE_THREAD__=1', ...(cpp ? ['-fno-exceptions', '-fno-rtti', '-fuse-cxa-atexit', '-fno-threadsafe-statics'] : [])];
      argv = gcc ? ['-quiet', ...common, ...gccHeaders, ...output] : [...target, ...common, ...cHeaders, '-c', ...output];
    }
    report.units.push({ id: unit.id, status: 'passed', fixtureSha256: hash(JSON.stringify(unit)), source, object,
      ...(assembly ? { assembly } : {}), commands: { compile: command(tool, argv),
        ...(assembly ? { assemble: command(tools.assembler, ['-r', '--enable-annotations', assembly.path, '-o', object.path]) } : {}),
        validate: command(tools.validator, [object.path]) } });
  }
  const byId = new Map(report.units.map(unit => [unit.id, unit]));
  for (const entry of cases) {
    const program = receipt(entry.id + '.wasm');
    const argv = ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', program.path, archives.crt.path, '-L/synthetic/lib',
      ...entry.units.map(id => byId.get(id).object.path), ...(entry.runtime === 'gnu' ? [archives.libstdcxx.path, archives.libsupcxx.path] : []),
      '-lm', '-lc', archives.builtins.path];
    const rejected = entry.expectedLinkRejection;
    report.cases.push({ ...structuredClone(entry), status: 'passed', fixtureSha256: hash(JSON.stringify(entry)),
      expectedStdout: entry.stdout, outcome: rejected ? 'link-rejection' : 'runtime-pass',
      commands: { link: command(tools.linker, argv, rejected ? { status: 1, stderr: entry.requiredLinkDiagnostics.join('\n') } : {}),
        ...(!rejected ? { run: command(tools.node, ['--no-warnings', '/synthetic/runner.mjs', program.path], { stdin: entry.stdin, stdout: entry.stdout }) } : {}) },
      ...(!rejected ? { program, stdout: entry.stdout } : {}) });
  }
  return { report, expected };
}

test('source18 requires the weakref proof, linker and GNU runtime', () => {
  const patches = [{ path: 'patches/0018-weak-references.patch' }];
  const options = { weakrefQualification: 'proof', nativeLinker: 'ld', libstdcxx: 'gnu' };
  assert.doesNotThrow(() => verifyWeakrefQualificationOptions(patches, options));
  for (const key of Object.keys(options)) {
    const changed = { ...options }; delete changed[key];
    assert.throws(() => verifyWeakrefQualificationOptions(patches, changed), new RegExp(key));
  }
  assert.doesNotThrow(() => verifyWeakrefQualificationOptions([], {}));
});

test('the complete synthetic matrix is structurally accepted, but omitted and duplicated cases are rejected', () => {
  const { report, expected } = fixture();
  verifyWeakrefQualification(report, expected);
  for (const field of ['units', 'cases']) {
    const missing = structuredClone(report); missing[field].pop();
    assert.throws(() => verifyWeakrefQualification(missing, expected), /Incomplete/);
    const duplicate = structuredClone(report); duplicate[field][1] = duplicate[field][0];
    assert.throws(() => verifyWeakrefQualification(duplicate, expected), /Incomplete/);
  }
});

test('source, assembler, recipe and GNU archive changes invalidate a weakref proof', () => {
  const { report, expected } = fixture();
  for (const edit of [
    value => { value.sourceLock.sha256 = '0'.repeat(64); },
    value => { value.gccSource.source = 'another-source'; },
    value => { value.assemblerSource.source = 'another-assembler'; },
    value => { value.recipes.harness.bytes++; },
    value => { value.runtime.archives.libsupcxx.sha256 = '0'.repeat(64); },
    value => { value.units[0].source.sha256 = '0'.repeat(64); },
    value => { value.units[0].fixtureSha256 = '0'.repeat(64); }
  ]) {
    const changed = structuredClone(report); edit(changed);
    assert.throws(() => verifyWeakrefQualification(changed, expected));
  }
});

test('both override orders and strict linker diagnostics are part of the contract', () => {
  const { report, expected } = fixture();
  const override = report.cases.findIndex(value => value.id.includes('weak-first') && value.units.length === 3);
  const swapped = structuredClone(report);
  const link = swapped.cases[override].commands.link.argv;
  [link[10], link[11]] = [link[11], link[10]];
  assert.throws(() => verifyWeakrefQualification(swapped, expected));
  const missing = structuredClone(report);
  missing.cases.find(value => value.expectedLinkRejection).commands.link.stderr = 'unrelated failure';
  assert.throws(() => verifyWeakrefQualification(missing, expected), /diagnostic/);
  const relaxed = structuredClone(report); relaxed.cases[0].commands.link.argv.shift();
  assert.throws(() => verifyWeakrefQualification(relaxed, expected));
});

test('changed runtime input/output, compiler profile and fake successful rejection are refused', () => {
  const { report, expected } = fixture();
  for (const edit of [
    value => { value.cases[0].commands.run.stdin = '4\n'; },
    value => { value.cases[0].commands.run.stdout = '1 1 14 23\n'; },
    value => { value.units[0].commands.compile.argv.push('-fsyntax-only'); },
    value => { value.units[0].commands.compile.argv.push('-O3'); },
    value => { value.units[0].commands.compile.argv.push('-isystem', '/wrong/headers'); },
    value => { value.runner.sha256 = '0'.repeat(64); },
    value => { value.cases.find(entry => entry.expectedLinkRejection).commands.link.status = 0; }
  ]) {
    const changed = structuredClone(report); edit(changed);
    assert.throws(() => verifyWeakrefQualification(changed, expected));
  }
});
