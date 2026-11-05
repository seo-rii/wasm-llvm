import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readTarEntries } from '../../scripts/lib/tar.mjs';
import { deterministicTar } from '../clang-browser/scripts/package-language-sysroots.mjs';
import { debuggerManifest, extendDebuggerSysroot, packageDebugger, verifyDebuggerBase } from './package-debugger.mjs';

const json = value => Buffer.from(JSON.stringify(value) + '\n');
const identity = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });

// Tiny closed evidence graph for admission tests only. No fixture is compiler/runtime evidence.
function admissionFixture() {
  const files = new Map(), recipes = new Map(), sysroot = new Map();
  const source = { gccCommit: 'a'.repeat(40), patches: [], sourceDiffSha256: 'b'.repeat(64) };
  const sourceLock = { gcc: { version: '17.0.0', repository: 'https://example.test/gcc', commit: source.gccCommit, patches: [], sourceDiffSha256: source.sourceDiffSha256 },
    wabt: { repository: 'https://example.test/wabt', version: '1.0.37', commit: 'c'.repeat(40), patches: [], sourceDiffSha256: 'd'.repeat(64), submodules: {} }, wasiSdk: { sha256: 'e'.repeat(64) } };
  const producer = json({ fixture: 'LLVM producer' }), toolchain = json({ fixture: 'LLVM toolchain' });
  const runtimeLock = { wasiLibc: { repository: 'https://example.test/wasi-libc', version: 'wasi-sdk-33', commit: 'f'.repeat(40), sdkArchiveSha256: sourceLock.wasiSdk.sha256, patches: [] },
    browserLinker: { repository: 'https://example.test/llvm', version: '22.1.8', commit: '1'.repeat(40), host: 'wasm32-wasi', producerManifestSha256: identity(producer).sha256, toolchainReceiptSha256: identity(toolchain).sha256 } };
  for (const name of ['build-native.sh', 'build-browser.sh', 'build-wabt.sh', 'prepare-source.py']) recipes.set(name, Buffer.from('fixture recipe ' + name));
  recipes.set('sources.lock.json', json(sourceLock)); recipes.set('runtime.lock.json', json(runtimeLock));
  const header = Buffer.from('synthetic debugging header'), gccInclude = 'lib/gcc/wasm32-wasi/17.0.0/include/stdarg.h';
  for (const name of ['lib/wasm32-wasi/libstdc++.a', 'lib/wasm32-wasi/libsupc++.a', 'lib/wasm32-wasi/libc.a', 'lib/wasm32-wasi/libm.a', 'lib/wasm32-wasi/libclang_rt.builtins-wasm32.a', 'lib/wasm32-wasi/crt1-command.o', gccInclude]) sysroot.set(name, Buffer.from('fixture bytes ' + name));
  sysroot.set('include/c++/17.0.0/debugging', header);
  sysroot.set('include/empty.h', Buffer.alloc(0));
  recipes.set('debugger-runtime.lock.json', json({ gccCommit: source.gccCommit, gccFiles: { 'libstdc++-v3/include/std/debugging': identity(header) } }));
  const assets = Object.fromEntries(Object.entries({ cc1Js: 'cc1.mjs', cc1Wasm: 'cc1.wasm', cc1plusJs: 'cc1plus.mjs', cc1plusWasm: 'cc1plus.wasm', asJs: 'as.mjs', asWasm: 'as.wasm', ldWasm: 'ld.wasm' }).map(([name, filename]) => {
    const bytes = Buffer.from('fixture payload ' + filename); files.set(filename, bytes); return [name, { path: filename, ...identity(bytes) }];
  }));
  const manifest = { schemaVersion: 2, kind: 'gcc-wasm32-wasi', host: 'wasm32-emscripten', target: 'wasm32-wasi', abi: 'wasm32-wasi-preview1', linkMode: 'static', sysrootPath: '/sysroot', gccInstallation: '/sysroot/lib/gcc/wasm32-wasi/17.0.0', resourceDir: '/sysroot/lib/gcc/wasm32-wasi/17.0.0/include',
    compiler: { family: 'gcc', ...Object.fromEntries(['repository', 'version', 'commit'].map(name => [name, sourceLock.gcc[name]])) },
    assembler: { family: 'wabt', ...Object.fromEntries(['repository', 'version', 'commit'].map(name => [name, sourceLock.wabt[name]])) },
    linker: { family: 'lld', ...Object.fromEntries(['repository', 'version', 'commit', 'host'].map(name => [name, runtimeLock.browserLinker[name]])) },
    sysroot: { family: 'wasi-libc', ...Object.fromEntries(['repository', 'version', 'commit'].map(name => [name, runtimeLock.wasiLibc[name]])) },
    capabilities: { c: true, cpp: true, libc: true, libm: true, libstdcxx: true, staticInitialization: true, exceptions: false, rtti: false, threads: false, dynamicLinking: false, simd: false },
    assets, runtimeLibraries: ['/sysroot/lib/wasm32-wasi/libclang_rt.builtins-wasm32.a'], qualification: { status: 'unverified' }, provenance: { gccSource: source, files: {} } };
  const putProof = (name, value) => { const bytes = Buffer.isBuffer(value) ? value : json(value); files.set('provenance/' + name, bytes); manifest.provenance.files[name] = { path: 'provenance/' + name, ...identity(bytes) }; };
  const inventory = entries => [...entries].map(([name, bytes]) => ({ path: name, ...identity(bytes) }));
  function refreshSysroot() { const bytes = deterministicTar([...sysroot].map(([filename, data]) => ({ path: filename, bytes: data }))); files.set('sysroot.tar', bytes); manifest.assets.sysroot = { path: 'sysroot.tar', ...identity(bytes) }; putProof('sysroot-inventory.json', inventory(sysroot)); }
  const native = { schemaVersion: 1, host: 'native', target: manifest.target, gccCommit: source.gccCommit, gccSource: source, sourceLockSha256: identity(recipes.get('sources.lock.json')).sha256, recipeSha256: identity(recipes.get('build-native.sh')).sha256, driverSpecsSha256: '2'.repeat(64), tools: Object.fromEntries(['cc1', 'cc1plus', 'xgcc'].map(name => [name, { sha256: '3'.repeat(64) }])) };
  putProof('sources.lock.json', recipes.get('sources.lock.json')); putProof('runtime.lock.json', recipes.get('runtime.lock.json')); putProof('native-build.json', native);
  putProof('native-qualification.json', { kind: 'gcc-wasi-native-qualification', status: 'passed', host: 'native', target: manifest.target, gccCommit: source.gccCommit, gccSource: source, sourceLockSha256: native.sourceLockSha256, buildReceiptSha256: identity(files.get('provenance/native-build.json')).sha256 });
  const compilerFiles = Object.fromEntries(['cc1.mjs', 'cc1.wasm', 'cc1plus.mjs', 'cc1plus.wasm'].map(name => [name, identity(files.get(name))]));
  compilerFiles['resource-include/stdarg.h'] = identity(sysroot.get(gccInclude));
  putProof('compiler-build.json', { schemaVersion: 1, kind: 'gcc-wasi-browser-build', host: manifest.host, target: manifest.target, gccCommit: source.gccCommit, gccSource: source, sourceLock: identity(recipes.get('sources.lock.json')), recipe: identity(recipes.get('build-browser.sh')), hostUtilityProfile: { name: 'browser-frontends', gcov: false, gcovDump: false, gcovTool: false }, nativeDriverSpecs: { bytes: 11, sha256: native.driverSpecsSha256 }, nativeQualification: identity(files.get('provenance/native-qualification.json')), files: compilerFiles });
  putProof('assembler-build.json', { component: 'wabt', role: 'wasm-object-assembler', host: manifest.host, repository: sourceLock.wabt.repository, version: sourceLock.wabt.version, commit: sourceLock.wabt.commit, inputsUnchanged: true, assemblerArguments: ['-r', '--enable-annotations'], source: { wabtCommit: sourceLock.wabt.commit, patches: [], sourceDiffSha256: sourceLock.wabt.sourceDiffSha256, submodules: {} }, files: Object.fromEntries(['as.mjs', 'as.wasm'].map(name => [name, identity(files.get(name))])), recipes: Object.fromEntries(['build-wabt.sh', 'prepare-source.py', 'sources.lock.json'].map(name => [name, identity(recipes.get(name))])) });
  for (const name of ['build-wabt.sh', 'prepare-source.py', 'sources.lock.json']) putProof('wabt-' + name, recipes.get(name));
  putProof('llvm-producer.json', producer); putProof('llvm-toolchain.json', toolchain);
  putProof('runtime-build.json', { schemaVersion: 1, kind: 'gcc-wasi-runtime-import', target: manifest.target, runtimeLock: identity(recipes.get('runtime.lock.json')), sdkArchiveSha256: sourceLock.wasiSdk.sha256, patches: [], linker: { ...runtimeLock.browserLinker, path: 'ld.wasm', ...identity(files.get('ld.wasm')) }, provenance: { 'llvm-producer.json': identity(producer), 'llvm-toolchain.json': identity(toolchain) }, files: inventory(new Map([...sysroot].filter(([name]) => name === 'include/empty.h' || /\/(?:libc\.a|libm\.a|libclang_rt\.builtins-wasm32\.a|crt1-command\.o)$/.test(name)))) });
  const gnu = { status: 'built-unverified', target: manifest.target, gccCommit: source.gccCommit, gccSource: source, exceptions: false, debugger: false, libraries: Object.fromEntries(['libstdc++.a', 'libsupc++.a'].map(name => [name, identity(sysroot.get('lib/wasm32-wasi/' + name))])) };
  putProof('libstdcxx-buildReceipt.json', gnu);
  const gnuBuild = identity(files.get('provenance/libstdcxx-buildReceipt.json'));
  putProof('libstdcxx-qualification.json', { status: 'passed', target: manifest.target, gccCommit: source.gccCommit, exceptions: false, buildReceipt: gnuBuild });
  putProof('libstdcxx-build.json', { status: 'passed', target: manifest.target, gccCommit: source.gccCommit, exceptions: false, debugger: false, buildReceipt: gnuBuild, qualification: identity(files.get('provenance/libstdcxx-qualification.json')), files: inventory(new Map([...sysroot].filter(([name]) => name.startsWith('include/c++/') || /lib(?:stdc\+\+|supc\+\+)\.a$/.test(name)))) });
  refreshSysroot();
  const manifestBytes = json(manifest), loading = [...Object.values(assets), { path: 'gcc-toolchain.v2.json', ...identity(manifestBytes) }].map(file => ({ ...file, gzipBytes: 20, brotliBytes: 15 }));
  files.set('loading-sizes.json', json({ gzipLevel: 9, brotliQuality: 6, assets: loading, totalBytes: loading.reduce((sum, file) => sum + file.bytes, 0), totalGzipBytes: loading.length * 20, totalBrotliBytes: loading.length * 15 }));
  return { manifest, files, recipes, sysroot, putProof, refreshSysroot, check: () => verifyDebuggerBase({ manifest, manifestBytes: json(manifest), baseFiles: sysroot,
    readBase: async name => { assert(files.has(name), 'Missing fixture ' + name); return files.get(name); },
    readRecipe: async name => { assert(recipes.has(name)); return recipes.get(name); } }) };
}

