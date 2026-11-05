#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDebuggerGuest } from './debugger-cdp.mjs';
import { debuggerControlSymbol } from './test-debugger-native.mjs';
import { verifyDebuggerNativeReport } from './debugger-qualification.mjs';

// The guest never writes the registration cell. Only the real CDP observer does.
export const debuggerWorkerSource = `#include <debugging>
#include <cstdio>
static_assert(__cpp_lib_debugging == 202403L);
int main(int argc, char **argv) {
  std::printf("present=%d\\n", std::is_debugger_present());
  std::fflush(stdout);
  if (argc > 1 && argv[1][0] == 'u') std::breakpoint();
  else std::breakpoint_if_debugging();
  std::puts("returned");
}
`;

// Used directly by the SDK's existing actual compiler-Worker qualification harness.
export const cases = [{ id: 'cpp26-debugger-conditional',
  request: { language: 'cpp', standard: 'gnu++26', optimization: '0', code: debuggerWorkerSource },
  stdin: '', stdout: 'present=0\nreturned\n' },
  { id: 'c-default-stdin-regression', request: { language: 'c', code:
    '#include <stdio.h>\nint main(void) { int value; if (scanf("%d", &value) != 1) return 2; printf("%d\\n", value + 1); }\n' },
    stdin: '41\n', stdout: '42\n' },
  { id: 'cpp-default-gnu-regression', request: { language: 'cpp', code:
    '#include <iostream>\n#include <vector>\nint main() { int value; if (!(std::cin >> value)) return 2; std::vector<int> values={value,1}; std::cout << values[0]+values[1] << "\\n"; }\n' },
    stdin: '41\n', stdout: '42\n' }];

export const debuggerHostCases = [
  { id: 'disconnected-conditional', registration: 'detached', present: 0, trap: false, args: [] },
  { id: 'debugger-enabled-unregistered', registration: 'attached', present: 0, trap: false, args: [] },
  { id: 'registered-conditional', registration: 'registered', present: 1, trap: true, args: [] },
  { id: 'clear-before-detach', registration: 'clear-before-detach', present: 0, trap: false, args: [] },
  { id: 'disconnected-unconditional', registration: 'detached', present: 0, trap: true, args: ['unconditional'] },
  { id: 'registered-unconditional', registration: 'registered', present: 1, trap: true, args: ['unconditional'] },
  { id: 'fresh-instance-clean', registration: 'detached', present: 0, trap: false, args: [] }
];
const identity = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const content = receipt => ({ bytes: receipt.bytes, sha256: receipt.sha256 });

