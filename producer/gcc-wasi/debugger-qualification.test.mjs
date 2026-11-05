import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reopenDebuggerQualification, verifyDebuggerNativeReport } from './debugger-qualification.mjs';
import { debuggerNativeCases, debuggerNativeCounts, debuggerControlSymbol } from './test-debugger-native.mjs';

// Synthetic admission controls only, never supplied as successful build/runtime evidence.
function fixture() {
  return { kind: 'gcc-wasi-debugger-native-qualification', status: 'passed', host: 'native', target: 'wasm32-wasi',
    standard: 'gnu++26', inputsUnchanged: true, counts: debuggerNativeCounts, expectedCounts: debuggerNativeCounts,
    scope: { testsActualDebuggerConnection: false },
    profile: { controlSymbol: debuggerControlSymbol, automaticDebuggerDetection: false, resumable: false, connectedValue: -1, disconnectedValue: 0 },
    cases: debuggerNativeCases.map(value => ({ id: value.id, status: 'passed', standard: 'gnu++26', stdin: value.stdin,
      expectedStdout: value.stdout, expectedExitCode: value.exitCode, expectedTrap: value.trap,
      source: { bytes: Buffer.byteLength(value.source), sha256: createHash('sha256').update(value.source).digest('hex') },
      observation: { exitCode: value.exitCode, stdout: value.stdout,
        trapped: value.trap, stderr: value.trap ? 'RuntimeError: unreachable' : '' } })) };
}

test('native report preserves its limited non-debugger scope and complete measured cases', () => {
  verifyDebuggerNativeReport(fixture());
});

test('incomplete, rewritten or fabricated source and trap observations are rejected', () => {
  for (const edit of [
    value => value.status = 'failed', value => value.inputsUnchanged = false,
    value => value.cases.pop(), value => value.cases.reverse(),
    value => value.scope.testsActualDebuggerConnection = true,
    value => value.profile.automaticDebuggerDetection = true,
    value => value.profile.resumable = true, value => value.profile.connectedValue = 1,
    value => value.cases[0].source.sha256 = '0'.repeat(64),
    value => value.cases[0].observation.stdout = 'present=1',
    value => value.cases[2].observation.stderr = '',
    value => value.cases[2].observation.exitCode = 0,
    value => value.cases[3].observation.trapped = false
  ]) {
    const value = structuredClone(fixture()); edit(value);
    assert.throws(() => verifyDebuggerNativeReport(value));
  }
});

const here = path.dirname(fileURLToPath(import.meta.url));
const identity = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const toolGroups = {
  nativeCompiler: ['cc1', 'cc1plus', 'xgcc'],
  buildTools: ['compiler', 'assembler', 'validator', 'objdump', 'ar', 'nm', 'linker', 'python'],
  reportTools: ['compiler', 'assembler', 'linker', 'validator', 'node']
};

for (const [group, names] of Object.entries(toolGroups)) for (const name of names) {
  test('mandatory ' + group + '.' + name + ' is reopened when omitted from input inventories', async () => {
    // These deliberately incomplete synthetic receipts can only demonstrate rejection.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'debugger-tool-rejection-'));
    try {
      const recipe = async name => {
        const filename = path.join(here, name);
        return { path: filename, ...identity(await fs.readFile(filename)) };
      };
      const lock = JSON.parse(await fs.readFile(path.join(here, 'debugger-runtime.lock.json')));
      const groups = {};
      for (const [group, names] of Object.entries(toolGroups)) {
        groups[group] = {};
        for (const name of names) {
          const filename = path.join(root, group + '-' + name), bytes = Buffer.from(group + '.' + name);
          await fs.writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
          groups[group][name] = { path: filename, ...identity(bytes) };
        }
      }
      const source = { syntheticRejectionFixture: true };
      const build = { kind: 'gcc-wasi-debugger-runtime-build', status: 'built-unverified', host: 'native',
        target: 'wasm32-wasi', inputsUnchanged: true, gccCommit: lock.gccCommit, gccSource: source,
        sourceLock: await recipe('sources.lock.json'), debuggerLock: await recipe('debugger-runtime.lock.json'),
        recipe: await recipe('build-debugger-runtime.py'), source: lock.gccFiles['libstdc++-v3/src/c++26/debugging.cc'],
        profile: lock.profile, nativeCompiler: groups.nativeCompiler, tools: groups.buildTools, inputs: [] };
      const buildPath = path.join(root, 'build.json'), buildBytes = Buffer.from(JSON.stringify(build));
      await fs.writeFile(buildPath, buildBytes, { flag: 'wx', mode: 0o600 });
      const report = { ...fixture(), profile: lock.profile, recipe: await recipe('test-debugger-native.mjs'),
        buildReceipt: { path: buildPath, ...identity(buildBytes) }, tools: groups.reportTools, inputs: [], artifacts: [] };
      const qualification = path.join(root, 'qualification.json');
      await fs.writeFile(qualification, JSON.stringify(report), { flag: 'wx', mode: 0o600 });
      await fs.writeFile(groups[group][name].path, 'changed after its descriptor was recorded');
      await assert.rejects(reopenDebuggerQualification({ runtime: root, qualification,
        nativeBuild: { gccSource: source, gccCommit: lock.gccCommit }, compilerBuild: { gccSource: source } }),
      error => error.code === 'ERR_ASSERTION' && error.message.includes('Changed debugger evidence: ' + groups[group][name].path));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}