// Admission fixtures only; these synthetic archives are never runtime evidence.
const libraries = { 'libstdc++debugger.a': Buffer.from('!<arch>\n'), 'libwasi-emulated-signal.a': Buffer.from('!<arch>\n') };
const base = () => ({ schemaVersion: 2, kind: 'gcc-wasm32-wasi', host: 'wasm32-emscripten', target: 'wasm32-wasi',
  capabilities: { cpp: true, libstdcxx: true, debug: true, rtti: true },
  assets: { cc1Wasm: { path: 'cc1.wasm', bytes: 8, sha256: 'retained' }, sysroot: { path: 'sysroot.tar' } },
  runtimeLibraries: ['/sysroot/lib/wasm32-wasi/libclang_rt.builtins-wasm32.a'], qualification: { status: 'unverified' } });

test('extension preserves every existing sysroot file and adds exactly two archives', () => {
  const old = [{ path: 'include/c++/17.0.0/debugging', bytes: Buffer.from('real header supplied by caller') },
    { path: 'lib/wasm32-wasi/libstdc++.a', bytes: Buffer.from('base GNU archive') }];
  const original = deterministicTar(old), extended = extendDebuggerSysroot(original, libraries), entries = readTarEntries(extended.bytes);
  assert.equal([...entries.values()].filter(entry => !entry.directory).length, 4);
  for (const entry of old) {
    const found = entries.get(entry.path);
    assert.deepEqual(extended.bytes.subarray(found.offset, found.offset + found.size), entry.bytes);
  }
  assert.deepEqual(extendDebuggerSysroot(original, libraries), extended, 'Archive generation is deterministic');
});

