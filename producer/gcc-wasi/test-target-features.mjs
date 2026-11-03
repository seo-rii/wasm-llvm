#!/usr/bin/env node
// Real native GCC -> patched WABT -> LLD -> WASI qualification for issue #79.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identity, readNativeTree } from '../clang-browser/cross/package.mjs';
import { inspectTargetFeatures } from './inspect-target-features.mjs';
import { cases, watCases } from './target-features-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  assert(['compiler', 'compiler-receipt', 'runtime', 'work', 'sdk', 'output'].includes(key) && process.argv[i + 1] && !options[key], `Invalid argument: ${process.argv[i]}`);
  options[key] = path.resolve(process.argv[i + 1]);
}
for (const key of ['compiler', 'compiler-receipt', 'runtime', 'work', 'sdk', 'output']) assert(options[key], `Required --${key}`);
const { compiler, runtime, work, sdk, output } = options;
await fs.mkdir(output);
const inputs = new Map();
const readInput = async name => {
  const bytes = await fs.readFile(name); inputs.set(name, identity(bytes)); return bytes;
};
const identifyTree = async root => Object.fromEntries((await readNativeTree(root)).map(file => [file.path, identity(file.bytes)]));
const assembler = path.join(work, 'wabt-native/wat2wasm');
const validator = path.join(work, 'wabt-native/wasm-validate');
const objdump = path.join(work, 'wabt-native/wasm-objdump');
const linker = path.join(sdk, 'bin/wasm-ld');
const library = path.join(runtime, 'sysroot/lib/wasm32-wasi');
const builtins = path.join(sdk, 'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a');
const lock = JSON.parse(await readInput(path.join(here, 'sources.lock.json')));
const compilerReceipt = JSON.parse(await readInput(options['compiler-receipt']));
assert.equal(compilerReceipt.gccCommit, lock.gcc.commit);
assert.deepEqual(compilerReceipt.gccSource.patches, lock.gcc.patches);
assert.equal(identity(await readInput(path.join(compiler, 'cc1'))).sha256, compilerReceipt.tools.cc1.sha256);
const assemblerReceipt = JSON.parse(await readInput(path.join(work, 'wabt-native/provenance.json')));
assert.equal(assemblerReceipt.inputsUnchanged, true);
assert.deepEqual(assemblerReceipt.source, { wabtCommit: lock.wabt.commit, patches: lock.wabt.patches, sourceDiffSha256: lock.wabt.sourceDiffSha256, submodules: lock.wabt.submodules });
for (const name of [assembler, validator, objdump, linker, builtins, ...['crt1-command.o', 'libc.a', 'libm.a'].map(name => path.join(library, name)),
  fileURLToPath(import.meta.url), path.join(here, 'target-features-fixtures.mjs'), path.join(here, 'inspect-target-features.mjs')]) await readInput(name);
for (const name of ['wat2wasm', 'wasm-objdump', 'wasm-validate']) assert.deepEqual(inputs.get(path.join(work, 'wabt-native', name)), assemblerReceipt.files[name]);
const headerRoots = [path.join(compiler, 'include'), path.join(runtime, 'sysroot/include')];
const headers = Object.fromEntries(await Promise.all(headerRoots.map(async root => [root, await identifyTree(root)])));
const report = { kind: 'gcc-wasi-native-target-features-qualification', status: 'running', startedAt: new Date().toISOString(),
  compilerSource: compilerReceipt.gccSource, assemblerSource: assemblerReceipt.source, headers, watCases: [], cases: [], inputs: {} };