export async function qualifyDebuggerWorker({ runtime, nativeQualification, sdkQualification, output, chromium, shim, temporaryRoot }) {
  runtime = await fs.realpath(runtime); output = path.resolve(output);
  await fs.mkdir(output, { recursive: false, mode: 0o700 });
  const inputs = new Map(), artifacts = new Map();
  const report = { kind: 'gcc-wasi-debugger-worker-qualification', status: 'running',
    startedAt: new Date().toISOString(), target: 'wasm32-wasi', source: debuggerWorkerSource,
    cases: [], profile: 'gnu-debugger-registration-v1', automaticDetection: false,
    breakpointResumable: false,
    nativeExecution: 'Previously qualified native-GCC program; invoke its exported C++ debugger probes without entering main.',
    wasmHostExecution: 'Actual SDK compiler-Worker output; run the C++ main through WASI.' };
  let guest;
  const identify = async file => ({ path: path.resolve(file), ...identity(await fs.readFile(file)) });
  async function freeze(file, expected) {
    const actual = await identify(file);
    if (expected) assert.deepEqual(content(actual), content(expected), 'Changed debugger test input: ' + file);
    if (inputs.has(actual.path)) assert.deepEqual(actual, inputs.get(actual.path));
    inputs.set(actual.path, actual); return actual;
  }
  async function freezeTree(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      assert(item.isFile() || item.isDirectory(), 'Unexpected shim link or special file');
      if (item.isDirectory()) await freezeTree(file);
      else await freeze(file);
    }
  }
  async function write(name, bytes) {
    const file = path.join(output, name);
    await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    const actual = await identify(file); artifacts.set(file, actual); return actual;
  }
  try {
    report.recipe = await freeze(fileURLToPath(import.meta.url));
    report.cdpRecipe = await freeze(fileURLToPath(new URL('./debugger-cdp.mjs', import.meta.url)));
    report.chromium = await freeze(await fs.realpath(chromium));
    report.node = await freeze(process.execPath);
    report.shim = await fs.realpath(shim);
    await freezeTree(report.shim);
    report.build = await freeze(path.join(runtime, 'build.json'));
    const build = JSON.parse(await fs.readFile(report.build.path));
    assert.equal(build.status, 'built-unverified'); assert.equal(build.inputsUnchanged, true);
    // Admission already rebuilt and executed this native evidence before packaging.
    // Browser qualification consumes the retained program rather than requiring its build tree.
    for (const input of Object.values(build.libraries)) await freeze(input.path, input);
    const sdkReceipt = await freeze(await fs.realpath(sdkQualification));
    const sdk = JSON.parse(await fs.readFile(sdkReceipt.path));
    assert.equal(sdk.success, true); assert.deepEqual(sdk.selectedCases, cases.map(fixture => fixture.id));
    for (const [index, fixture] of cases.entries()) {
      assert.equal(sdk.fixtures[index].sha256, createHash('sha256').update(JSON.stringify(fixture)).digest('hex'));
      assert.equal(sdk.cases[index].status, 'passed');
    }
    assert.equal(sdk.cases[0].status, 'passed');
    assert.equal(sdk.cases[0].compilation.exitCode, 0);
    assert(sdk.cases[0].compilation.stages.some(stage => stage.tool === 'cc1plus' && stage.argv.includes('-std=gnu++26')));
    assert(sdk.cases[0].compilation.stages.some(stage => stage.tool === 'ld' && stage.argv.includes('--export-if-defined=' + debuggerControlSymbol)));
    report.sdkManifest = await freeze(path.join(path.dirname(sdkReceipt.path), 'manifest.json'));
    assert.equal(sdk.manifestSha256, report.sdkManifest.sha256);
    const manifest = JSON.parse(await fs.readFile(report.sdkManifest.path));
    const nativeReceipt = await freeze(await fs.realpath(nativeQualification));
    const native = JSON.parse(await fs.readFile(nativeReceipt.path));
    verifyDebuggerNativeReport(native);
    assert.deepEqual(content(nativeReceipt), content(manifest.provenance.files['debugger-native-qualification.json']), 'Native evidence differs from the admitted bundle');
    assert.deepEqual(content(report.build), content(manifest.provenance.files['debugger-build.json']), 'Runtime differs from the admitted bundle');
    assert.deepEqual(content(report.build), content(native.buildReceipt));
    report.nativeQualification = nativeReceipt;
    for (const file of native.artifacts) await freeze(file.path, file);
    report.sdkCompilation = sdkReceipt;
    const workerProgram = path.join(path.dirname(sdkReceipt.path), cases[0].id + '.wasm');
    const workerReceipt = await freeze(workerProgram, sdk.cases[0].artifact);
    const nativeCase = native.cases.find(entry => entry.id === 'disconnected-stdin');
    assert(nativeCase);
    const nativeProgram = await freeze(nativeCase.program.path, nativeCase.program);
    report.programs = { native: nativeProgram, wasmHostCompiler: workerReceipt };
    guest = await openDebuggerGuest({ executablePath: chromium, shim, temporaryRoot, timeoutMs: 60000 });
    report.browserVersion = guest.browserVersion;
    await write('actual-execution-worker.mjs', guest.workerSource);
    for (const [compiler, program] of Object.entries(report.programs)) {
      const bytes = await fs.readFile(program.path);
      assert.deepEqual(identity(bytes), content(program));
      const module = await WebAssembly.compile(bytes), imports = WebAssembly.Module.imports(module), exports = WebAssembly.Module.exports(module);
      assert(imports.every(entry => entry.module === 'wasi_snapshot_preview1' && entry.kind === 'function'));
      assert(exports.some(entry => entry.name === debuggerControlSymbol && entry.kind === 'global'));
      for (const fixture of debuggerHostCases) {
        const entryFunction = compiler === 'native' ? fixture.args.length ? 'debugger_probe_breakpoint' : 'debugger_probe_conditional' : undefined;
        const result = await guest.run({ bytes, entryFunction, registration: fixture.registration, args: fixture.args,
          sourceURL: compiler + '-' + fixture.id + '.wasm' });
        assert.deepEqual(result.artifact, content(program));
        assert.equal(result.stderr, '');
        assert.equal(result.stdout, compiler === 'native' ? '' : `present=${fixture.present}\n` + (fixture.trap ? '' : 'returned\n'));
        const completed = result.controls.find(control => control.stage === 'execution-complete');
        assert(completed);
        if (compiler === 'native') assert.equal(completed.present, fixture.present, 'Native C++ presence probe disagrees with observer state');
        if (fixture.trap) {
          assert.equal(result.error?.isWasmTrap, true);
          assert.match(result.error.message, /unreachable/);
        } else { assert.equal(result.error, null); assert.equal(result.exitCode, 0); }
        if (fixture.registration === 'registered') {
          assert.equal(result.debuggerEnabled, true);
          assert(result.controls.some(value => value.value === -1 && value.bytes.every(byte => byte === 255)));
          assert(result.pauses.some(pause => pause.wasmFrames.length > 0), 'No genuine paused Wasm frame');
        }
        if (fixture.registration === 'clear-before-detach') {
          assert.equal(result.detachedBeforeExecution, true);
          assert(result.controls.some(value => value.value === -1));
          assert.equal(result.controls.at(-1).value, 0);
        }
        if (fixture.registration === 'detached') assert.equal(result.debuggerEnabled, false);
        report.cases.push({ compiler, id: fixture.id, status: 'passed', expectedPresence: fixture.present,
          expectedTrap: fixture.trap, artifact: program, observation: result });
        await fs.writeFile(path.join(output, 'progress.json'), JSON.stringify({ completed: report.cases.length,
          compiler, lastCase: fixture.id }) + '\n', { mode: 0o600 });
      }
    }
    await guest.close(); guest = undefined;
    for (const value of inputs.values()) assert.deepEqual(await identify(value.path), value, 'Debugger test input changed');
    for (const value of artifacts.values()) assert.deepEqual(await identify(value.path), value, 'Debugger test artifact changed');
    report.counts = { programs: 2, hostCases: report.cases.length,
      normalExecutions: report.cases.filter(value => !value.expectedTrap).length,
      trappedExecutions: report.cases.filter(value => value.expectedTrap).length,
      debuggerObservedTraps: report.cases.filter(value => value.expectedTrap && value.observation.debuggerEnabled).length,
      pausedWasmFrames: report.cases.reduce((count, value) => count + value.observation.pauses.reduce((sum, pause) => sum + pause.wasmFrames.length, 0), 0) };
    assert.equal(report.counts.hostCases, 14); assert.equal(report.counts.debuggerObservedTraps, 4);
    report.inputs = [...inputs.values()]; report.artifacts = [...artifacts.values()];
    report.inputsUnchanged = true; report.artifactsUnchanged = true; report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = String(error.stack || error); throw error; }
  finally {
    await guest?.close(); report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(output, 'qualification.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index].replace(/^--/, '');
    assert(['runtime', 'native-qualification', 'sdk-qualification', 'output', 'chromium', 'shim', 'temporary-root'].includes(key) && process.argv[index + 1] && !options[key]);
    options[key] = path.resolve(process.argv[index + 1]);
  }
  for (const key of ['runtime', 'native-qualification', 'sdk-qualification', 'output', 'chromium', 'shim', 'temporary-root']) assert(options[key], 'Missing --' + key);
  const result = await qualifyDebuggerWorker({ ...options, nativeQualification: options['native-qualification'], sdkQualification: options['sdk-qualification'], temporaryRoot: options['temporary-root'] });
  console.log(JSON.stringify({ status: result.status, counts: result.counts }));
}
