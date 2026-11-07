import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after } from 'node:test';
import { sha256 } from '../../scripts/source.mjs';
import { prepareHostSources } from '../host/prepare.mjs';
import { prepareFirStorageSources } from '../fir-storage/prepare.mjs';
import { assembleImports } from '../type-substitutor-getter/prepare.mjs';
import { guardStorageSelection, prepareFirStorageSourceProfile, verifyFirStorageSourceProfile, verifyFinalFirStorageSourceProfile } from './prepare.mjs';
import { CONFIG, ELEMENT, HOST, STORAGE, UTILS, profileStorage } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..'), execute = promisify(execFile);
const sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources'), lock = JSON.parse(await readFile(path.join(here, 'sources.lock.json')));
const root = await mkdtemp(path.join(repository, 'out/kotlin-storage-profile-guard-'));
after(async () => rm(root, { recursive: true, force: true }));
for (const directory of ['storage', 'host']) await execute('git', ['init', '-q', path.join(root, directory)]);
const preparedFirStorage = await prepareFirStorageSources({ sourceRoot, outputRoot: path.join(root, 'storage') });
const preparedHost = await prepareHostSources({ sourceRoot, outputRoot: path.join(root, 'host') });
const originals = new Map(await Promise.all(lock.sources.map(async pin => [pin.path, await readFile(path.join(sourceRoot, pin.path))])));
for (const entry of lock.entries) originals.set(entry.path, await readFile(path.join(here, entry.repositoryPath)));
const storage = await readFile(preparedFirStorage.commonSources.find(file => file.endsWith('/' + STORAGE)));
const host = await readFile(preparedHost.commonSources.find(file => file.endsWith('/' + HOST)));
const jvmRoot = path.resolve(here, '../jvm-descriptor-signature-implementations');
const jvmLockBytes = await readFile(path.join(jvmRoot, 'sources.lock.json')), jvmLock = JSON.parse(jvmLockBytes);
const jvmSources = new Map(await Promise.all(jvmLock.common.map(async pin => [
    'compiler-port-jvm-descriptor-signatures/' + pin.path, await readFile(path.join(jvmRoot, 'common', pin.path))])));
const portableJvmClassNames = { sourceLockSha256: sha256(jvmLockBytes), assemblyImports: jvmLock.assemblyImports,
    ownerRoot: path.join(root, 'jvmDescriptorSignatureImplementationsReceipt'),
    sources: new Map([...jvmSources].filter(([, bytes]) => /\bJvmClassName\b/.test(bytes.toString()))) };
const input = { lock, originals, portableJvmClassNames, predecessors: { storage: { bytes: storage }, host: { bytes: host } } };
const item = (logical, bytes) => ({ path: logical, bytes: bytes.length, sha256: sha256(bytes), source: bytes.toString('base64'),
    ...(jvmSources.has(logical) ? { filename: path.join(portableJvmClassNames.ownerRoot, logical) } : {}) });
const canonical = new Map(originals); canonical.set(STORAGE, storage); canonical.set(HOST, host);
const snapshot = () => [...canonical].map(([logical, bytes]) => item(logical, bytes));
const selectedPins = () => [STORAGE, CONFIG, UTILS, HOST, ELEMENT].map(logical => {
    const filename = logical === STORAGE ? path.join(preparedFirStorage.outputRoot, logical) : logical === HOST ? path.join(preparedHost.outputRoot, logical) : path.join(sourceRoot, logical);
    const bytes = canonical.get(logical); return { path: logical, filename, bytes: bytes.length, sha256: sha256(bytes) };
});
const forwardSources = lock.entries.map(entry => ({ ...entry, filename: path.resolve(here, entry.repositoryPath) }));
const options = outputRoot => ({ sourceRoot, outputRoot, preparedFirStorage, preparedHost, retainedSources: selectedPins(), forwardSources });