const command = (entry, executable, argv, expected = 0) => {
  const result = spawnSync(executable, argv, { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  const evidence = { command: executable, argv, status: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '' };
  entry.commands.push(evidence);
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, expected, `${entry.id}: ${evidence.stderr}`);
  return evidence;
};
const checkSimd = (entry, file, used) => command(entry, validator, ['--enable-relaxed-simd', '--disable-simd', file], used ? 1 : 0);
try {
  for (const fixture of watCases) for (const relocatable of [false, true]) {
    const id = `${fixture.id}-${relocatable ? 'object' : 'module'}`;
    const entry = { id, status: 'running', commands: [], fixture: identity(Buffer.from(fixture.wat)), features: fixture.features };
    report.watCases.push(entry);
    const directory = path.join(output, id); await fs.mkdir(directory);
    const wat = path.join(directory, 'input.wat'), object = path.join(directory, 'output.wasm');
    await fs.writeFile(wat, fixture.wat);
    const assembled = command(entry, assembler, [...(relocatable ? ['-r'] : []), '--enable-annotations', ...(fixture.flags || []), wat, '-o', object], fixture.reject ? 1 : 0);
    if (fixture.reject) assert.match(assembled.stderr, /target_features:/);
    else {
      const bytes = await fs.readFile(object), metadata = inspectTargetFeatures(bytes);
      entry.object = { path: object, ...identity(bytes), ...metadata };
      assert.deepEqual(metadata.features, fixture.features);
      assert.equal(metadata.sections.includes('linking'), relocatable);
      if (metadata.sections.includes('producers')) assert(metadata.sections.indexOf('target_features') > metadata.sections.indexOf('producers'));
      if (fixture.containsFd) assert(bytes.includes(0xfd), 'The false-positive fixture must actually contain 0xfd');
      checkSimd(entry, object, !!fixture.usesSimd);
      let program = object;
      if (relocatable && fixture.linkError) {
        const failed = command(entry, linker, ['--fatal-warnings', '--no-entry', '--no-gc-sections', '--allow-undefined', '--export=run', object, '-o', path.join(directory, 'linked.wasm')], 1);
        assert(failed.stderr.includes(fixture.linkError));
        entry.linkerLimitation = fixture.linkError;
      } else if (relocatable) {
        program = path.join(directory, 'linked.wasm');
        command(entry, linker, ['--fatal-warnings', '--no-entry', '--no-gc-sections', '--allow-undefined', '--export=run', object, '-o', program]);
        const linked = inspectTargetFeatures(await fs.readFile(program));
        assert.equal(linked.features.simd128 === '+', !!fixture.usesSimd);
        assert.equal(linked.features['relaxed-simd'] === '+', !!fixture.flags?.includes('--enable-relaxed-simd'));
        entry.linked = { ...identity(await fs.readFile(program)), ...linked };
        checkSimd(entry, program, !!fixture.usesSimd);
      }
      const compiled = await WebAssembly.compile(await fs.readFile(program));
      const instance = await WebAssembly.instantiate(compiled, { env: { vector() {} } });
      assert.equal(instance.exports.run(), fixture.result);
      entry.result = fixture.result;
    }
    entry.status = 'passed';
  }
  // LLD must reject SIMD when it is excluded from the allowed feature set.
  const restricted = { id: 'linker-restricted-simd', commands: [] };
  command(restricted, linker, ['--fatal-warnings', '--no-entry', '--features=mutable-globals', path.join(output, 'simd-instructions-object/output.wasm'), '-o', path.join(output, 'restricted.wasm')], 1);
  assert.match(restricted.commands[0].stderr, /simd128/);
  const prohibitedWat = path.join(output, 'prohibited.wat'), prohibitedObject = path.join(output, 'prohibited.o');
  await fs.writeFile(prohibitedWat, '(module (@custom "target_features" "\\01-\\07simd128"))');
  command(restricted, assembler, ['-r', '--enable-annotations', prohibitedWat, '-o', prohibitedObject]);
  const conflict = command(restricted, linker, ['--fatal-warnings', '--no-entry', path.join(output, 'simd-instructions-object/output.wasm'), prohibitedObject, '-o', path.join(output, 'conflict.wasm')], 1);
  assert.match(conflict.stderr, /simd128/);
  report.linkerRestrictions = restricted;
  const runner = path.join(output, 'run-wasi.mjs');
  await fs.writeFile(runner, `import { WASI } from 'node:wasi';\nimport { readFile } from 'node:fs/promises';\nconst wasi = new WASI({version:'preview1',args:['program'],env:{},returnOnExit:true});\nconst module = await WebAssembly.compile(await readFile(process.argv[2]));\nprocess.exitCode = wasi.start(await WebAssembly.instantiate(module,{wasi_snapshot_preview1:wasi.wasiImport}));\n`);
  for (const fixture of cases) {
    const entry = { id: fixture.id, status: 'running', commands: [], source: identity(Buffer.from(fixture.request.code)) };
    report.cases.push(entry);
    const directory = path.join(output, fixture.id); await fs.mkdir(directory);
    const source = path.join(directory, 'main.c'), wat = path.join(directory, 'main.wat'), object = path.join(directory, 'main.o'), program = path.join(directory, 'main.wasm');
    await fs.writeFile(source, fixture.request.code);
    command(entry, path.join(compiler, 'cc1'), ['-quiet', `-O${fixture.request.optimization}`, '-std=gnu11', '-fdiagnostics-color=never',
      '-Werror=attributes', '-Werror=pragmas', '-D__GCC_WASI_SINGLE_THREAD__=1', '-nostdinc', '-isystem', path.join(compiler, 'include'),
      '-isystem', path.join(runtime, 'sysroot/include/wasm32-wasi'), fixture.request.simd ? '-msimd128' : '-mno-simd128', source, '-o', wat]);
    command(entry, assembler, ['-r', '--enable-annotations', wat, '-o', object]);
    const objectBytes = await fs.readFile(object), metadata = inspectTargetFeatures(objectBytes);
    assert.deepEqual(metadata.features, fixture.usesSimd ? { simd128: '+' } : {});
    assert(metadata.sections.includes('linking'));
    entry.object = { path: object, ...identity(objectBytes), ...metadata };
    const disassembly = command(entry, objdump, ['-d', object]).stdout;
    await fs.writeFile(path.join(directory, 'object.disassembly.txt'), disassembly);
    assert.equal(/\b(?:v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\./u.test(disassembly), fixture.usesSimd);
    command(entry, linker, ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', program, path.join(library, 'crt1-command.o'), `-L${library}`, object, '-lm', '-lc', builtins]);
    const bytes = await fs.readFile(program), linked = inspectTargetFeatures(bytes);
    assert.equal(linked.features.simd128 === '+', fixture.usesSimd);
    checkSimd(entry, program, fixture.usesSimd);
    entry.program = { path: program, ...identity(bytes), ...linked };
    const result = command(entry, process.execPath, ['--disable-warning=ExperimentalWarning', runner, program]);
    assert.equal(result.stdout, fixture.stdout); assert.equal(result.stderr, '');
    entry.stdout = result.stdout; entry.status = 'passed';
  }
  for (const [name, expected] of inputs) assert.deepEqual(identity(await fs.readFile(name)), expected, `Input changed: ${name}`);
  for (const root of headerRoots) assert.deepEqual(await identifyTree(root), headers[root], `Headers changed: ${root}`);
  report.inputsUnchanged = true;
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
report.inputs = Object.fromEntries(inputs);
report.finishedAt = new Date().toISOString();
await fs.writeFile(path.join(output, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, watCases: report.watCases.length, gccCases: report.cases.length, error: report.error, output }));
