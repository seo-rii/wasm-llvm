import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { verifyCoverageQualificationOptions, verifyLibgcovBuild, reopenCoverageQualification } from './coverage-qualification.mjs';

const receipt = name => ({ path: '/synthetic/' + name, bytes: 1, sha256: '1'.repeat(64) });
const profile = { format: 'gcc-gcov', update: 'single', normalExit: true, manualGcovApi: false,
  pgo: false, threads: false, processPidSemantics: false, directoryCreation: false };
const command = (tool, argv) => ({ command: tool.path, argv, status: 0, stdin: null, stdout: '', stderr: '' });

// Admission controls only. These records are never reopened, executed or
// packaged as successful runtime evidence.
function fixture({ canonicalSources = false } = {}) {
  const expected = Object.fromEntries(['sourceLock', 'runtimeLock', 'nativeBuild', 'runtimeImport', 'getpid'].map(name => [name, receipt(name)]));
  Object.assign(expected, { gccSource: { source: 'gcc-source-test' },
    nativeCompiler: Object.fromEntries(['cc1', 'cc1plus', 'xgcc'].map(name => [name, receipt('compiler/' + name)])),
    recipes: { build: receipt('build') }, libc: { 'libc.a': receipt('sysroot/lib/wasm32-wasi/libc.a') },
    tools: Object.fromEntries(['assembler', 'validator', 'ar', 'nm', 'ranlib', 'linker'].map(name => [name, receipt(name)])),
    sources: Object.fromEntries(['libgcov-driver.c', 'libgcov-merge.c'].map(name => [name, receipt('gcc/libgcc/' + name)])),
    libraries: Object.fromEntries(['libgcov.a', 'libwasi-emulated-getpid.a'].map(name => [name, receipt(name)])) });
  const report = { ...structuredClone(expected), schemaVersion: 1, kind: 'gcc-wasi-libgcov-build',
    status: 'built-unverified', target: 'wasm32-wasi', inputsUnchanged: true, profile: { ...profile },
    configuration: Object.fromEntries(['Makefile', 'auto-target.h', 'libgcc_tm.h'].map(name => [name, receipt('configuration/' + name)])), objects: [], commands: [] };
  for (const [index, selection] of ['-DL_gcov', '-DL_gcov_merge_add'].entries()) {
    const source = expected.sources[index ? 'libgcov-merge.c' : 'libgcov-driver.c'];
    const assembly = receipt('object' + index + '.wat'), object = receipt('object' + index + '.o');
    const argv = ['-quiet', '-O0', '-g0', '-std=gnu11', '-fdiagnostics-color=never', '-nostdinc',
      '-D__GCC_WASI_SINGLE_THREAD__=1', '-D_WASI_EMULATED_GETPID=1', '-DIN_LIBGCC2', '-DIN_GCC',
      '-DCROSS_DIRECTORY_STRUCTURE', '-fbuilding-libgcc', '-fno-stack-protector',
      '-I/synthetic/configuration', '-I/synthetic/compiler', '-I/synthetic/gcc/libgcc', '-I/synthetic/gcc/gcc',
      '-I/synthetic/gcc/include', '-isystem', '/synthetic/compiler/include', '-isystem', '/synthetic/sysroot/include/wasm32-wasi',
      selection, source.path, '-o', assembly.path];
    report.objects.push({ selection,
      source: canonicalSources ? { ...source, path: '/canonical/gcc/libgcc/' + path.basename(source.path) } : source,
      assembly, object, headers: [receipt('header.h')], commands: {
      compile: command(report.nativeCompiler.cc1, argv),
      assemble: command(report.tools.assembler, ['-r', '--enable-annotations', assembly.path, '-o', object.path]),
      validate: command(report.tools.validator, [object.path]), symbols: command(report.tools.nm, ['--undefined-only', object.path]) } });
  }
  report.commands.push(command(report.tools.ar, ['rcs', report.libraries['libgcov.a'].path, ...report.objects.map(entry => entry.object.path)]));
  report.files = Object.entries(expected.libraries).map(([name, value]) => ({ path: 'lib/wasm32-wasi/' + name, bytes: value.bytes, sha256: value.sha256 }));
  return { report, expected };
}

test('coverage patch requires current native execution, runtime, analysis tool and linker evidence', () => {
  const patches = [{ path: 'patches/0020-coverage-profile.patch' }];
  const options = Object.fromEntries(['coverageQualification', 'libgcov', 'nativeGcov', 'nativeLinker', 'libstdcxx'].map(name => [name, name]));
  verifyCoverageQualificationOptions(patches, options);
  verifyCoverageQualificationOptions([], {});
  for (const name of Object.keys(options)) {
    const value = { ...options }; delete value[name];
    assert.throws(() => verifyCoverageQualificationOptions(patches, value), new RegExp(name));
  }
});