test('duplicate component paths, malformed archives and incomplete component sets fail closed', () => {
  const empty = deterministicTar([]);
  assert.throws(() => extendDebuggerSysroot(empty, { 'libstdc++debugger.a': libraries['libstdc++debugger.a'] }));
  assert.throws(() => extendDebuggerSysroot(empty, { ...libraries, 'libstdc++exp.a': Buffer.from('!<arch>\n') }));
  assert.throws(() => extendDebuggerSysroot(empty, { ...libraries, 'libstdc++debugger.a': Buffer.from('not an archive') }));
  const duplicate = deterministicTar([{ path: 'lib/wasm32-wasi/libstdc++debugger.a', bytes: libraries['libstdc++debugger.a'] }]);
  assert.throws(() => extendDebuggerSysroot(duplicate, libraries), /already contains/);
});

test('manifest extension retains compiler assets, base capabilities and unverified status', () => {
  const input = base(), snapshot = structuredClone(input), result = debuggerManifest(input, Buffer.from('new tar'));
  assert.deepEqual(input, snapshot);
  assert.equal(result.capabilities.debugger, true);
  assert.equal(result.capabilities.debug, true);
  assert.equal(result.capabilities.rtti, true);
  assert.deepEqual(result.assets.cc1Wasm, input.assets.cc1Wasm);
  assert.equal(result.qualification.status, 'unverified');
  assert.deepEqual(result.runtimeLibraries, [...input.runtimeLibraries,
    '/sysroot/lib/wasm32-wasi/libstdc++debugger.a', '/sysroot/lib/wasm32-wasi/libwasi-emulated-signal.a']);
});

