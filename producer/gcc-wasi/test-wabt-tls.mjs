#!/usr/bin/env node
// Qualify native and Wasm-host assembler output, round trips and the real LLD ABI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { identity } from '../clang-browser/cross/package.mjs';
import { inspectTargetFeatures } from './inspect-target-features.mjs';
import { inspectTlsObject } from './tls-inspect.mjs';
import { watTlsCases } from './wabt-tls-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i].replace(/^--/, '');
  assert(['work', 'baseline-work', 'sdk', 'output'].includes(name) && process.argv[i + 1] && !options[name]);
  options[name] = path.resolve(process.argv[i + 1]);
}
for (const name of ['work', 'baseline-work', 'sdk', 'output']) assert(options[name], `Required --${name}`);
const { work, output } = options;
await fs.mkdir(output);
const inputs = new Map();
async function input(file) { const bytes = await fs.readFile(file); inputs.set(file, identity(bytes)); return bytes; }
const tools = Object.fromEntries(['wat2wasm', 'wasm2wat', 'wasm-objdump', 'wasm-validate'].map(name => [name, path.join(work, 'wabt-native', name)]));
tools.ld = path.join(options.sdk, 'bin/wasm-ld');
const baseline = path.join(options['baseline-work'], 'wabt-native/wat2wasm');
const lock = JSON.parse(await input(path.join(here, 'sources.lock.json')));
const expectedSource = { wabtCommit: lock.wabt.commit, patches: lock.wabt.patches,
  sourceDiffSha256: lock.wabt.sourceDiffSha256, submodules: lock.wabt.submodules };
for (const host of ['native', 'browser']) {
  const receipt = JSON.parse(await input(path.join(work, `wabt-${host}/provenance.json`)));
  assert(receipt.inputsUnchanged); assert.deepEqual(receipt.source, expectedSource);
  for (const [name, expected] of Object.entries(receipt.files))
    assert.deepEqual(identity(await input(path.join(work, `wabt-${host}`, name))), expected);
}
for (const file of [tools.ld, baseline, fileURLToPath(import.meta.url), ...['tls-inspect.mjs', 'symbol-alias-inspect.mjs',
  'wabt-tls-fixtures.mjs', 'inspect-target-features.mjs'].map(name => path.join(here, name))]) await input(file);
const createModule = (await import(pathToFileURL(path.join(work, 'wabt-browser/as.mjs')).href)).default;
const wasmBinary = await input(path.join(work, 'wabt-browser/as.wasm'));
const report = { kind: 'gcc-wasi-wabt-tls-qualification', status: 'running', startedAt: new Date().toISOString(),
  assemblerSource: expectedSource, cases: [], programs: [] };
