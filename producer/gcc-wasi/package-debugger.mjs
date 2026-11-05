#!/usr/bin/env node
// Extend a pinned base bundle without replacing its compiler or GNU libraries.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { readTarEntries } from '../../scripts/lib/tar.mjs';
import { deterministicTar } from '../clang-browser/scripts/package-language-sysroots.mjs';
import { reopenDebuggerQualification } from './debugger-qualification.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const identity = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const libraryNames = ['libstdc++debugger.a', 'libwasi-emulated-signal.a'];
const assetPaths = {
  cc1Js: 'cc1.mjs', cc1Wasm: 'cc1.wasm', cc1plusJs: 'cc1plus.mjs', cc1plusWasm: 'cc1plus.wasm',
  asJs: 'as.mjs', asWasm: 'as.wasm', ldWasm: 'ld.wasm', sysroot: 'sysroot.tar'
};
function relativeFile(value) {
  assert(typeof value === 'string' && value && !/[\\\x00-\x1f\x7f]/.test(value)
    && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..'), 'Unsafe bundle path');
  return value;
}
function contentAsset(asset) {
  assert(asset && Number.isSafeInteger(asset.bytes) && asset.bytes >= 0 && /^[a-f0-9]{64}$/.test(asset.sha256), 'Invalid content identity');
  return { bytes: asset.bytes, sha256: asset.sha256 };
}
const inside = (root, value) => {
  const relative = path.relative(root, value);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};

export function extendDebuggerSysroot(baseBytes, libraries) {
  assert.deepEqual(Object.keys(libraries).sort(), [...libraryNames].sort());
  const entries = readTarEntries(baseBytes);
  const files = [...entries.values()].filter(entry => !entry.directory).map(entry => ({
    path: entry.name, bytes: baseBytes.subarray(entry.offset, entry.offset + entry.size)
  }));
  for (const name of libraryNames) {
    const filename = 'lib/wasm32-wasi/' + name;
    assert(!entries.has(filename), 'Base bundle already contains a debugger component');
    assert.equal(Buffer.from(libraries[name]).subarray(0, 8).toString(), '!<arch>\n', 'Expected a real static archive');
    files.push({ path: filename, bytes: Buffer.from(libraries[name]) });
  }
  return { bytes: deterministicTar(files), inventory: files.map(file => ({ path: file.path, ...identity(file.bytes) })) };
}

export function debuggerManifest(base, sysroot) {
  assert.equal(base.schemaVersion, 2);
  assert.equal(base.kind, 'gcc-wasm32-wasi');
  assert.equal(base.host, 'wasm32-emscripten');
  assert.equal(base.target, 'wasm32-wasi');
  assert.equal(base.capabilities?.cpp, true);
  assert.equal(base.capabilities?.libstdcxx, true);
  assert(!base.capabilities.debugger, 'Base bundle already advertises debugger support');
  assert.equal(base.qualification?.status, 'unverified', 'Packaging never promotes qualification status');
  assert.equal(base.assets?.sysroot?.path, 'sysroot.tar');
  assert(Array.isArray(base.runtimeLibraries));
  const added = libraryNames.map(name => '/sysroot/lib/wasm32-wasi/' + name);
  assert(!base.runtimeLibraries.some(name => added.includes(name)));
  return {
    ...base,
    assets: { ...base.assets, sysroot: { path: 'sysroot.tar', ...identity(sysroot) } },
    runtimeLibraries: [...base.runtimeLibraries, ...added],
    capabilities: { ...base.capabilities, debugger: true },
    provenance: {
      gccSource: base.provenance?.gccSource,
      base: {
        ...base.provenance,
        scope: 'Original compiler and base runtime evidence; excludes the auxiliary debugger component.',
        files: Object.fromEntries(Object.entries(base.provenance?.files ?? {}).map(([name, file]) => {
          assert(relativeFile(file.path).startsWith('provenance/'), 'Unexpected base provenance path');
          return [name, { ...file, path: 'provenance/base/' + file.path.slice('provenance/'.length) }];
        }))
      },
      files: {}
    },
    limitations: [
      ...(base.limitations ?? []).map(text => text === 'GNU libstdc++ timezone database, C++26 debugger functions and prebuilt std modules are unavailable; no fallback implementations are provided.'
        ? 'GNU libstdc++ timezone database and prebuilt std modules remain unavailable.' : text),
      'C++26 debugger functions use the original GNU observer registration variable. A debugger must register -1 after enabling its Worker session and clear it before orderly detach; terminate the Worker after unexpected observer loss. Other DevTools sessions are not detected automatically.',
      'std::breakpoint and a registered std::breakpoint_if_debugging emit a terminal Wasm unreachable trap. A debugger can observe the pause; continuing the guest after that call is unsupported.',
      'The auxiliary GNU debugger archive contains only the pinned debugging.cc component; it does not provide other libstdc++exp interfaces. Positive signal registration values and POSIX debugger detection are outside this profile.'
    ],
    qualification: { status: 'unverified' }
  };
}

/** Bind an existing package to its pinned component receipts without requalifying its old matrix. */
export async function verifyDebuggerBase({ manifest, manifestBytes, baseFiles, readBase, readRecipe }) {
  const sourceLockBytes = await readRecipe('sources.lock.json'), sourceLock = JSON.parse(sourceLockBytes);
  const runtimeLockBytes = await readRecipe('runtime.lock.json'), runtimeLock = JSON.parse(runtimeLockBytes);
  const debuggerLock = JSON.parse(await readRecipe('debugger-runtime.lock.json'));
  assert.deepEqual(JSON.parse(manifestBytes), manifest);
  debuggerManifest(manifest, Buffer.from('profile validation'));
  for (const [field, family, expected] of [
    ['compiler', 'gcc', sourceLock.gcc], ['assembler', 'wabt', sourceLock.wabt],
    ['sysroot', 'wasi-libc', runtimeLock.wasiLibc]
  ]) assert.deepEqual(manifest[field], { family, repository: expected.repository, version: expected.version, commit: expected.commit }, 'Base component revision changed: ' + field);
  assert.deepEqual(manifest.linker, Object.fromEntries(['repository', 'commit', 'version', 'host'].map(name => [name, runtimeLock.browserLinker[name]]).concat([['family', 'lld']])), 'Base linker revision changed');
  assert.equal(manifest.abi, 'wasm32-wasi-preview1');
  assert.equal(manifest.linkMode, 'static');
  assert.equal(manifest.sysrootPath, '/sysroot');
  assert.equal(manifest.gccInstallation, '/sysroot/lib/gcc/wasm32-wasi/' + sourceLock.gcc.version);
  assert.equal(manifest.resourceDir, manifest.gccInstallation + '/include');
  for (const name of ['c', 'cpp', 'libc', 'libm', 'libstdcxx', 'staticInitialization', 'rtti', 'simd'])
    assert.equal(typeof manifest.capabilities[name], 'boolean', 'Invalid base capability: ' + name);
  assert.equal(manifest.capabilities.c, true);
  for (const name of ['exceptions', 'threads', 'dynamicLinking']) assert.equal(manifest.capabilities[name], false);
  for (const name of ['debug', 'coverage', 'longDouble', 'int128', 'debugger'])
    assert(manifest.capabilities[name] === undefined || typeof manifest.capabilities[name] === 'boolean', 'Invalid base capability: ' + name);
  assert.deepEqual(Object.keys(manifest.assets).sort(), Object.keys(assetPaths).sort(), 'Unexpected base asset set');
  for (const [name, filename] of Object.entries(assetPaths)) {
    assert.equal(manifest.assets[name].path, filename);
    assert(manifest.assets[name].bytes > 0, 'Empty base asset');
    assert.deepEqual(identity(await readBase(filename)), contentAsset(manifest.assets[name]), 'Base asset changed: ' + name);
  }
  const proofs = new Map();
  assert(manifest.provenance?.files && !Array.isArray(manifest.provenance.files), 'Missing base provenance');
  for (const [name, file] of Object.entries(manifest.provenance.files)) {
    assert.equal(relativeFile(file.path), 'provenance/' + relativeFile(name), 'Unexpected base provenance path');
    const bytes = await readBase(file.path);
    assert.deepEqual(identity(bytes), contentAsset(file), 'Base provenance changed: ' + name);
    proofs.set(name, bytes);
  }
  const proof = name => { assert(proofs.has(name), 'Missing base provenance: ' + name); return proofs.get(name); };
  const parsed = name => JSON.parse(proof(name));
  assert.deepEqual(proof('sources.lock.json'), sourceLockBytes, 'Base source lock changed');
  assert.deepEqual(proof('runtime.lock.json'), runtimeLockBytes, 'Base runtime lock changed');
  const nativeBytes = proof('native-build.json'), nativeBuild = JSON.parse(nativeBytes);
  const compilerBuild = parsed('compiler-build.json'), assemblerBuild = parsed('assembler-build.json');
  const imported = parsed('runtime-build.json'), nativeQualification = parsed('native-qualification.json');
  const gccSource = { gccCommit: sourceLock.gcc.commit, patches: sourceLock.gcc.patches ?? [], sourceDiffSha256: sourceLock.gcc.sourceDiffSha256 };
  assert.deepEqual(nativeBuild.gccSource, gccSource, 'Native GCC source profile changed');
  assert.deepEqual(compilerBuild.gccSource, gccSource, 'Compiler GCC source profile changed');
  assert.deepEqual(manifest.provenance.gccSource, gccSource, 'Manifest GCC source profile changed');
  assert.equal(nativeBuild.schemaVersion, 1); assert.equal(nativeBuild.host, 'native'); assert.equal(nativeBuild.target, manifest.target);
  assert.equal(nativeBuild.gccCommit, sourceLock.gcc.commit);
  assert.equal(nativeBuild.sourceLockSha256, identity(sourceLockBytes).sha256);
  assert.equal(nativeBuild.recipeSha256, identity(await readRecipe('build-native.sh')).sha256);
  for (const name of ['cc1', 'cc1plus', 'xgcc']) assert(/^[a-f0-9]{64}$/.test(nativeBuild.tools?.[name]?.sha256), 'Missing native compiler identity');
  assert.equal(compilerBuild.schemaVersion, 1); assert.equal(compilerBuild.kind, 'gcc-wasi-browser-build');
  assert.equal(compilerBuild.host, manifest.host); assert.equal(compilerBuild.target, manifest.target);
  assert.equal(compilerBuild.gccCommit, sourceLock.gcc.commit);
  assert.deepEqual(contentAsset(compilerBuild.sourceLock), identity(sourceLockBytes));
  assert.deepEqual(contentAsset(compilerBuild.recipe), identity(await readRecipe('build-browser.sh')));
  assert.deepEqual(compilerBuild.hostUtilityProfile, { name: 'browser-frontends', gcov: false, gcovDump: false, gcovTool: false });
  assert.equal(compilerBuild.nativeDriverSpecs.sha256, nativeBuild.driverSpecsSha256);
  assert.deepEqual(contentAsset(compilerBuild.nativeQualification), identity(proof('native-qualification.json')));
  assert.equal(nativeQualification.kind, 'gcc-wasi-native-qualification'); assert.equal(nativeQualification.status, 'passed');
  assert.equal(nativeQualification.host, 'native'); assert.equal(nativeQualification.target, manifest.target);
  assert.equal(nativeQualification.gccCommit, sourceLock.gcc.commit);
  assert.deepEqual(nativeQualification.gccSource, gccSource);
  assert.equal(nativeQualification.sourceLockSha256, identity(sourceLockBytes).sha256);
  assert.equal(nativeQualification.buildReceiptSha256, identity(nativeBytes).sha256);
  const sysrootEntry = (name, expected, label) => {
    assert(baseFiles.has(relativeFile(name)), 'Missing base sysroot file: ' + name);
    assert.deepEqual(identity(baseFiles.get(name)), contentAsset(expected), label + ': ' + name);
  };
  const checkEntries = (entries, label) => {
    assert(Array.isArray(entries) && entries.length, 'Missing ' + label);
    const seen = new Set();
    for (const file of entries) { assert(!seen.has(file.path), 'Duplicate ' + label + ' path'); seen.add(file.path); sysrootEntry(file.path, file, label); }
    return seen;
  };
  const allFiles = checkEntries(parsed('sysroot-inventory.json'), 'Base sysroot inventory');
  assert.deepEqual([...allFiles].sort(), [...baseFiles.keys()].sort(), 'Base sysroot file set changed');
  const compilerHeaders = [];
  for (const [name, file] of Object.entries(compilerBuild.files)) {
    relativeFile(name);
    if (name.startsWith('resource-include/')) {
      const filename = manifest.resourceDir.slice('/sysroot/'.length) + '/' + name.slice('resource-include/'.length);
      sysrootEntry(filename, file, 'Compiler resource header changed');
      compilerHeaders.push(filename);
    }
    else assert.deepEqual(identity(await readBase(name)), contentAsset(file), 'Compiler build file changed: ' + name);
  }
  assert.deepEqual(Object.keys(compilerBuild.files).filter(name => name.startsWith('resource-include/')).map(name => name.slice('resource-include/'.length)).sort(),
    [...baseFiles.keys()].filter(name => name.startsWith(manifest.resourceDir.slice('/sysroot/'.length) + '/')).map(name => name.slice(manifest.resourceDir.slice('/sysroot/'.length).length + 1)).sort(), 'Compiler resource header set changed');
  for (const name of ['cc1Js', 'cc1Wasm', 'cc1plusJs', 'cc1plusWasm'])
    assert.deepEqual(contentAsset(manifest.assets[name]), contentAsset(compilerBuild.files[assetPaths[name]]), 'Compiler asset is not its recorded build output');
  assert.equal(assemblerBuild.component, 'wabt'); assert.equal(assemblerBuild.role, 'wasm-object-assembler');
  for (const name of ['repository', 'commit', 'version']) assert.equal(assemblerBuild[name], sourceLock.wabt[name]);
  assert.equal(assemblerBuild.host, manifest.host); assert.equal(assemblerBuild.inputsUnchanged, true);
  assert.deepEqual(assemblerBuild.assemblerArguments, ['-r', '--enable-annotations']);
  assert.deepEqual(assemblerBuild.source, { wabtCommit: sourceLock.wabt.commit, patches: sourceLock.wabt.patches ?? [], sourceDiffSha256: sourceLock.wabt.sourceDiffSha256, submodules: sourceLock.wabt.submodules });
  assert.deepEqual(Object.keys(assemblerBuild.files).sort(), ['as.mjs', 'as.wasm']);
  for (const name of ['asJs', 'asWasm']) assert.deepEqual(contentAsset(manifest.assets[name]), contentAsset(assemblerBuild.files[assetPaths[name]]), 'Assembler asset is not its recorded build output');
  for (const name of ['build-wabt.sh', 'prepare-source.py', 'sources.lock.json']) {
    const bytes = await readRecipe(name);
    assert.deepEqual(contentAsset(assemblerBuild.recipes[name]), identity(bytes));
    assert.deepEqual(proof('wabt-' + name), bytes, 'WABT recipe changed');
  }
  for (const patch of [...(sourceLock.gcc.patches ?? []), ...(sourceLock.wabt.patches ?? []), ...(runtimeLock.wasiLibc.patches ?? [])])
    assert.equal(identity(proof(path.posix.basename(relativeFile(patch.path)))).sha256, patch.sha256, 'Base patch changed');
  assert.equal(imported.schemaVersion, 1); assert.equal(imported.kind, 'gcc-wasi-runtime-import'); assert.equal(imported.target, manifest.target);
  assert.deepEqual(contentAsset(imported.runtimeLock), identity(runtimeLockBytes));
  assert.equal(imported.sdkArchiveSha256, runtimeLock.wasiLibc.sdkArchiveSha256);
  assert.equal(imported.sdkArchiveSha256, sourceLock.wasiSdk.sha256);
  assert.deepEqual(imported.patches, runtimeLock.wasiLibc.patches ?? []);
  for (const [name, value] of Object.entries(runtimeLock.browserLinker)) assert.deepEqual(imported.linker[name], value, 'Imported linker pin changed: ' + name);
  assert.equal(imported.linker.path, assetPaths.ldWasm);
  assert.deepEqual(contentAsset(imported.linker), contentAsset(manifest.assets.ldWasm), 'Linker asset differs from runtime import');
  assert.equal(identity(proof('llvm-producer.json')).sha256, runtimeLock.browserLinker.producerManifestSha256);
  assert.equal(identity(proof('llvm-toolchain.json')).sha256, runtimeLock.browserLinker.toolchainReceiptSha256);
  for (const [name, expected] of Object.entries(imported.provenance)) assert.deepEqual(identity(proof(name)), contentAsset(expected), 'Imported LLVM provenance changed');
  const importedFiles = checkEntries(imported.files, 'Imported WASI runtime changed');
  const gnu = parsed('libstdcxx-buildReceipt.json'), gnuReceipt = parsed('libstdcxx-build.json'), gnuQualification = parsed('libstdcxx-qualification.json');
  for (const value of [gnu, gnuReceipt, gnuQualification]) { assert.equal(value.target, manifest.target); assert.equal(value.gccCommit, sourceLock.gcc.commit); assert.equal(value.exceptions, false); }
  assert.equal(gnu.status, 'built-unverified'); assert.equal(gnuReceipt.status, 'passed'); assert.equal(gnuQualification.status, 'passed');
  assert.equal(gnu.debugger, false); assert.equal(gnuReceipt.debugger, false);
  assert.deepEqual(gnu.gccSource, gccSource);
  assert.deepEqual(contentAsset(gnuReceipt.buildReceipt), identity(proof('libstdcxx-buildReceipt.json')));
  assert.deepEqual(contentAsset(gnuQualification.buildReceipt), identity(proof('libstdcxx-buildReceipt.json')));
  assert.deepEqual(contentAsset(gnuReceipt.qualification), identity(proof('libstdcxx-qualification.json')));
  const gnuFiles = checkEntries(gnuReceipt.files, 'GNU runtime changed');
  assert.deepEqual(Object.keys(gnu.libraries).sort(), ['libstdc++.a', 'libsupc++.a'], 'Incomplete GNU runtime archive set');
  for (const [name, file] of Object.entries(gnu.libraries)) sysrootEntry('lib/wasm32-wasi/' + relativeFile(name), file, 'GNU archive changed');
  assert.equal(debuggerLock.gccCommit, sourceLock.gcc.commit);
  sysrootEntry('include/c++/' + sourceLock.gcc.version + '/debugging', debuggerLock.gccFiles['libstdc++-v3/include/std/debugging'], 'Pinned GNU debugging header changed');
  assert.equal(new Set(manifest.runtimeLibraries).size, manifest.runtimeLibraries.length, 'Duplicate base runtime library');
  assert(manifest.runtimeLibraries.includes('/sysroot/lib/wasm32-wasi/libclang_rt.builtins-wasm32.a'), 'Missing base compiler builtins');
  for (const name of manifest.runtimeLibraries) {
    assert(name.startsWith('/sysroot/'), 'Invalid base runtime library path');
    const relative = relativeFile(name.slice('/sysroot/'.length));
    assert(relative.endsWith('.a') && baseFiles.has(relative), 'Missing base runtime archive');
  }
  for (const [capability, names] of Object.entries({ debug: ['native-dwarf-qualification.json'], coverage: ['native-coverage-qualification.json'], rtti: ['native-rtti-qualification.json'], longDouble: ['native-long-double-qualification.json'], int128: ['native-int128-qualification.json'], simd: ['native-simd-qualification.json', 'native-simd-extended-qualification.json', 'native-simd-saturating-qualification.json', 'native-simd-conversions-qualification.json', 'native-simd-header-qualification.json', 'native-vector-abi-qualification.json'] }))
    if (manifest.capabilities[capability]) for (const name of names) assert.equal(parsed(name).status, 'passed', 'Base capability lacks passed evidence: ' + capability);
  const coverageFiles = manifest.capabilities.coverage ? checkEntries(parsed('libgcov-build.json').files, 'Coverage runtime changed') : [];
  assert.deepEqual([...new Set([...compilerHeaders, ...importedFiles, ...gnuFiles, ...coverageFiles])].sort(),
    [...allFiles].sort(), 'Base sysroot component inventory changed');
  const baseLoading = JSON.parse(await readBase('loading-sizes.json'));
  assert.equal(baseLoading.gzipLevel, 9); assert.equal(baseLoading.brotliQuality, 6);
  assert.deepEqual(baseLoading.assets.map(file => file.path).sort(), [...Object.values(assetPaths), 'gcc-toolchain.v2.json'].sort(), 'Incomplete base loading measurements');
  for (const file of baseLoading.assets) {
    const actual = file.path === 'gcc-toolchain.v2.json' ? identity(manifestBytes) : contentAsset(Object.values(manifest.assets).find(asset => asset.path === file.path));
    assert.deepEqual(contentAsset(file), actual, 'Base loading measurement covers another asset');
    for (const field of ['gzipBytes', 'brotliBytes']) assert(Number.isSafeInteger(file[field]) && file[field] > 0, 'Invalid loading measurement');
  }
  for (const [total, field] of [['totalBytes', 'bytes'], ['totalGzipBytes', 'gzipBytes'], ['totalBrotliBytes', 'brotliBytes']])
    assert.equal(baseLoading[total], baseLoading.assets.reduce((sum, file) => sum + file[field], 0), 'Invalid base loading total');
  return { nativeBuild, compilerBuild, sourceLockBytes, baseLoading, provenanceFiles: proofs.size, sysrootFiles: allFiles.size };
}

export async function packageDebugger({ base, runtime, qualification, output }) {
  base = await fs.realpath(base);
  runtime = await fs.realpath(runtime);
  output = path.resolve(output);
  output = path.join(await fs.realpath(path.dirname(output)), path.basename(output));
  assert(!inside(base, output) && !inside(output, base) && !inside(runtime, output) && !inside(output, runtime), 'Output must be isolated from inputs');
  try { await fs.lstat(output); assert.fail('Output already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  qualification = await fs.realpath(qualification);
  const frozen = new Map();
  async function read(file) {
    file = path.resolve(file);
    const bytes = await fs.readFile(file);
    const proof = identity(bytes);
    if (frozen.has(file)) assert.deepEqual(proof, frozen.get(file), 'Input changed: ' + file);
    frozen.set(file, proof);
    return bytes;
  }
  const manifestBytes = await read(path.join(base, 'gcc-toolchain.v2.json'));
  const manifest = JSON.parse(manifestBytes);
  const baseSysroot = await read(path.join(base, 'sysroot.tar'));
  const baseFiles = new Map([...readTarEntries(baseSysroot).values()].filter(entry => !entry.directory)
    .map(entry => [entry.name, baseSysroot.subarray(entry.offset, entry.offset + entry.size)]));
  const { nativeBuild, compilerBuild, sourceLockBytes, baseLoading, provenanceFiles, sysrootFiles } = await verifyDebuggerBase({ manifest, manifestBytes, baseFiles,
    readBase: async name => {
      const filename = path.join(base, relativeFile(name));
      assert((await fs.lstat(filename)).isFile(), 'Base bundle must contain regular files only');
      return read(filename);
    },
    readRecipe: name => read(path.join(here, relativeFile(name)))
  });
  const proofs = {
    'debugger-build.json': await read(path.join(runtime, 'build.json')),
    'debugger-native-qualification.json': await read(qualification),
    'debugger-runtime.lock.json': await read(path.join(here, 'debugger-runtime.lock.json'))
  };
  const libraries = Object.fromEntries(await Promise.all(libraryNames.map(async name => [name, await read(path.join(runtime, 'sysroot/lib/wasm32-wasi', name))])));
  const admitted = await reopenDebuggerQualification({ runtime, qualification, nativeBuild, compilerBuild, baseFiles });
  assert.deepEqual(contentAsset(admitted.build), identity(proofs['debugger-build.json']), 'Runtime receipt changed during admission');
  assert.deepEqual(contentAsset(admitted.qualification), identity(proofs['debugger-native-qualification.json']), 'Native qualification changed during admission');
  for (const file of admitted.reopenedInputs) {
    const filename = path.resolve(file.path), expected = contentAsset(file);
    if (frozen.has(filename)) assert.deepEqual(expected, frozen.get(filename), 'Input changed during admission: ' + filename);
    frozen.set(filename, expected);
  }
  const extended = extendDebuggerSysroot(baseSysroot, libraries);
  proofs['debugger-sysroot-inventory.json'] = json(extended.inventory);
  const result = debuggerManifest(manifest, extended.bytes);
  const inherited = [];
  async function inventory(directory, prefix = '') {
    for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(prefix, item.name), filename = path.join(directory, item.name);
      assert(item.isFile() || item.isDirectory(), 'Base bundle must contain regular files only');
      if (item.isDirectory()) await inventory(filename, name);
      else { await read(filename); inherited.push({ path: name, ...frozen.get(filename) }); }
    }
  }
  await inventory(base);
  await fs.mkdir(output, { recursive: false, mode: 0o700 });
  const preserved = [];
  for (const file of inherited) {
    // Historical proofs, loading measurements and manifest remain a distinct base record.
    const relative = file.path.startsWith('provenance/') ? 'provenance/base/' + file.path.slice('provenance/'.length)
      : ['sysroot.tar', 'gcc-toolchain.v2.json', 'loading-sizes.json'].includes(file.path) ? 'provenance/base/' + file.path : file.path;
    const target = path.join(output, relative), source = path.join(base, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try { await fs.link(source, target); }
    catch (error) { if (error.code !== 'EXDEV') throw error; await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL); }
    preserved.push({ ...file, path: relative, source: file.path });
  }
  async function write(name, bytes) { await fs.writeFile(path.join(output, name), bytes, { flag: 'wx', mode: 0o600 }); }
  await write('sysroot.tar', extended.bytes);
  result.provenance.base.manifest = { path: 'provenance/base/gcc-toolchain.v2.json', ...identity(manifestBytes) };
  for (const [name, bytes] of Object.entries(proofs)) {
    await write('provenance/' + name, bytes);
    result.provenance.files[name] = { path: 'provenance/' + name, ...identity(bytes) };
  }
  await write('gcc-toolchain.v2.json', json(result));
  const initialAssets = baseLoading.assets.filter(asset => asset.path !== 'sysroot.tar' && asset.path !== 'gcc-toolchain.v2.json');
  for (const asset of initialAssets) assert.deepEqual(contentAsset(asset), frozen.get(path.join(base, asset.path)), 'Inherited loading measurement covers another asset');
  const measured = [['sysroot.tar', extended.bytes], ['gcc-toolchain.v2.json', json(result)]].map(([name, bytes]) => ({
    path: name, ...identity(bytes), gzipBytes: gzipSync(bytes, { level: 9 }).length,
    brotliBytes: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }).length
  }));
  const loading = [...initialAssets, ...measured];
  await write('loading-sizes.json', json({ scope: 'Inherited unchanged compiler asset measurements plus remeasured extended sysroot and manifest; actual SDK Worker requests recorded separately.',
    gzipLevel: 9, brotliQuality: 6, assets: loading, totalBytes: loading.reduce((sum, file) => sum + file.bytes, 0),
    totalGzipBytes: loading.reduce((sum, file) => sum + file.gzipBytes, 0), totalBrotliBytes: loading.reduce((sum, file) => sum + file.brotliBytes, 0) }));
  for (const file of preserved) assert.deepEqual(identity(await fs.readFile(path.join(output, file.path))), contentAsset(file), 'Preserved output changed: ' + file.path);
  for (const [file, expected] of frozen) assert.deepEqual(identity(await fs.readFile(file)), expected, 'Input changed during packaging: ' + file);
  const receipt = {
    kind: 'gcc-wasi-debugger-bundle-extension', status: 'packaged-unverified', inputsUnchanged: true,
    baseManifest: { path: path.join(base, 'gcc-toolchain.v2.json'), ...identity(manifestBytes) },
    manifest: { path: path.join(output, 'gcc-toolchain.v2.json'), ...identity(json(result)) },
    sourceLock: identity(sourceLockBytes), admitted, inherited: preserved, baseAdmission: { provenanceFiles, sysrootFiles },
    auxiliaryLibraries: Object.fromEntries(Object.entries(libraries).map(([name, bytes]) => [name, identity(bytes)])),
    changedBaseAssets: ['sysroot'], compilerAssetsUnchanged: true, baseGnuLibrariesUnchanged: true,
    qualificationPromoted: false,
    storage: 'Preserved payloads may share hardlinks with the immutable base bundle. Copy a file before modifying it; retain both trees while these links are in use.'
  };
  await write('provenance/debugger-package.json', json(receipt));
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index].replace(/^--/, '');
    assert(['base', 'runtime', 'qualification', 'output'].includes(key) && process.argv[index + 1] && !options[key], 'Usage: package-debugger.mjs --base BUNDLE --runtime DIR --qualification FILE --output NEW_DIR');
    options[key] = path.resolve(process.argv[index + 1]);
  }
  for (const name of ['base', 'runtime', 'qualification', 'output']) assert(options[name], 'Required --' + name);
  const result = await packageDebugger(options);
  console.log(JSON.stringify({ status: result.status, manifest: result.manifest }));
}