test('unsupported base profiles and attempted qualification promotion are rejected', () => {
  for (const edit of [
    value => value.schemaVersion = 1,
    value => value.kind = 'cross-gcc',
    value => value.target = 'x86_64-linux-gnu',
    value => value.host = 'native',
    value => value.capabilities.cpp = false,
    value => value.capabilities.libstdcxx = false,
    value => value.capabilities.debugger = true,
    value => value.qualification.status = 'verified',
    value => value.runtimeLibraries.push('/sysroot/lib/wasm32-wasi/libstdc++debugger.a'),
    value => value.assets.sysroot.path = '../sysroot.tar'
  ]) {
    const value = base(); edit(value);
    assert.throws(() => debuggerManifest(value, Buffer.from('new tar')));
  }
});

test('full base admission closes the component and sysroot evidence graph including empty headers', async () => {
  const fixture = admissionFixture(), result = await fixture.check();
  assert.equal(result.provenanceFiles, Object.keys(fixture.manifest.provenance.files).length);
  assert.equal(result.sysrootFiles, fixture.sysroot.size);
  assert.equal(result.compilerBuild.kind, 'gcc-wasi-browser-build');
});

test('changed provenance, unsafe descriptors and missing component evidence fail before native admission', async () => {
  for (const [edit, expected] of [
    [value => value.files.set('provenance/compiler-build.json', Buffer.from('{}')), /Base provenance changed/],
    [value => value.manifest.provenance.files['compiler-build.json'].path = '../compiler-build.json', /Unsafe bundle path/],
    [value => delete value.manifest.provenance.files['compiler-build.json'], /Missing base provenance: compiler-build/],
    [value => value.manifest.capabilities.debug = true, /Missing base provenance: native-dwarf/]
  ]) {
    const fixture = admissionFixture(); edit(fixture);
    await assert.rejects(fixture.check, expected);
  }
});

