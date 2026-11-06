import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { verifyTimezonePackageOptions, qualifiedTimezoneManifestProfile, packageWasi } from './package.mjs';
import { identity } from '../clang-browser/cross/package.mjs';
import { timezoneCases } from './tzdb-fixtures.mjs';

const options = {
  tzdbQualification: '/qualified/timezone.json', libstdcxx: '/qualified/ordinary',
  ehRuntime: '/qualified/exceptions', ehRuntimeQualification: '/qualified/exceptions.json',
  nativeLinker: '/sdk/bin/wasm-ld'
};

test('legacy timezone-disabled packages retain the existing option contract', () => {
  verifyTimezonePackageOptions({});
  verifyTimezonePackageOptions({}, { timezoneDatabase: false });
});

test('the member-pointer ABI patch also requires the timezone and PMF execution dependency', () => {
  const patches = [{ path: 'patches/0029-wasm-member-function-pointer.patch' }];
  assert.throws(() => verifyTimezonePackageOptions({}, undefined, patches), /tzdbQualification/);
  verifyTimezonePackageOptions(options, undefined, patches);
});

test('a timezone-enabled runtime cannot be packaged without both GNU profiles and execution proof', () => {
  verifyTimezonePackageOptions(options, { timezoneDatabase: true });
  for (const name of Object.keys(options)) {
    const incomplete = { ...options };
    delete incomplete[name];
    assert.throws(() => verifyTimezonePackageOptions(incomplete, { timezoneDatabase: true }), new RegExp(name));
  }
  for (const value of [false, undefined, null, 1, 'true'])
    assert.throws(() => verifyTimezonePackageOptions(options, { timezoneDatabase: value }), /complete timezone-enabled runtime/);
});

