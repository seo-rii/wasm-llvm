import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareHostSources } from '../host/prepare.mjs';
import { prepareFirStorageSources } from '../fir-storage/prepare.mjs';
import { loadRetainedBuild } from '../fir-navigation/probe.mjs';
import { prepareFirStorageSourceProfile, verifyFirStorageSourceProfile, verifyFinalFirStorageSourceProfile } from './prepare.mjs';
import { CONFIG, HOST, STORAGE, UTILS } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..'), execute = promisify(execFile);
assert.equal(process.argv.length, 3); const outputRoot = path.resolve(process.argv[2]);
assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep)); await mkdir(outputRoot, { mode: 0o700 });
const sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources'), lock = JSON.parse(await readRegular(path.join(here, 'sources.lock.json')));
const selected = await loadRetainedBuild(path.join(repository, 'out/kotlin-compiler-port/builds/contracts-arithmetic-ordered-whole-1791640840354600878'));
for (const name of ['host', 'storage']) await execute('git', ['init', '-q', path.join(outputRoot, name)]);
const preparedHost = await prepareHostSources({ sourceRoot, outputRoot: path.join(outputRoot, 'host') });
const preparedFirStorage = await prepareFirStorageSources({ sourceRoot, outputRoot: path.join(outputRoot, 'storage') });
const canonical = new Map([[HOST, preparedHost.commonSources.find(file => file.endsWith('/' + HOST))],
    [STORAGE, preparedFirStorage.commonSources.find(file => file.endsWith('/' + STORAGE))]]);
const retainedSources = [];
for (const item of selected.retainedSources.filter(item => !lock.entries.some(entry => item.path === entry.path))) {
    const filename = canonical.get(item.path) ?? item.filename, bytes = await readRegular(filename);
    retainedSources.push({ path: item.path, filename, bytes: bytes.length, sha256: sha256(bytes) });
}
const forwardSources = lock.entries.map(entry => ({ ...entry, filename: path.resolve(here, entry.repositoryPath) }));
const prepared = await prepareFirStorageSourceProfile({ sourceRoot, outputRoot: path.join(outputRoot, 'prepared'), preparedHost,
    preparedFirStorage, retainedSources, forwardSources });
