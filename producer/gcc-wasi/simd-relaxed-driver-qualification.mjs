import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identity, readNativeTree } from '../clang-browser/cross/package.mjs';
import { inspectTargetFeatures } from './inspect-target-features.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const profiles = [
  ['enabled', ['-msimd128', '-mrelaxed-simd'], true, true],
  ['disable-then-enable', ['-msimd128', '-mno-relaxed-simd', '-mrelaxed-simd'], true, true],
  ['enable-then-disable', ['-msimd128', '-mrelaxed-simd', '-mno-relaxed-simd'], false, true],
  ['simd-only', ['-msimd128'], false, true], ['default', [], false, true],
  ['missing-simd', ['-mrelaxed-simd'], true, false],
  ['disable-simd-last', ['-msimd128', '-mrelaxed-simd', '-mno-simd128'], true, false]
];
const enabledSource = '#include <wasm_relaxed_simd.h>\n#ifndef __wasm_relaxed_simd__\n#error missing relaxed macro\n#endif\nv128_t probe(v128_t a, v128_t b) { return wasm_i8x16_relaxed_swizzle(a, b); }\n';
const disabledSource = '#ifdef __wasm_relaxed_simd__\n#error unexpected relaxed macro\n#endif\nint probe(int value) { return value + 1; }\n';
const indexed = files => Object.fromEntries(files.map(file => [file.path, identity(file.bytes)]));
const inventory = async directory => indexed(await readNativeTree(directory));

export function verifyRelaxedSimdDriverQualificationOptions(patches, options) {
  if (!patches.some(patch => patch.path === 'patches/0022-relaxed-simd.patch')) return;
  for (const name of ['simdRelaxedQualification', 'simdRelaxedDriverQualification'])
    assert(options[name], 'Relaxed SIMD driver requires ' + name);
}

function contract(expected, root) {
  const compiler = path.join(expected.work, 'gcc-native/gcc'), specs = path.join(expected.work, 'native-driver.specs');
  return ['c', 'c++'].flatMap(language => ['0', '2'].flatMap(optimization => profiles.map(([profile, flags, relaxed, success]) => {
    const id = `${profile}-${language.replaceAll('+', 'p')}-o${optimization}`;
    const source = path.join(root, id + (language === 'c++' ? '.cc' : '.c')), object = path.join(root, id + '.o');
    return { id, relaxed, success, source, object, code: relaxed ? enabledSource : disabledSource,
      command: [path.join(compiler, 'xgcc'), '-B' + root + '/', '-B' + compiler + '/', '-specs=' + specs,
        '-O' + optimization, '-x', language, '-v', '-nostdinc', '-isystem', path.join(compiler, 'include'),
        '-isystem', path.join(expected.sysroot, 'include/wasm32-wasi'), ...flags, '-c', source, '-o', object] };
  })));
}

function expectedInputs(expected) {
  const compiler = path.join(expected.work, 'gcc-native/gcc');
  return {
    [path.join(here, 'test-simd-relaxed-driver.py')]: expected.recipes.driver,
    [path.join(expected.work, 'native-build.json')]: expected.nativeBuild,
    [path.join(expected.work, 'native-driver.specs')]: expected.specs.overlay,
    [path.join(expected.work, 'wabt-native/wat2wasm')]: expected.tools.assembler,
    ...Object.fromEntries(['xgcc', 'cc1', 'cc1plus'].map(name => [path.join(compiler, name), expected.tools[name]])),
    ...Object.fromEntries(['wasm_simd128.h', 'wasm_relaxed_simd.h'].map(name => [path.join(compiler, 'include', name), expected.headers.gcc[name]]))
  };
}

export function verifyRelaxedSimdDriverQualification(report, reportFile, expected) {
  assert.equal(report.kind, 'gcc-wasi-relaxed-simd-driver-qualification');
  assert.equal(report.status, 'passed'); assert.equal(report.inputsUnchanged, true);
  assert.equal(report.error, undefined);
  assert.deepEqual(report.counts, { cases: 28, objectEmissions: 20, rejections: 8 });
  assert.deepEqual(report.inputs, expectedInputs(expected), 'Driver receipt has stale or incomplete inputs');
  const root = path.dirname(path.resolve(reportFile)), cases = contract(expected, root);
  assert.deepEqual(report.cases.map(entry => entry.id), cases.map(entry => entry.id), 'Incomplete driver option matrix');
  for (const [index, fixture] of cases.entries()) {
    const entry = report.cases[index];
    assert.equal(entry.status, 'passed'); assert.equal(entry.error, undefined); assert.deepEqual(entry.command, fixture.command);
    assert.equal(entry.exitCode, fixture.success ? 0 : 1); assert.equal(entry.stdout, '');
    assert.deepEqual(entry.source, identity(Buffer.from(fixture.code)), 'Driver source differs from the option probe');
    if (fixture.success) {
      assert(entry.object && entry.object.bytes > 8 && /^[a-f0-9]{64}$/.test(entry.object.sha256));
      assert.deepEqual(entry.targetFeatures, fixture.relaxed ? { 'relaxed-simd': '+', simd128: '+' } : {});
      const temporary = entry.assemblerArgv?.at(-1);
      assert.equal(path.dirname(temporary), path.join(root, 'tmp'));
      assert.match(path.basename(temporary), /^cc[A-Za-z0-9]+\.s$/u);
      assert.deepEqual(entry.assemblerArgv, [path.join(root, 'as'), '-r', '--enable-annotations',
        ...(fixture.relaxed ? ['--enable-relaxed-simd'] : []), '-v', '-o', fixture.object, temporary]);
    } else {
      assert.equal(entry.object, undefined); assert.equal(entry.assemblerArgv, undefined); assert.equal(entry.targetFeatures, undefined);
      assert.match(entry.stderr, /requires[^\n]*-msimd128/u);
    }
  }
}