const command = (entry, tool, argv, rejected = false) => {
  const result = spawnSync(tool, argv, { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  const evidence = { tool, argv, status: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '' };
  entry.commands.push(evidence); assert.ifError(result.error); assert.equal(result.signal, null);
  assert.equal(result.status, rejected ? 1 : 0, `${entry.id}: ${evidence.stderr}`); return evidence;
};
const semantics = inspection => ({
  segments: inspection.segments,
  symbols: inspection.symbols.map(({ symbolIndex, ...symbol }) => ({ ...symbol, flags: symbol.flags & ~64 }))
    .sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`)),
  relocations: inspection.relocations.map(({ index, ...relocation }) => ({ ...relocation, section: relocation.section.toLowerCase() })),
});
try {
  for (const fixture of watTlsCases) {
    const entry = { id: fixture.id, status: 'running', commands: [], fixture: identity(Buffer.from(fixture.wat)) };
    report.cases.push(entry);
    const directory = path.join(output, fixture.id); await fs.mkdir(directory);
    const wat = path.join(directory, 'input.wat'), object = path.join(directory, 'native.o');
    await fs.writeFile(wat, fixture.wat);
    const result = command(entry, tools.wat2wasm, ['-r', '--enable-annotations', wat, '-o', object], !!fixture.reject);
    const diagnostics = [];
    const assembler = await createModule({ wasmBinary, noInitialRun: true,
      print: message => diagnostics.push(String(message)), printErr: message => diagnostics.push(String(message)) });
    assembler.FS.writeFile('/input.wat', fixture.wat);
    let status;
    try { status = assembler.callMain(['-r', '--enable-annotations', '/input.wat', '-o', '/output.o']) ?? 0; }
    catch (error) { if (typeof error?.status !== 'number') throw error; status = error.status; }
    entry.wasmHost = { engine: process.version, status, diagnostics };
    assert.equal(status, fixture.reject ? 1 : 0, fixture.id);
    if (fixture.reject) { assert.match(result.stderr, fixture.reject); assert.match(diagnostics.join('\n'), fixture.reject); }
    else {
      const bytes = await fs.readFile(object), wasmHostBytes = Buffer.from(assembler.FS.readFile('/output.o'));
      assert.deepEqual(wasmHostBytes, bytes, 'Native/Wasm-host output differs');
      await fs.writeFile(path.join(directory, 'wasm-host.o'), wasmHostBytes);
      const inspection = inspectTlsObject(bytes);
      assert.deepEqual(inspection.tlsSymbols.map(symbol => symbol.name), fixture.symbols);
      assert.deepEqual(inspection.segments.map(segment => segment.flags), fixture.segmentFlags);
      assert.deepEqual(inspection.tlsRelocations.map(relocation => relocation.addend), fixture.relocations);
      assert.equal(inspection.hasTls, !fixture.baselineIdentical);
      assert.equal(inspectTargetFeatures(bytes).features.tls, undefined, 'TLS is not a target_features extension');
      assert.deepEqual(inspectTargetFeatures(bytes).features,
        inspection.hasTls ? { atomics: '+', 'bulk-memory': '+' } : {});
      entry.object = { path: object, ...identity(bytes), ...inspection };
      command(entry, tools['wasm-validate'], [object]);
      const roundtripWat = path.join(directory, 'roundtrip.wat'), roundtripObject = path.join(directory, 'roundtrip.o');
      command(entry, tools.wasm2wat, ['-r', '--enable-annotations', object, '-o', roundtripWat]);
      command(entry, tools.wat2wasm, ['-r', '--enable-annotations', roundtripWat, '-o', roundtripObject]);
      const roundtrip = await fs.readFile(roundtripObject);
      assert.deepEqual(semantics(inspectTlsObject(roundtrip)), semantics(inspection), 'TLS round-trip metadata changed');
      entry.roundtrip = { path: roundtripObject, ...identity(roundtrip) };
      if (fixture.baselineIdentical) {
        const previous = path.join(directory, 'baseline.o');
        command(entry, baseline, ['-r', '--enable-annotations', wat, '-o', previous]);
        assert.deepEqual(await fs.readFile(previous), bytes, 'Ordinary object bytes changed');
        entry.baselineIdentical = true;
      }
    }
    entry.status = 'passed';
  }
  const exported = ['read_value', 'write_value', 'read_external', 'read_zero', 'address_zero'];
  for (const host of ['native', 'wasm-host', 'roundtrip']) for (const shared of [false, true]) {
    const entry = { id: `${host}-${shared ? 'shared' : 'private'}`, status: 'running', commands: [] };
    report.programs.push(entry);
    const program = path.join(output, `${entry.id}.wasm`);
    command(entry, tools.ld, ['--no-entry', '--initial-memory=131072', '--max-memory=131072',
      ...exported.map(name => `--export=${name}`),
      ...(shared ? ['--shared-memory', '--import-memory', '--extra-features=mutable-globals', '--export=__tls_size', '--export=__tls_align', '--export=__tls_base', '--export=__wasm_init_tls'] : []),
      ...['initialized', 'external-addend', 'aligned-zero'].map(id => path.join(output, id, `${host}.o`)), '-o', program]);
    const bytes = await fs.readFile(program), module = new WebAssembly.Module(bytes);
    entry.program = { path: program, ...identity(bytes) };
    if (shared) {
      const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
      assert.deepEqual(WebAssembly.Module.imports(module), [{ module: 'env', name: 'memory', kind: 'memory' }]);
      const a = new WebAssembly.Instance(module, { env: { memory } }).exports;
      const b = new WebAssembly.Instance(module, { env: { memory } }).exports;
      assert.equal(a.__tls_align.value, 32); assert(a.__tls_size.value >= 20 && a.__tls_size.value <= 256);
      a.__wasm_init_tls(65536); b.__wasm_init_tls(65792);
      for (const instance of [a, b]) { assert.equal(instance.read_value(), 13); assert.equal(instance.read_external(), 29); assert.equal(instance.read_zero(), 0); assert.equal(instance.address_zero() % 32, 0); }
      a.write_value(91); assert.equal(a.read_value(), 91); assert.equal(b.read_value(), 13);
      b.write_value(73); assert.equal(a.read_value(), 91); assert.equal(b.read_value(), 73);
      entry.execution = { initialValues: [13, 29, 0], finalValues: [91, 73], bases: [a.__tls_base.value, b.__tls_base.value],
        zeroAddresses: [a.address_zero(), b.address_zero()], tlsSize: a.__tls_size.value, tlsAlign: a.__tls_align.value };
    } else {
      assert.deepEqual(WebAssembly.Module.imports(module), []);
      const instance = new WebAssembly.Instance(module).exports;
      assert.equal(instance.read_value(), 13); assert.equal(instance.read_external(), 29); assert.equal(instance.read_zero(), 0);
      instance.write_value(91); assert.equal(instance.read_value(), 91);
      entry.execution = { initialValues: [13, 29, 0], finalValue: 91 };
    }
    entry.status = 'passed';
  }
  for (const host of ['native', 'wasm-host', 'roundtrip']) {
    for (const [id, sources, expected] of [
      ['first', ['weak-function-alias-31', 'weak-function-alias-47'], 31],
      ['reversed', ['weak-function-alias-47', 'weak-function-alias-31'], 47],
      ['overridden', ['weak-function-alias-31', 'strong-function-override', 'weak-function-alias-47'], 88],
    ]) {
      const entry = { id: `${host}-weak-alias-${id}`, status: 'running', commands: [] };
      report.programs.push(entry);
      const program = path.join(output, `${entry.id}.wasm`);
      command(entry, tools.ld, ['--no-entry', '--export=tls_init_alias', '--export=call_alias_31', '--export=call_alias_47',
        ...sources.map(source => path.join(output, source, `${host}.o`)), '-o', program]);
      const bytes = await fs.readFile(program), instance = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports;
      const values = [instance.tls_init_alias(), instance.call_alias_31(), instance.call_alias_47()];
      assert.deepEqual(values, [expected, expected, expected], 'Weak alias references must follow linker selection');
      entry.program = { path: program, ...identity(bytes) }; entry.execution = { values }; entry.status = 'passed';
    }
    const entry = { id: `${host}-tls-data-alias`, status: 'running', commands: [] };
    report.programs.push(entry);
    const program = path.join(output, `${entry.id}.wasm`);
    command(entry, tools.ld, ['--no-entry', '--export=read_alias', path.join(output, 'tls-data-alias', `${host}.o`), '-o', program]);
    const bytes = await fs.readFile(program), value = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.read_alias();
    assert.equal(value, 13); entry.program = { path: program, ...identity(bytes) }; entry.execution = { value }; entry.status = 'passed';
  }
  for (const [file, expected] of inputs) assert.deepEqual(identity(await fs.readFile(file)), expected, `Input changed: ${file}`);
  report.inputsUnchanged = true; report.status = 'passed';
  // Expected rejected callMain invocations set Node's process exit status.
  // The harness succeeds only after checking every actual exit code above.
  process.exitCode = 0;
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
report.inputs = Object.fromEntries(inputs); report.finishedAt = new Date().toISOString();
await fs.writeFile(path.join(output, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, cases: report.cases.length, programs: report.programs.length, error: report.error, output }));
