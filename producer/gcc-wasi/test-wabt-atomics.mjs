#!/usr/bin/env node
// Qualify actual WABT instruction metadata, validation and scalar preservation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identity } from '../clang-browser/cross/package.mjs';
import { inspectTargetFeatures } from './inspect-target-features.mjs';
import { watAtomicsCases } from './wabt-atomics-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i].replace(/^--/, '');
  assert(['work', 'baseline-work', 'output'].includes(name) && process.argv[i + 1] && !options[name]);
  options[name] = path.resolve(process.argv[i + 1]);
}
for (const name of ['work', 'baseline-work', 'output']) assert(options[name], `Required --${name}`);
const { work, output } = options;
await fs.mkdir(output);
const inputs = new Map();
async function input(file) { const bytes = await fs.readFile(file); inputs.set(file, identity(bytes)); return bytes; }
const tools = Object.fromEntries(['wat2wasm', 'wasm2wat', 'wasm-objdump', 'wasm-validate'].map(name => [name, path.join(work, 'wabt-native', name)]));
const baseline = path.join(options['baseline-work'], 'wabt-native/wat2wasm');
const sourceLock = JSON.parse(await input(path.join(here, 'sources.lock.json')));
const receipt = JSON.parse(await input(path.join(work, 'wabt-native/provenance.json')));
assert(receipt.inputsUnchanged);
assert.deepEqual(receipt.source, { wabtCommit: sourceLock.wabt.commit, patches: sourceLock.wabt.patches,
  sourceDiffSha256: sourceLock.wabt.sourceDiffSha256, submodules: sourceLock.wabt.submodules });
for (const [name, file] of Object.entries(tools)) assert.deepEqual(identity(await input(file)), receipt.files[name]);
for (const file of [baseline, fileURLToPath(import.meta.url), path.join(here, 'wabt-atomics-fixtures.mjs'), path.join(here, 'inspect-target-features.mjs')]) await input(file);
const report = { kind: 'gcc-wasi-wabt-atomics-qualification', status: 'running', startedAt: new Date().toISOString(), assemblerSource: receipt.source, cases: [] };
const command = (entry, tool, argv, rejected = false) => {
  const result = spawnSync(tool, argv, { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  const evidence = { tool, argv, status: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '' };
  entry.commands.push(evidence); assert.ifError(result.error); assert.equal(result.signal, null);
  assert.equal(result.status, rejected ? 1 : 0, `${entry.id}: ${evidence.stderr}`); return evidence;
};
try {
  for (const fixture of watAtomicsCases) for (const relocatable of [false, true]) {
    const id = fixture.id + (relocatable ? '-object' : '-module');
    const entry = { id, status: 'running', commands: [], fixture: identity(Buffer.from(fixture.wat)) };
    report.cases.push(entry);
    const directory = path.join(output, id); await fs.mkdir(directory);
    const wat = path.join(directory, 'input.wat'), object = path.join(directory, 'output.wasm');
    await fs.writeFile(wat, fixture.wat);
    const flags = [...(relocatable ? ['-r'] : []), '--enable-annotations', ...fixture.flags];
    const result = command(entry, tools.wat2wasm, [...flags, wat, '-o', object], !!fixture.reject);
    if (fixture.reject) assert.match(result.stderr, fixture.reject);
    else {
      const bytes = await fs.readFile(object), metadata = inspectTargetFeatures(bytes);
      assert.deepEqual(metadata.features, fixture.features, id);
      assert.equal(metadata.sections.includes('linking'), relocatable);
      if (fixture.containsFe) assert(bytes.includes(0xfe));
      entry.object = { path: object, ...identity(bytes), ...metadata };
      command(entry, tools['wasm-validate'], ['--enable-threads', object]);
      if (fixture.baselineIdentical) {
        const previous = path.join(directory, 'source72.wasm');
        command(entry, baseline, [...flags, wat, '-o', previous]);
        assert.deepEqual(await fs.readFile(previous), bytes, `${id}: scalar bytes changed`);
        entry.baselineIdentical = true;
      }
      const disassembly = command(entry, tools['wasm-objdump'], ['-d', object]);
      await fs.writeFile(path.join(directory, 'disassembly.txt'), disassembly.stdout);
      if (!relocatable) {
        const instance = await WebAssembly.instantiate(bytes);
        assert.equal(instance.instance.exports.run(), 42);
        entry.execution = { engine: process.version, result: 42 };
      }
      if (fixture.features.atomics === '+') command(entry, tools['wasm-validate'], [object], true);
    }
    entry.status = 'passed';
  }
  for (const [file, expected] of inputs) assert.deepEqual(identity(await fs.readFile(file)), expected, `Input changed: ${file}`);
  report.inputsUnchanged = true; report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
report.inputs = Object.fromEntries(inputs); report.finishedAt = new Date().toISOString();
await fs.writeFile(path.join(output, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, cases: report.cases.length, error: report.error, output }));