test('self-consistent payload and manifest changes cannot reuse stale compiler, assembler or linker builds', async () => {
  for (const [name, expected] of [['cc1Wasm', /Compiler build file changed/], ['asWasm', /Assembler asset is not/], ['ldWasm', /Linker asset differs/]]) {
    const fixture = admissionFixture(), descriptor = fixture.manifest.assets[name];
    const replacement = Buffer.from('replacement payload with updated manifest digest');
    fixture.files.set(descriptor.path, replacement);
    Object.assign(descriptor, identity(replacement));
    await assert.rejects(fixture.check, expected);
  }
  const fixture = admissionFixture();
  const native = JSON.parse(fixture.files.get('provenance/native-build.json'));
  native.gccSource.sourceDiffSha256 = '0'.repeat(64);
  fixture.putProof('native-build.json', native);
  await assert.rejects(fixture.check, /Native GCC source profile changed/);
});

test('rewritten tar inventories cannot hide runtime changes or a substituted GNU debugging header', async () => {
  const runtime = admissionFixture();
  runtime.sysroot.set('lib/wasm32-wasi/libc.a', Buffer.from('different libc'));
  runtime.refreshSysroot();
  await assert.rejects(runtime.check, /Imported WASI runtime changed/);
  const header = admissionFixture(), filename = 'include/c++/17.0.0/debugging';
  header.sysroot.set(filename, Buffer.from('substituted GNU API declarations'));
  header.refreshSysroot();
  const gnu = JSON.parse(header.files.get('provenance/libstdcxx-build.json'));
  Object.assign(gnu.files.find(file => file.path === filename), identity(header.sysroot.get(filename)));
  header.putProof('libstdcxx-build.json', gnu);
  await assert.rejects(header.check, /Pinned GNU debugging header changed/);
});

test('a rewritten full inventory cannot add files outside the component build inventories', async () => {
  const fixture = admissionFixture();
  fixture.sysroot.set('include/unrecorded.h', Buffer.from('not in a component build'));
  fixture.refreshSysroot();
  await assert.rejects(fixture.check, /Base sysroot component inventory changed/);
});

test('missing and stale inherited loading measurements are rejected rather than relabeled as current', async () => {
  for (const [edit, expected] of [
    [value => value.assets.pop(), /Incomplete base loading measurements/],
    [value => value.assets[0].sha256 = '0'.repeat(64), /Base loading measurement covers another asset/],
    [value => value.totalBytes++, /Invalid base loading total/],
    [value => value.gzipLevel = 1, /Expected values to be strictly equal/]
  ]) {
    const fixture = admissionFixture(), loading = JSON.parse(fixture.files.get('loading-sizes.json'));
    edit(loading); fixture.files.set('loading-sizes.json', json(loading));
    await assert.rejects(fixture.check, expected);
  }
});