export async function reopenRelaxedSimdDriverQualification(report, reportFile, expected) {
  verifyRelaxedSimdDriverQualification(report, reportFile, expected);
  const originalBytes = await fs.readFile(reportFile); assert.deepEqual(JSON.parse(originalBytes), report);
  const compiler = path.join(expected.work, 'gcc-native/gcc');
  const roots = { gcc: path.join(compiler, 'include'), fixed: path.join(compiler, 'include-fixed'), target: path.join(expected.sysroot, 'include') };
  const bindings = { ...expectedInputs(expected), [path.resolve(reportFile)]: identity(originalBytes),
    [path.join(here, 'sources.lock.json')]: expected.sourceLock,
    [path.join(here, 'build-native.sh')]: expected.recipes.native,
    [path.join(here, 'simd-relaxed-driver-qualification.mjs')]: expected.recipes.gate,
    [path.join(here, 'inspect-target-features.mjs')]: expected.recipes.features,
    [path.join(compiler, 'specs')]: expected.specs.default,
    [path.join(expected.work, 'wabt-native/wasm-objdump')]: expected.tools.objdump
  };
  const captured = async (file, receipt) => {
    const bytes = await fs.readFile(file); assert.deepEqual(identity(bytes), receipt, 'Changed driver qualification input/artifact: ' + file); return bytes;
  };
  const unchanged = async () => {
    for (const [file, receipt] of Object.entries(bindings)) await captured(file, receipt);
    for (const [name, directory] of Object.entries(roots)) assert.deepEqual(await inventory(directory), expected.headers[name], 'Changed driver ' + name + ' headers');
    assert.deepEqual(await inventory(path.join(expected.work, 'gcc/gcc/config/wasm')), expected.targetSource, 'Changed driver target source');
  };
  await unchanged();
  const native = JSON.parse(await captured(path.join(expected.work, 'native-build.json'), expected.nativeBuild));
  const lock = JSON.parse(await captured(path.join(here, 'sources.lock.json'), expected.sourceLock));
  assert.equal(native.host, 'native'); assert.equal(native.target, 'wasm32-wasi');
  assert.equal(native.sourceLockSha256, expected.sourceLock.sha256); assert.equal(native.recipeSha256, expected.recipes.native.sha256);
  assert.equal(native.driverSpecsSha256, expected.specs.overlay.sha256);
  assert.deepEqual(native.gccSource, expected.gccSource); assert.equal(native.gccCommit, lock.gcc.commit);
  assert.deepEqual(expected.gccSource.patches, lock.gcc.patches);
  assert.equal(expected.gccSource.sourceDiffSha256, lock.gcc.sourceDiffSha256);
  for (const name of ['xgcc', 'cc1', 'cc1plus']) assert.equal(native.tools[name].sha256, expected.tools[name].sha256);
  const run = (command, argv) => {
    const result = spawnSync(command, argv, { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr || result.stdout); return result;
  };
  const inspect = async (receipt, file) => {
    const root = path.dirname(path.resolve(file)), fixtures = contract(expected, root);
    assert.equal(await fs.realpath(path.join(root, 'as')), await fs.realpath(path.join(expected.work, 'wabt-native/wat2wasm')));
    for (const [index, fixture] of fixtures.entries()) {
      const entry = receipt.cases[index]; await captured(fixture.source, entry.source);
      if (fixture.success) {
        const object = await captured(fixture.object, entry.object), module = new WebAssembly.Module(object);
        assert.equal(WebAssembly.Module.customSections(module, 'linking').length, 1);
        assert.deepEqual(inspectTargetFeatures(object).features, entry.targetFeatures);
        const dump = run(path.join(expected.work, 'wabt-native/wasm-objdump'), ['-d', fixture.object]);
        const relaxed = [...dump.stdout.matchAll(/\|\s+((?:i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\.relaxed_[a-z0-9_]+)/gu)].map(match => match[1]);
        assert.deepEqual(relaxed, fixture.relaxed ? ['i8x16.relaxed_swizzle'] : [], fixture.id + ': wrong actual driver opcode');
      } else await assert.rejects(fs.stat(fixture.object), { code: 'ENOENT' });
    }
  };
  await inspect(report, reportFile);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gcc-relaxed-driver-reopen-'));
  try {
    const output = path.join(temporary, 'qualification');
    const command = ['python3', path.join(here, 'test-simd-relaxed-driver.py'), '--work', expected.work, '--sysroot', expected.sysroot, '--output', output];
    run(command[0], command.slice(1));
    const replayFile = path.join(output, 'qualification.json'), replayBytes = await fs.readFile(replayFile), replay = JSON.parse(replayBytes);
    verifyRelaxedSimdDriverQualification(replay, replayFile, expected); await inspect(replay, replayFile);
    for (const [index, entry] of replay.cases.entries())
      assert.deepEqual(entry.object, report.cases[index].object, 'Replayed driver object changed: ' + entry.id);
    await unchanged();
    return { kind: 'gcc-wasi-relaxed-simd-driver-replay', status: 'passed', inputsUnchanged: true,
      original: identity(originalBytes), inputs: bindings, headers: expected.headers,
      gccSource: expected.gccSource, targetSource: expected.targetSource, command, replay: identity(replayBytes), counts: replay.counts };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