test('only six exact private PSI spans are removed, preserving all serial cache predecessor bytes', () => {
    const result = profileStorage(storage, lock); let restored = result.bytes.toString();
    for (let index = result.exclusions.length - 1; index >= 0; index--) {
        const span = result.exclusions[index], before = Buffer.from(restored);
        restored = Buffer.concat([before.subarray(0, span.offset), Buffer.from(lock.exclusions[index].text), before.subarray(span.offset)]).toString();
    }
    assert.equal(restored, storage.toString()); assert.equal(result.exclusions.length, 6);
    assert(result.bytes.includes(Buffer.from('val existingFile = fileCache[containerFile]')));
    assert(result.bytes.includes(Buffer.from('return existingFile'))); assert(result.bytes.includes(Buffer.from('return parentPackage')));
    assert.throws(() => profileStorage(Buffer.from(storage.toString().replace('return existingFile', 'return parentPackage')), lock), /predecessor/);
});

test('entry, pure psi getter, sealed host family and configuration are required and unchanged', () => {
    assert.equal(guardStorageSelection(snapshot(), input).configurationCalls.length, 1);
    for (const logical of [CONFIG, UTILS, HOST, ELEMENT, lock.entries[0].path, lock.entries[1].path]) {
        assert.throws(() => guardStorageSelection(snapshot().filter(pin => pin.path !== logical), input), /closure required/);
    }
    for (const [logical, before, after] of [[CONFIG, 'allowNonCachedDeclarations = false', 'allowNonCachedDeclarations = true'],
        [UTILS, lock.psiGetter.text, lock.psiGetter.text.replace('?.psi', '!!.psi')], [HOST, 'sealed class KtSourceElement', 'open class KtSourceElement'],
        [STORAGE, 'return existingFile', 'return parentPackage']]) {
        assert.throws(() => guardStorageSelection(snapshot().map(pin => pin.path === logical ? item(logical, Buffer.from(canonical.get(logical).toString().replace(before, after))) : pin), input), /algorithm changed/);
    }
});

test('new PSI source implementations, source aliases, Analysis API callers and facade consumers fail closed', () => {
    for (const text of ['class KtPsiSourceElement {}', 'class Other : KtSourceElement() {}', 'import org.jetbrains.kotlin.KtSourceElement as Alias\n',
        'val config = Fir2IrConfiguration.forAnalysisApi(c, l, d)', 'val config = Fir2IrConfiguration(c)', 'val facade = JvmClassName.byFqNameWithoutInnerClasses(n)']) {
        assert.throws(() => guardStorageSelection([...snapshot(), item('other/Caller.kt', Buffer.from(text))], input));
    }
});

test('the real pinned JVM signature sources coexist with the excluded private FIR facade island', () => {
    const current = [...snapshot(), ...[...jvmSources].map(([logical, bytes]) => item(logical, bytes))];
    const guarded = guardStorageSelection(current, input);
    assert.equal(guarded.portableJvmClassNameSources.length, 6);
    assert.deepEqual(guarded.facadeIslandConsumers, [STORAGE]);
    const final = current.map(row => row.path === STORAGE ? item(STORAGE, profileStorage(storage, lock).bytes)
        : jvmSources.has(row.path) ? item(row.path, assembleImports(jvmSources.get(row.path), jvmLock.assemblyImports)) : row);
    assert.equal(guardStorageSelection(final, input, { final: true }).facadeIslandConsumers.length, 0);
    const classPath = 'compiler-port-jvm-descriptor-signatures/JvmClassName.kt';
    assert.throws(() => guardStorageSelection(current.map(row => row.path === classPath
        ? { ...row, filename: path.join(root, 'wrong-owner', classPath) } : row), input), /Wrong portable JVM class-name source owner/);
    assert.throws(() => guardStorageSelection(current.map(row => row.path === classPath
        ? { ...row, path: 'other/JvmClassName.kt' } : row), input), /Excluded facade island consumer/);
    assert.throws(() => guardStorageSelection(current.filter(row => row.path !== classPath), input), /Incomplete portable JVM class-name closure/);
    assert.throws(() => guardStorageSelection(current.map(row => row.path === classPath
        ? item(classPath, Buffer.from(jvmSources.get(classPath).toString().replace('return internalName', 'return "changed"'))) : row), input), /Portable JVM class-name source changed/);
    for (const text of ['class JvmClassName {}', 'val x = JvmFileClassUtil.getFileClassInfoNoResolve(file)',
        'class Other : FacadeClassSource', 'val x = NonCachedSourceFacadeContainerSource(file)'])
        assert.throws(() => guardStorageSelection([...current, item('other/Facade.kt', Buffer.from(text))], input));
    const unknownImport = Buffer.from(jvmSources.get(classPath).toString().replace('package org.jetbrains.kotlin.resolve.jvm',
        'package org.jetbrains.kotlin.resolve.jvm\nimport unknown.JvmClassName as Other'));
    assert.throws(() => guardStorageSelection(current.map(row => row.path === classPath ? item(classPath, unknownImport) : row), input), /Portable JVM class-name source changed/);
});