test('extended manifest separates historical provenance paths from current extension evidence', () => {
  const input = base();
  input.provenance = { gccSource: { original: true }, files: { 'native-build.json': { path: 'provenance/native-build.json', ...identity(Buffer.from('old proof')) } } };
  const snapshot = structuredClone(input), result = debuggerManifest(input, Buffer.from('extended sysroot'));
  assert.deepEqual(input, snapshot);
  assert.equal(result.provenance.base.files['native-build.json'].path, 'provenance/base/native-build.json');
  assert.deepEqual(result.provenance.files, {});
  assert.match(result.provenance.base.scope, /excludes the auxiliary debugger/);
});

test('symlink aliases into inputs and existing outputs are rejected before reading or changing inputs', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gcc-debugger-package-control-'));
  try {
    const baseDir = path.join(temporary, 'base'), runtime = path.join(temporary, 'runtime'), alias = path.join(temporary, 'alias');
    await fs.mkdir(baseDir); await fs.mkdir(runtime); await fs.symlink(baseDir, alias, 'dir');
    await assert.rejects(packageDebugger({ base: baseDir, runtime, qualification: 'not-read.json', output: path.join(alias, 'new-output') }), /Output must be isolated/);
    assert.deepEqual(await fs.readdir(baseDir), []);
    const output = path.join(temporary, 'existing'); await fs.mkdir(output);
    await assert.rejects(packageDebugger({ base: baseDir, runtime, qualification: 'not-read.json', output }), /Output already exists/);
    assert.deepEqual(await fs.readdir(output), []);
    const runtimeAlias = path.join(temporary, 'runtime-alias'); await fs.symlink(runtime, runtimeAlias, 'dir');
    await assert.rejects(packageDebugger({ base: baseDir, runtime, qualification: 'not-read.json', output: path.join(runtimeAlias, 'new-output') }), /Output must be isolated/);
    const dangling = path.join(temporary, 'dangling'); await fs.symlink(path.join(temporary, 'missing'), dangling, 'dir');
    await assert.rejects(packageDebugger({ base: baseDir, runtime, qualification: 'not-read.json', output: dangling }), /Output already exists/);
    const qualification = path.join(temporary, 'qualification.json'); await fs.writeFile(qualification, '{}');
    const normalized = path.join(temporary, 'normalized-output');
    await assert.rejects(packageDebugger({ base: baseDir, runtime, qualification, output: normalized + '/.' }),
      error => error.code === 'ENOENT' && error.path === path.join(baseDir, 'gcc-toolchain.v2.json'));
    await assert.rejects(fs.lstat(normalized), { code: 'ENOENT' });
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

// Opt in to read-only checks against a retained genuine bundle. Mutations live only in memory.
test('genuine base evidence admits unchanged inputs and rejects in-memory corruption',
  { skip: !process.env.GCC_WASI_DEBUGGER_BASE }, async t => {
    const directory = await fs.realpath(process.env.GCC_WASI_DEBUGGER_BASE), cachedFiles = new Map(), recipes = new Map();
    async function original(name) {
      if (!cachedFiles.has(name)) cachedFiles.set(name, fs.readFile(path.join(directory, name)));
      return cachedFiles.get(name);
    }
    const originalManifestBytes = await original('gcc-toolchain.v2.json'), originalManifest = JSON.parse(originalManifestBytes);
    const originalTar = await original('sysroot.tar');
    const originalSysroot = new Map([...readTarEntries(originalTar).values()].filter(entry => !entry.directory)
      .map(entry => [entry.name, originalTar.subarray(entry.offset, entry.offset + entry.size)]));
    function fixture() {
      const manifest = structuredClone(originalManifest), files = new Map(), sysroot = new Map(originalSysroot);
      const readBase = async name => files.has(name) ? files.get(name) : original(name);
      const putProof = (name, value) => {
        const bytes = Buffer.isBuffer(value) ? value : json(value);
        files.set('provenance/' + name, bytes);
        manifest.provenance.files[name] = { path: 'provenance/' + name, ...identity(bytes) };
      };
      function refreshSysroot() {
        const bytes = deterministicTar([...sysroot].map(([filename, data]) => ({ path: filename, bytes: data })));
        files.set('sysroot.tar', bytes); Object.assign(manifest.assets.sysroot, identity(bytes));
        putProof('sysroot-inventory.json', [...sysroot].map(([filename, data]) => ({ path: filename, ...identity(data) })));
      }
      return { manifest, files, sysroot, putProof, refreshSysroot, readBase,
        check: () => verifyDebuggerBase({ manifest,
          manifestBytes: JSON.stringify(manifest) === JSON.stringify(originalManifest) ? originalManifestBytes : json(manifest),
          baseFiles: sysroot, readBase, readRecipe: async name => {
            if (!recipes.has(name)) recipes.set(name, fs.readFile(new URL(name, import.meta.url)));
            return recipes.get(name);
          } }) };
    }
    await t.test('unchanged genuine component graph', async () => {
      const value = fixture(), admitted = await value.check();
      assert.equal(admitted.provenanceFiles, Object.keys(originalManifest.provenance.files).length);
      assert.equal(admitted.sysrootFiles, originalSysroot.size);
    });
    await t.test('compiler payload digest', async () => {
      const value = fixture(); value.files.set('cc1.wasm', Buffer.from('corrupt compiler'));
      await assert.rejects(value.check, /Base asset changed: cc1Wasm/);
    });
    await t.test('historical provenance payload digest', async () => {
      const value = fixture(); value.files.set('provenance/native-symbol-alias-programs.json', Buffer.from('{}'));
      await assert.rejects(value.check, /Base provenance changed: native-symbol-alias-programs.json/);
    });
    for (const [name, expected] of [['cc1Wasm', /Compiler build file changed: cc1.wasm/],
      ['asWasm', /Assembler asset is not its recorded build output/], ['ldWasm', /Linker asset differs from runtime import/]]) {
      await t.test('self-consistent replacement of ' + name, async () => {
        const value = fixture(), bytes = Buffer.from('replacement asset'), asset = value.manifest.assets[name];
        value.files.set(asset.path, bytes); Object.assign(asset, identity(bytes));
        await assert.rejects(value.check, expected);
      });
    }
    await t.test('native source receipt binding', async () => {
      const value = fixture(), native = JSON.parse(await value.readBase('provenance/native-build.json'));
      native.gccSource.sourceDiffSha256 = '0'.repeat(64); value.putProof('native-build.json', native);
      await assert.rejects(value.check, /Native GCC source profile changed/);
    });
    for (const [name, expected] of [
      ['lib/gcc/wasm32-wasi/17.0.0/include/stdarg.h', /Compiler resource header changed/],
      ['lib/wasm32-wasi/libc.a', /Imported WASI runtime changed/],
      ['lib/wasm32-wasi/libstdc++.a', /GNU runtime changed/]
    ]) {
      await t.test('rewritten inventory for ' + name, async () => {
        const value = fixture(); assert(value.sysroot.has(name));
        value.sysroot.set(name, Buffer.from('replacement sysroot file')); value.refreshSysroot();
        await assert.rejects(value.check, expected);
      });
    }
    await t.test('GNU debugging header remains pinned beyond rewritten GNU and full inventories', async () => {
      const value = fixture(), name = 'include/c++/17.0.0/debugging', bytes = Buffer.from('substituted debugging declarations');
      value.sysroot.set(name, bytes); value.refreshSysroot();
      const gnu = JSON.parse(await value.readBase('provenance/libstdcxx-build.json'));
      Object.assign(gnu.files.find(file => file.path === name), identity(bytes)); value.putProof('libstdcxx-build.json', gnu);
      await assert.rejects(value.check, /Pinned GNU debugging header changed/);
    });
    await t.test('complete component inventory excludes extra files', async () => {
      const value = fixture(); value.sysroot.set('include/unrecorded.h', Buffer.from('unrecorded header')); value.refreshSysroot();
      await assert.rejects(value.check, /Base sysroot component inventory changed/);
    });
  });
