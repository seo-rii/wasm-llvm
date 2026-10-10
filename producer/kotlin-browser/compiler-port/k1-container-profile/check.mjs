#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { ANALYZER, ANNOTATION, MARKER, CONFIGURATOR, CANDIDATES } from './transform.mjs';
import { prepareK1ContainerProfile, verifyK1ContainerProfile, verifyK1ContainerProfileComposition } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const execute = promisify(execFile);
export const FROZEN_BUILD = path.join(REPO, 'out/kotlin-compiler-port/builds/complete-hosts-1791630387399793081');

/** Bind actual selected bytes to the already exited full compiler invocation. */
export async function frozenInputs(buildRoot = FROZEN_BUILD) {
    const receiptBytes = await readRegular(path.join(buildRoot, 'compiler-build-receipt.json'), 32 * 1024 * 1024);
    const receipt = JSON.parse(receiptBytes); assert(receipt.status !== 'running');
    const invocation = receipt.commands.find(item => item.phase === 'official-compiler-source-to-wasmjs-klib');
    assert(invocation && Number.isInteger(invocation.exitCode), 'Only an exited compiler invocation is a frozen input');
    const argumentFilename = invocation.command.at(-1); assert(argumentFilename.startsWith('@'));
    const argumentsBytes = await readRegular(argumentFilename.slice(1)); assert.equal(sha256(argumentsBytes), invocation.argumentFileSha256);
    const actual = argumentsBytes.toString().trim().split('\n').map(line => JSON.parse(line)).filter(value => value.startsWith('/') && value.endsWith('.kt'));
    assert.equal(actual.length, receipt.compileSources.length);
    const retainedSources = receipt.compileSources.map((pin, index) => {
        assert(actual[index].endsWith('/' + pin.path), 'Compiler argument/source receipt order differs');
        return { ...pin, filename: actual[index] };
    });
    return { retainedSources, binding: { compilerBuildReceiptSha256: sha256(receiptBytes), argumentFileSha256: sha256(argumentsBytes),
        compilerExitCode: invocation.exitCode, inspectedCompilerInputs: actual.length, sourceInventorySha256: sha256(Buffer.from(JSON.stringify(receipt.compileSources))) } };
}

