import assert from 'node:assert/strict';
import test from 'node:test';
import { exceptionRuntimeFiles, exceptionRuntimeLinkFlags,
  verifyExceptionRuntimeBuildMetadata, verifyExceptionRuntimeExecutionMetadata } from '../eh-runtime-qualification.mjs';
import { nativeEhCases } from '../eh-native-fixtures.mjs';
import { exceptionRuntimeCases } from '../eh-runtime-fixtures.mjs';
import { exceptionLibraryCases } from '../eh-library-fixtures.mjs';

const stamp = { bytes: 1, sha256: '0'.repeat(64) };
const expected = { gccSource: { sourceDiffSha256: '1'.repeat(64) },
  nativeBuild: stamp, sourceLockSha256: '2'.repeat(64), runtimeBuild: stamp };
function build() {
  return { schemaVersion: 1, kind: 'gcc-wasi-exception-runtime-build', status: 'built-unverified',
    inputsUnchanged: true, fullGnuLibrary: true, timezoneDatabase: true,
    target: 'wasm32-wasi', profile: 'ordinary-private-modern',
    exceptions: true, rtti: true, threads: false, userTls: false, sharedMemory: false, coverage: false, debugger: false,
    gccSource: expected.gccSource, nativeBuild: stamp, sourceLock: { ...stamp, sha256: expected.sourceLockSha256 },
    files: exceptionRuntimeFiles.map(path => ({ path, ...stamp })),
    licenses: ['COPYING.RUNTIME', 'COPYING3', 'libunwind-LICENSE.TXT'].map(path => ({ path, ...stamp })),
    linkFlags: [...exceptionRuntimeLinkFlags], filePrefixMap: { from: '/private/build', to: '/gcc-wasi-eh-runtime' },
    compilerFlags: { CXXFLAGS: '-mexception-handling -fexceptions -frtti -save-temps=obj -ffile-prefix-map=/private/build=/gcc-wasi-eh-runtime', EXTRA_CXX_FLAGS: '' },
    headers: Array.from({ length: 101 }, (_, index) => ({ path: `include/c++/17.0.0/header-${index}`, ...stamp })),
    inputs: Array.from({ length: 101 }, (_, index) => ({ path: `/input-${index}`, ...stamp })) };
}
function execution() {
  const fixtures = [...nativeEhCases, ...exceptionRuntimeCases, ...exceptionLibraryCases];
  return { schemaVersion: 1, kind: 'gnu-native-wasm-eh-execution', status: 'passed', inputsUnchanged: true,
    scope: 'full-gnu-runtime', fullGnuLibrary: true, gccSource: expected.gccSource, nativeBuild: stamp,
    sourceLock: { ...stamp, sha256: expected.sourceLockSha256 }, runtimeBuild: stamp,
    counts: { total: 46, native: 14, runtime: 14, library: 18 },
    commands: Array.from({ length: 47 }, () => ({ exitCode: 0, timedOut: false })),
    nativeCaseIds: nativeEhCases.map(fixture => fixture.id), files: build().files,
    cases: fixtures.map(fixture => {
      const oracle = fixture.expected ?? { stdout: fixture.stdout, stderr: fixture.stderr, exitCode: fixture.exitCode };
      return { id: fixture.id, status: 'passed', request: fixture.request, run: fixture.run ?? {}, expected: oracle,
        observations: { escapedException: null, stdout: oracle.stdout, stderr: oracle.stderr ?? '', exitCode: oracle.exitCode },
        units: Array.from({ length: 1 + (fixture.request.sources?.length ?? 0) }, () => ({})) };
    }) };
}

test('the bounded build and execution schemas admit the full real-library contract', () => {
  verifyExceptionRuntimeBuildMetadata(build(), expected);
  verifyExceptionRuntimeExecutionMetadata(execution(), expected);
});
test('a bootstrap, timezone-less or already promoted build cannot replace the full archive build', () => {
  for (const changes of [{ fullGnuLibrary: false }, { timezoneDatabase: false }, { timezoneDatabase: undefined },
    { status: 'passed' }, { profile: 'reference' }, { inputsUnchanged: false }])
    assert.throws(() => verifyExceptionRuntimeBuildMetadata({ ...build(), ...changes }, expected));
});
test('default abort helpers and unqualified runtime options are rejected', () => {
  for (const option of ['-fno-exceptions', '-fno-rtti', '-mtls', '-matomics', '--coverage']) {
    const report = build(); report.compilerFlags.EXTRA_CXX_FLAGS = option;
    assert.throws(() => verifyExceptionRuntimeBuildMetadata(report, expected));
  }
});
test('every canonical provider, GNU license and entry wrapper is mandatory', () => {
  for (const key of ['files', 'licenses', 'linkFlags']) {
    const report = build(); report[key].pop();
    assert.throws(() => verifyExceptionRuntimeBuildMetadata(report, expected));
  }
  const duplicate = build(); duplicate.files[1] = duplicate.files[0];
  assert.throws(() => verifyExceptionRuntimeBuildMetadata(duplicate, expected));
});
test('source, compiler and runtime build identities must match the caller context', () => {
  assert.throws(() => verifyExceptionRuntimeBuildMetadata(build(), { ...expected, sourceLockSha256: '3'.repeat(64) }));
  assert.throws(() => verifyExceptionRuntimeBuildMetadata(build(), { ...expected, gccSource: {} }));
  assert.throws(() => verifyExceptionRuntimeExecutionMetadata(execution(), { ...expected, runtimeBuild: { ...stamp, bytes: 2 } }));
});
test('a raw VM exception cannot stand in for GNU terminate or catch', () => {
  for (const index of [0, 10, 11, 24]) {
    const report = execution(); report.cases[index].observations.escapedException = { nativeException: true };
    assert.throws(() => verifyExceptionRuntimeExecutionMetadata(report, expected));
  }
});
test('termination marker, status and exact stdio are independent requirements', () => {
  for (const change of [{ exitCode: 0 }, { stdout: '' }, { stderr: 'warning' }]) {
    const report = execution(); Object.assign(report.cases[10].observations, change);
    assert.throws(() => verifyExceptionRuntimeExecutionMetadata(report, expected));
  }
});
test('all native14 and library18 cases, units, source requests and inputs are required', () => {
  for (const mutate of [report => report.cases.pop(), report => report.nativeCaseIds.reverse(),
    report => report.cases[0].request = { ...report.cases[0].request, exceptions: false },
    report => report.cases[2].units.pop(), report => report.counts.library = 0,
    report => report.commands[0].timedOut = true]) {
    const report = execution(); mutate(report);
    assert.throws(() => verifyExceptionRuntimeExecutionMetadata(report, expected));
  }
});
test('GNU header inventory cannot contain traversal or duplicate paths', () => {
  for (const badPath of ['include/c++/../other', '/outside', 'include/c++/17.0.0/header-1']) {
    const report = build(); report.headers[0].path = badPath;
    assert.throws(() => verifyExceptionRuntimeBuildMetadata(report, expected));
  }
});