test('only the pinned official libgcov objects and supported runtime profile are admitted', () => {
  const { report, expected } = fixture();
  verifyLibgcovBuild(report, expected);
  for (const edit of [
    value => { value.objects.pop(); },
    value => { value.objects[1].selection = '-DL_gcov_merge_ior'; },
    value => { value.profile.pgo = true; },
    value => { value.profile.processPidSemantics = true; },
    value => { value.gccSource.source = 'another-source'; },
    value => { value.sourceLock.bytes++; },
    value => { value.getpid.bytes++; },
    value => { value.libraries['libgcov.a'].bytes++; },
    value => { value.files[0].sha256 = '0'.repeat(64); }
  ]) {
    const changed = structuredClone(report); edit(changed);
    assert.throws(() => verifyLibgcovBuild(changed, expected));
  }
});

test('official libgcov accepts logical compile paths with canonical frozen source receipts', () => {
  const { report, expected } = fixture({ canonicalSources: true });
  verifyLibgcovBuild(report, expected);
});

test('official libgcov still binds source arguments, content and include order to trusted inputs', () => {
  for (const index of [0, 1]) {
    const { report, expected } = fixture();
    report.objects[index].source = { ...report.objects[index].source,
      path: '/canonical/gcc/libgcc/' + path.basename(report.objects[index].source.path) };
    for (const sourcePath of [report.objects[index].source.path, '/untrusted/' + path.basename(report.objects[index].source.path)]) {
      const changed = structuredClone(report);
      changed.objects[index].commands.compile.argv.splice(-3, 1, sourcePath);
      assert.throws(() => verifyLibgcovBuild(changed, expected), /Changed official libgcov compile profile or include order/);
    }
    const changedContent = structuredClone(report);
    changedContent.objects[index].source.bytes++;
    assert.throws(() => verifyLibgcovBuild(changedContent, expected), /Official libgcov source changed/);
    const changedOrder = structuredClone(report);
    const argv = changedOrder.objects[index].commands.compile.argv;
    const libgcc = argv.indexOf('-I/synthetic/gcc/libgcc'), gcc = argv.indexOf('-I/synthetic/gcc/gcc');
    [argv[libgcc], argv[gcc]] = [argv[gcc], argv[libgcc]];
    assert.throws(() => verifyLibgcovBuild(changedOrder, expected), /Changed official libgcov compile profile or include order/);
  }
});

test('dummy-runtime defines, interrupted tools and altered assembly/archive inputs are rejected', () => {
  const { report, expected } = fixture();
  for (const edit of [
    value => { value.objects[0].commands.compile.argv.unshift('-Dinhibit_libc'); },
    value => { value.objects[0].commands.compile.argv.unshift('-DTARGET_POSIX_IO=1'); },
    value => { value.objects[0].commands.compile.argv.push('-fsyntax-only'); },
    value => { value.objects[0].commands.compile.command = '/another/compiler'; },
    value => { value.objects[0].commands.assemble.argv.shift(); },
    value => { value.objects[0].commands.validate.signal = 'SIGTERM'; },
    value => { value.commands[0].argv.pop(); },
    value => { value.objects[0].headers.push(value.objects[0].headers[0]); }
  ]) {
    const changed = structuredClone(report); edit(changed);
    assert.throws(() => verifyLibgcovBuild(changed, expected));
  }
});

// The integration gate uses retained actual GCC/WABT/WASI/gcov evidence. It
// deliberately does not invent a synthetic complete qualification report.
const reviewDirectory = process.env.GCC_WASI_COVERAGE_REVIEW_DIR;
test('actual coverage evidence rejects raw-pair, path, tool and merge-chain substitutions', { skip: !reviewDirectory }, async t => {
  const read = async name => JSON.parse(await fs.readFile(path.join(reviewDirectory, name)));
  const expected = await read('expected.json');
  await t.test('unaltered evidence survives isolated official gcov reanalysis', async () => {
    const result = await reopenCoverageQualification(await read('baseline-report.json'), expected);
    assert.equal(result.units, 36); assert.equal(result.cases, 28); assert.equal(result.profileExecutions, 20);
  });
  for (const [name, diagnostic] of [
    ['changed-compiler-hash', /Stale coverage tools/],
    ['injected-compile-include', /Changed coverage command arguments/],
    ['injected-link-library', /Changed coverage command arguments/],
    ['wrong-preexisting-merge-chain', /Merge run did not consume/],
    ['unbound-gcc-include-root', /Changed coverage gcc header root/],
    ['unbound-existing-c-sysroot', /Changed coverage sysroot/],
    ['unbound-link-search-root', /Changed coverage libc archive path/],
    ['raw-profile-replaced-json-unchanged', /Pinned gcov rejected the actual notes\/profile pair/],
    ['changed-json-source-and-summary', /gcov source identity differs/],
    ['changed-json-count-and-summary', /Exact execution count: classify/],
  ]) await t.test(name, async () => {
    await assert.rejects(reopenCoverageQualification(await read(name + '-report.json'), expected), diagnostic);
  });
});