test('genuine preparation and reference replay verify the exact storage and host predecessor contracts', async () => {
    const prepared = await prepareFirStorageSourceProfile(options(path.join(root, 'prepared')));
    await verifyFirStorageSourceProfile(prepared.outputRoot);
    assert.equal(prepared.predecessorBindings.length, 1); assert.equal(prepared.predecessorBindings[0].component, 'firStorageReceipt');
    const filename = prepared.commonSources[0], bytes = await readFile(filename);
    await writeFile(filename, Buffer.concat([bytes, Buffer.from('\n// mutation')])); await assert.rejects(verifyFirStorageSourceProfile(prepared.outputRoot));
    await writeFile(filename, bytes);
    const reference = path.join(prepared.outputRoot, 'reference', CONFIG), config = await readFile(reference);
    await writeFile(reference, Buffer.from(config.toString().replace('allowNonCachedDeclarations = false', 'allowNonCachedDeclarations = true')));
    await assert.rejects(verifyFirStorageSourceProfile(prepared.outputRoot));
});

test('final guard independently replays canonical output despite in-place declared assembly imports', async () => {
    const prepared = await prepareFirStorageSourceProfile(options(path.join(root, 'final'))), filename = prepared.commonSources[0];
    const bytes = await readFile(filename), assembled = Buffer.from(bytes.toString().replace('package org.jetbrains.kotlin.fir.backend\n', 'package org.jetbrains.kotlin.fir.backend\n\nimport kotlin.jvm.*\n'));
    await writeFile(filename, assembled); const selected = [...selectedPins(), ...forwardSources].map(pin => pin.path === STORAGE ? { path: STORAGE, filename, bytes: assembled.length, sha256: sha256(assembled) } : pin);
    await assert.rejects(verifyFirStorageSourceProfile(prepared.outputRoot));
    await assert.rejects(verifyFinalFirStorageSourceProfile({ profileRoot: prepared.outputRoot, retainedSources: selected }), /Unknown final import/);
    const finalOptions = { profileRoot: prepared.outputRoot, retainedSources: selected, allowedAddedImports: ['kotlin.jvm.*'] };
    assert.equal((await verifyFinalFirStorageSourceProfile(finalOptions)).guard.facadeIslandConsumers.length, 0);
    const changed = Buffer.from(assembled.toString().replace('return existingFile', 'return parentPackage')); await writeFile(filename, changed);
    await assert.rejects(verifyFinalFirStorageSourceProfile({ ...finalOptions, retainedSources: selected.map(pin => pin.path === STORAGE ? { ...pin, bytes: changed.length, sha256: sha256(changed) } : pin) }), /algorithm changed/);
});

test('forged predecessor receipt pins, duplicate outputs, forward entry drift and overlap are rejected', async () => {
    const altered = structuredClone(preparedHost.receipt); altered.sources.find(pin => pin.path === HOST).sha256 = sha256(Buffer.from('changed'));
    const receiptPath = path.join(root, 'bad-host.json'); await writeFile(receiptPath, JSON.stringify(altered));
    await assert.rejects(prepareFirStorageSourceProfile({ ...options(path.join(root, 'bad')), preparedHost: { ...preparedHost, receipt: altered, receiptPath } }));
    await assert.rejects(prepareFirStorageSourceProfile({ ...options(path.join(root, 'duplicate')), preparedFirStorage: {
        ...preparedFirStorage, commonSources: [...preparedFirStorage.commonSources, ...preparedFirStorage.commonSources] } }));
    await assert.rejects(prepareFirStorageSourceProfile({ ...options(path.join(root, 'wrong-entry')), forwardSources: forwardSources.map((pin, index) => index === 0 ? { ...pin, sha256: sha256(Buffer.from('changed')) } : pin) }));
    await assert.rejects(prepareFirStorageSourceProfile(options(preparedFirStorage.outputRoot)), /overlap/);
});