export async function checkK1Profile({ sourceRoot, outputRoot, frozenBuild = FROZEN_BUILD }) {
    outputRoot = path.resolve(outputRoot); assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    await assertNoSymlink(outputRoot); await mkdir(outputRoot, { mode: 0o700 });
    const frozen = await frozenInputs(frozenBuild);
    const prepared = await prepareK1ContainerProfile({ sourceRoot, outputRoot: path.join(outputRoot, 'profile'), retainedSources: frozen.retainedSources });
    await verifyK1ContainerProfile(path.join(outputRoot, 'profile'));
    const selected = frozen.retainedSources.filter(pin => !CANDIDATES.includes(pin.path)).map(pin => {
        const replacement = prepared.receipt.files.find(item => item.path === pin.path);
        return replacement ? { ...replacement, filename: prepared.commonSources.find(name => name.endsWith('/' + pin.path)) } : pin;
    });
    const final = await verifyK1ContainerProfileComposition({ profileRoot: path.join(outputRoot, 'profile'), retainedSources: selected });
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const bootstrap = await verifyBootstrap(), commands = [], outputs = [], observers = [];
    const java = ['-Xmx768m', '-cp', bootstrap.classPath];
    const stdlib = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path;
    const jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', '2.5', '-api-version', '2.5'];
    async function run(phase, command, args) {
        console.log('phase: ' + phase); const result = await execute(command, args, { cwd: outputRoot, timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
        if (result.stderr) process.stderr.write(result.stderr); commands.push({ phase, command: [command, ...args], exitCode: 0 }); return result.stdout;
    }
    const sources = { original: [], common: [] }, apiSources = { original: [], common: [] };
    for (const name of ['original', 'common', 'jvm', 'klib', 'wasm']) await mkdir(path.join(outputRoot, name));
    async function store(variant, name, bytes) {
        const filename = path.join(outputRoot, variant, name); await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); outputs.push({ path: variant + '/' + name, bytes: bytes.length, sha256: sha256(bytes) }); return filename;
    }
    for (const variant of ['original', 'common']) {
        for (const name of [MARKER, ANNOTATION, ANALYZER]) {
            // Standalone files use canonical bytes: global root property imports are irrelevant here.
            const pin = lock.originals.find(pin => pin.path === name);
            const original = await readRegular(path.join(sourceRoot, name));
            assert.equal(sha256(original), pin.original.sha256);
            const { splitK1Declaration } = await import('./transform.mjs');
            const bytes = variant === 'common' ? splitK1Declaration(name, original).common : original;
            const filename = await store(variant, name, bytes); apiSources[variant].push(filename);
            if (name !== ANALYZER) sources[variant].push(filename);
        }
        for (const pin of [...lock.retainedContracts, ...lock.probeSources]) {
            const bytes = await readRegular(path.join(sourceRoot, pin.path)); assert.equal(sha256(bytes), pin.sha256);
            apiSources[variant].push(await store(variant, pin.path, bytes));
        }
        if (variant === 'original') apiSources.original.push(await store(variant, CONFIGURATOR, await readRegular(path.join(sourceRoot, CONFIGURATOR))));
    }
    for (const name of ['Probe.kt', 'JvmEntry.kt', 'WasmEntry.kt', 'JvmApiProbe.kt']) {
        const bytes = await readRegular(path.join(HERE, name));
        await writeFile(path.join(outputRoot, name), bytes, { flag: 'wx', mode: 0o600 }); observers.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const probe = path.join(outputRoot, 'Probe.kt'), jvmEntry = path.join(outputRoot, 'JvmEntry.kt');
    for (const variant of ['original', 'common']) {
        const args = ['-classpath', stdlib, '-d', path.join(outputRoot, 'jvm/' + variant + '.jar'), ...sources[variant], probe, jvmEntry];
        if (variant === 'common') { const common = [...sources.common, probe]; args.unshift('-Xmulti-platform', '-Xcommon-sources=' + common.join(',')); }
        await run(variant + '-runtime-jvm-build', 'java', [...jvm, ...args]);
        await run(variant + '-actual-analyzer-module-api-jvm-build', 'java', [...jvm, '-opt-in=org.jetbrains.kotlin.K1Deprecation',
            '-classpath', bootstrap.classPath, '-d', path.join(outputRoot, 'jvm/' + variant + '-api.jar'), ...apiSources[variant], path.join(outputRoot, 'JvmApiProbe.kt')]);
    }
    const main = 'org.jetbrains.kotlin.portable.k1profile.probe.JvmEntryKt';
    const original = await run('original-jvm-observe', 'java', ['-cp', [path.join(outputRoot, 'jvm/original.jar'), stdlib].join(path.delimiter), main]);
    const commonJvm = await run('common-jvm-observe', 'java', ['-cp', [path.join(outputRoot, 'jvm/common.jar'), stdlib].join(path.delimiter), main]);
    assert.equal(commonJvm, original, 'Original/common JVM raw runtime output differs');
    const apiMain = 'org.jetbrains.kotlin.portable.k1profile.probe.JvmApiProbeKt';
    const originalApi = await run('original-actual-api-jvm-observe', 'java', ['-cp', [path.join(outputRoot, 'jvm/original-api.jar'), bootstrap.classPath].join(path.delimiter), apiMain]);
    const retainedApi = await run('retained-actual-api-jvm-observe', 'java', ['-cp', [path.join(outputRoot, 'jvm/common-api.jar'), bootstrap.classPath].join(path.delimiter), apiMain]);
    assert.equal(retainedApi, originalApi, 'Retained original JVM API output differs');
    const common = [...sources.common, probe];
    const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-libraries', bootstrap.wasmJsStdlib, '-language-version', '2.5', '-api-version', '2.5'];
    await run('common-runtime-wasm-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-ir-output-dir', path.join(outputRoot, 'klib'), '-ir-output-name', 'k1-profile', ...common, path.join(outputRoot, 'WasmEntry.kt')]);
    await run('common-runtime-wasm-module-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/k1-profile.klib'), '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'k1-profile', '-main', 'noCall']);
    const commonWasm = await run('common-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
        'const m=await import(process.argv[1]);process.stdout.write(m.retainedK1Observation());', pathToFileURL(path.join(outputRoot, 'wasm/k1-profile.mjs')).href]);
    assert.equal(commonWasm, original, 'Original/Node Wasm raw runtime output differs');
    for (const [name, text] of [['original.txt', original], ['common-jvm.txt', commonJvm], ['common-wasm.txt', commonWasm], ['original-api.txt', originalApi], ['retained-api.txt', retainedApi]]) {
        await writeFile(path.join(outputRoot, name), text, { flag: 'wx', mode: 0o600 }); outputs.push({ path: name, bytes: Buffer.byteLength(text), sha256: sha256(Buffer.from(text)) });
    }
    for (const name of ['jvm/original.jar', 'jvm/common.jar', 'jvm/original-api.jar', 'jvm/common-api.jar', 'klib/k1-profile.klib',
        ...(await readdir(path.join(outputRoot, 'wasm'))).map(name => 'wasm/' + name)]) {
        const bytes = await readRegular(path.join(outputRoot, name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const receipt = { schemaVersion: 1, kind: 'k1-profile-source-guards-and-retained-contract-differential', source: lock.source,
        sourceLockSha256: sha256(lockBytes), buildToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), frozenCompilerInputs: frozen.binding,
        preparation: prepared.receipt, finalComposition: final.receipt, observers, commands, outputs,
        bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
        comparison: { observations: original.trimEnd().split('\n').length, originalJvmEqualsCommonJvm: true, originalJvmEqualsNodeWasm: true,
            originalJvmApiEqualsRetainedJvmApi: true, jvmApiObservations: originalApi.trimEnd().split('\n').length, normalizedText: false },
        scope: 'Actual marker/annotation sources execute on JVM/common JVM/Node Wasm. Actual AnalyzerServices, ModuleInfo, DefaultImportsProvider, K1Deprecation sources JVM-typecheck against verified bootstrap dependencies; no DI instance, stub or full common analyzer dependency closure is claimed.',
        browserExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
    await writeJson(path.join(outputRoot, 'receipt.json'), receipt); return { outputRoot, receipt, prepared };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { assert([3, 4].includes(process.argv.length), 'Usage: check.mjs NEW_OUTPUT_ROOT [EXITED_COMPILER_BUILD_ROOT]');
        const result = await checkK1Profile({ sourceRoot: path.join(REPO, 'out/kotlin-compiler-port/sources'), outputRoot: process.argv[2], frozenBuild: process.argv[3] });
        console.log(JSON.stringify({ outputRoot: result.outputRoot, comparison: result.receipt.comparison }));
    } catch (error) { console.error(error); process.exitCode = 1; }
}