test('timezone proof cannot be overwritten by the package output through an alias', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'package-timezone-isolation-'));
  try {
    const work = path.join(root, 'work'), runtime = path.join(root, 'runtime');
    const destination = path.join(root, 'destination'), alias = path.join(root, 'alias');
    await Promise.all([work, runtime, destination].map(directory => fs.mkdir(directory)));
    await fs.symlink(destination, alias, 'dir');
    await fs.mkdir(path.join(destination, 'bundle'));
    const proof = path.join(destination, 'bundle/timezone.json');
    await fs.writeFile(proof, '{}');
    await assert.rejects(packageWasi({ work, runtime, output: path.join(alias, 'bundle'), tzdbQualification: proof }), /Output must not overlap/);
    assert.equal(await fs.readFile(proof, 'utf8'), '{}');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function reviewed() {
  // These are admission-only records. The producer separately reopens actual
  // native compile/link/run artifacts before this metadata boundary is reached.
  const pin = name => identity(Buffer.from(name));
  const gccCommit = 'a'.repeat(40), gccSource = { gccCommit, patches: [] };
  const lock = { schemaVersion: 1, kind: 'gnu-libstdcxx-static-timezone-database',
    gccCommit, version: '2026b', source: pin('source'), data: pin('data'), patch: pin('patch'),
    distribution: { mode: 'embedded', requiredGuestFiles: [], automaticNetworkUpdates: false } };
  const lockIdentity = identity(Buffer.from(JSON.stringify(lock)));
  const tools = Object.fromEntries(['cc1', 'cc1plus'].map(name => [name, pin(name)]));
  const builds = {}, runtimes = {};
  for (const profile of ['ordinary', 'exceptions']) {
    const libraries = Object.fromEntries(['libstdc++.a', 'libsupc++.a'].map(name => [name, pin(profile + name)]));
    const receipt = { status: 'built-unverified', timezoneDatabase: true, exceptions: profile === 'exceptions',
      threads: false, gccCommit, gccSource, nativeCompiler: Object.fromEntries(Object.entries(tools).map(([name, value]) => [name, value.sha256])),
      libraries, timezone: { version: lock.version, lock: lockIdentity, source: lock.source, data: lock.data, patch: lock.patch,
        embedded: true, singleThread: true, archiveMember: 'tzdb.o', archive: libraries['libstdc++.a'],
        atomicInstructions: 0, atomicHelpers: [] } };
    builds[profile] = { receipt, identity: pin(profile + '-build') };
    runtimes[profile] = { build: builds[profile].identity, libraries: structuredClone(libraries) };
  }
  const cases = timezoneCases.map(fixture => ({ id: fixture.id, status: 'passed', request: structuredClone(fixture.request),
    run: structuredClone(fixture.run), expected: { stdout: fixture.stdout, stderr: fixture.stderr, exitCode: fixture.exitCode },
    observations: { stdout: fixture.stdout, stderr: fixture.stderr, exitCode: fixture.exitCode, escapedException: null },
    profile: { atomicInstructions: 0, atomicHelpers: 0, sharedMemory: false } }));
  const execution = { kind: 'gcc-wasi-tzdb-native-qualification', status: 'passed', inputsUnchanged: true,
    mode: 'full-gnu-runtime', fullGnuLibrary: true, compilerHost: 'native', target: 'wasm32-wasi',
    timezoneLock: lockIdentity, memberFunctionPointerQualification: pin('native PMF execution'), gccSource, tools, runtimes, cases,
    counts: { total: 12, ordinary: 10, exceptions: 2, families: 6 }, noGuestPreopens: true, hostTimezoneFilesExposed: false };
  return { builds, execution, lock, lockIdentity };
}

test('only executed full GNU builds advertise timezone support, without changing compiler defaults', () => {
  const value = reviewed();
  const result = qualifiedTimezoneManifestProfile(value.builds, value.execution, value.lock, value.lockIdentity);
  assert.deepEqual(result.capabilities, { timezoneDatabase: true });
  assert.equal(Object.hasOwn(result, 'runtimeLibraries'), false);
  assert.deepEqual(qualifiedTimezoneManifestProfile().capabilities, {});
});

for (const [name, mutate] of [
  ['unexecuted runtime', value => { value.execution.status = 'unverified'; }],
  ['changed inputs', value => { value.execution.inputsUnchanged = false; }],
  ['standalone object preflight', value => { value.execution.mode = 'standalone-preflight'; }],
  ['partial library', value => { value.execution.fullGnuLibrary = false; }],
  ['missing member-pointer regression', value => { delete value.execution.memberFunctionPointerQualification; }],
  ['a Wasm-host label used as native evidence', value => { value.execution.compilerHost = 'wasm32-emscripten'; }],
  ['missing ordinary runtime', value => { delete value.builds.ordinary; }],
  ['missing exception runtime', value => { delete value.builds.exceptions; }],
  ['missing timezone implementation', value => { value.builds.ordinary.receipt.timezoneDatabase = false; }],
  ['replaced implementation source', value => { value.builds.ordinary.receipt.timezone.source = identity(Buffer.from('other source')); }],
  ['replaced embedded database', value => { value.builds.exceptions.receipt.timezone.data = identity(Buffer.from('other data')); }],
  ['different cache port', value => { value.builds.ordinary.receipt.timezone.patch = identity(Buffer.from('other patch')); }],
  ['different GNU compiler', value => { value.builds.exceptions.receipt.nativeCompiler.cc1plus = 'f'.repeat(64); }],
  ['different source profile', value => { value.execution.gccSource = { ...value.execution.gccSource, patches: ['other'] }; }],
  ['different runtime build', value => { value.execution.runtimes.ordinary.build = identity(Buffer.from('other build')); }],
  ['different executed archive', value => { value.execution.runtimes.exceptions.libraries['libstdc++.a'] = identity(Buffer.from('other library')); }],
  ['different component lock', value => { value.execution.timezoneLock = identity(Buffer.from('other lock')); }],
  ['incorrect version', value => { value.builds.ordinary.receipt.timezone.version = '1900a'; }],
  ['guest data dependency', value => { value.lock.distribution.requiredGuestFiles = ['/tzdata.zi']; }],
  ['automatic network update', value => { value.lock.distribution.automaticNetworkUpdates = true; }],
  ['unembedded data', value => { value.builds.ordinary.receipt.timezone.embedded = false; }],
  ['threaded library', value => { value.builds.ordinary.receipt.threads = true; }],
  ['atomic cache instructions', value => { value.builds.ordinary.receipt.timezone.atomicInstructions = 1; }],
  ['atomic helper dependency', value => { value.builds.ordinary.receipt.timezone.atomicHelpers = ['__atomic_compare_exchange_4']; }],
  ['missing execution', value => { value.execution.cases.pop(); }],
  ['duplicated execution', value => { value.execution.cases[0] = value.execution.cases[1]; }],
  ['wrong DST result', value => { value.execution.cases[2].observations.stdout = 'wrong\n'; }],
  ['escaped VM exception', value => { value.execution.cases[0].observations.escapedException = 'table index is out of bounds'; }],
  ['altered optimization profile', value => { value.execution.cases[0].request.optimization = '3'; }],
  ['host timezone access', value => { value.execution.hostTimezoneFilesExposed = true; }],
  ['shared-memory execution', value => { value.execution.cases[0].profile.sharedMemory = true; }],
]) test('timezone admission rejects ' + name, () => {
  const value = reviewed(); mutate(value);
  assert.throws(() => qualifiedTimezoneManifestProfile(value.builds, value.execution, value.lock, value.lockIdentity));
});