const verified = await verifyFirStorageSourceProfile(prepared.outputRoot), bootstrap = await verifyBootstrap();
const flagsBytes = await readRegular(path.join(here, '../build-flags.json')), flags = JSON.parse(flagsBytes), commands = [], artifacts = [];
async function put(relative, bytes) { const filename = path.join(outputRoot, relative); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename; }
async function run(phase, args) {
    console.log('phase: ' + phase); const started = performance.now();
    try { const result = await execute('java', args, { cwd: outputRoot, timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
        commands.push({ phase, command: ['java', ...args], exitCode: 0, elapsedMs: performance.now() - started });
        if (result.stderr) process.stderr.write(result.stderr); return result.stdout;
    } catch (error) { await writeJson(path.join(outputRoot, 'failure.json'), { phase, code: error.code, commands, stderr: String(error.stderr ?? '').slice(-16384) });
        if (error.stderr) process.stderr.write(String(error.stderr).slice(-16384)); throw error; }
}
const compiler = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17',
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags, '-classpath', bootstrap.classPath];
const configuration = verifyFile(await readRegular(path.join(sourceRoot, CONFIG)), lock.sources.find(item => item.path === CONFIG));
const configurationFile = await put('original/Fir2IrConfiguration.kt', configuration);
const utils = verifyFile(await readRegular(path.join(sourceRoot, UTILS)), lock.sources.find(item => item.path === UTILS));
assert.equal(utils.toString().split(lock.psiGetter.text).length, 2);
const getterBytes = Buffer.from(utils.toString().split('package ')[0] + 'package org.jetbrains.kotlin.fir\n\n' +
    'import org.jetbrains.kotlin.*\nimport org.jetbrains.kotlin.com.intellij.psi.PsiElement\n\n' + lock.psiGetter.text + '\n');
const getterFile = await put('original/PsiGetter.kt', getterBytes), observer = await put('ActualJvmProbe.kt', await readRegular(path.join(here, 'ActualJvmProbe.kt')));
const raw = {};
for (const variant of ['bootstrap', 'source']) {
    const jar = path.join(outputRoot, variant + '.jar');
    await run(variant + '-genuine-configuration-light-source-jvm-build', [...compiler, '-d', jar, observer, ...(variant === 'source' ? [configurationFile, getterFile] : [])]);
    raw[variant] = await run(variant + '-genuine-configuration-light-source-jvm-observe', ['-ea', '-Xmx768m', '-cp', jar + path.delimiter + bootstrap.classPath,
        'org.jetbrains.kotlin.portable.storageprofile.probe.ActualJvmProbeKt']);
    await put(variant + '.txt', Buffer.from(raw[variant]));
}
assert.equal(raw.source, raw.bootstrap, 'Pinned source configuration/getter behavior differs from verified bootstrap objects');
const bytes = await readRegular(prepared.commonSources[0]);
const finalSources = selected.retainedSources.map(item => item.path === STORAGE
    ? { path: STORAGE, filename: prepared.commonSources[0], bytes: bytes.length, sha256: sha256(bytes) }
    : forwardSources.find(entry => entry.path === item.path) ?? item);
const whole = JSON.parse(await readRegular(selected.evidence.filename));
const final = await verifyFinalFirStorageSourceProfile({ profileRoot: prepared.outputRoot, retainedSources: finalSources,
    allowedAddedImports: ['kotlin.jvm.*', ...whole.propertyImports.imports, whole.assertionBindings.import] });
for (const relative of ['original/Fir2IrConfiguration.kt', 'original/PsiGetter.kt', 'ActualJvmProbe.kt', 'bootstrap.jar', 'source.jar', 'bootstrap.txt', 'source.txt']) {
    const bytes = await readRegular(path.join(outputRoot, relative)); artifacts.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
}
const receipt = { schemaVersion: 1, kind: 'official-fir-storage-lighttree-source-profile-bounded-proof', result: 'pass', source: lock.source,
    preparation: prepared.receipt, preparationReceiptSha256: verified.receiptSha256, selectedFailureGraph: selected.evidence,
    forwardSourceContract: 'Two exact repository entry files explicitly included during early preparation; both actual final selected entry bodies checked again',
    originalProjection: 'Complete pinned Fir2IrConfiguration; exact pure FirElement.psi getter, with relocated IntelliJ import only; remaining Utils.kt bodies not executed',
    genuineJvm: { observations: raw.source.trimEnd().split('\n').length, sourceSha256: sha256(Buffer.from(raw.source)), bootstrapSha256: sha256(Buffer.from(raw.bootstrap)),
        objects: 'Real CompilerConfiguration, Fir2IrConfiguration, KtLightSourceElement and FirImportImpl; carrier fixtures implement actual IntelliJ interfaces',
        behavior: 'Klib disallows non-cached declarations, ignores JVM skip-bodies flag, enables Klib serialization verification; real/fake/null LightTree source returns null from pure PSI getter' },
    final, commands, artifacts, flagsSha256: sha256(flagsBytes), observerPins: await Promise.all(['probe.mjs', 'ActualJvmProbe.kt'].map(async filename => {
        const bytes = await readRegular(path.join(here, filename)); return { path: filename, bytes: bytes.length, sha256: sha256(bytes) }; })),
    bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    normalizedText: false, wasmExecuted: false, fullFirStorageRuntime: false, fullCompilerBuilt: false, publicLanguageSupport: false };
await writeJson(path.join(outputRoot, 'differential.json'), receipt);
console.log(JSON.stringify({ result: 'pass', outputRoot, observations: receipt.genuineJvm.observations, selectedSources: final.guard.inspectedFiles }));
