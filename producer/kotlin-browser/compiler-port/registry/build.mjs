#!/usr/bin/env node
/** Actual TypeRegistry/ArrayMap JVM and Wasm comparison; this does not build compiler C. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, verifyFile } from '../../scripts/source.mjs';
import { prepareRegistrySources } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);
const options = {};
const args = process.argv.slice(2);
while (args.length) {
    const key = args.shift();
    assert(['--output', '--source-root', '--bootstrap-cache'].includes(key) && args[0] && !options[key], 'Invalid registry build option');
    options[key] = path.resolve(args.shift());
}
const output = options['--output'] ?? path.join(repository, 'out/kotlin-compiler-registry-probe');
const sourceRoot = options['--source-root'] ?? path.join(repository, 'out/kotlin-compiler-port/sources');
assert(output.startsWith(path.join(repository, 'out') + path.sep), 'Registry output must stay under repository out/');
await assertNoSymlink(output);
const bootstrap = await verifyBootstrap(options['--bootstrap-cache'] ?? defaultCache);
assert.equal(bootstrap.lock.selectedSourceCommit, '4d78aae1e337cd40f69baa865aed950fe807a775');
await mkdir(output, { recursive: false });
const prepared = await prepareRegistrySources({ sourceRoot, outputRoot: output });
const recipe = prepared.receipt;
const local = (name) => path.join(here, name);
const flagsBytes = await readRegular(path.join(here, '../build-flags.json'));
const flags = JSON.parse(flagsBytes);
assert.equal(flags.source.commit, recipe.source.commit);
assert(Array.isArray(flags.compilerFlags) && flags.compilerFlags.every((item) => typeof item === 'string'));
const sourceFlags = flags.compilerFlags;
const originals = path.join(output, 'original');
const originalFiles = [];
for (const pin of recipe.originals) {
    const destination = path.join(originals, pin.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, verifyFile(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), pin), { flag: 'wx', mode: 0o600 });
    originalFiles.push(destination);
}
for (const name of ['jvm', 'klib', 'wasm', 'missing-flag-klib', 'missing-flag-wasm']) await mkdir(path.join(output, name));
const commands = [];
async function command(phase, argv, { capture = false, allowFailure = false } = {}) {
    const start = performance.now();
    let stdout = '';
    let stderr = '';
    let exitCode;
    if (capture || allowFailure) {
        try {
            const result = await execute(argv[0], argv.slice(1), { timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
            stdout = result.stdout; stderr = result.stderr; exitCode = 0;
        } catch (error) {
            if (!allowFailure || !Number.isInteger(error.code)) throw error;
            stdout = error.stdout ?? ''; stderr = error.stderr ?? ''; exitCode = error.code;
        }
        if (!allowFailure && stderr) process.stderr.write(stderr);
    } else {
        exitCode = await new Promise((resolve, reject) => {
            const child = spawn(argv[0], argv.slice(1), { cwd: repository, stdio: ['ignore', 'inherit', 'inherit'] });
            const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
            child.once('error', (error) => { clearTimeout(timer); reject(error); });
            child.once('exit', (code, signal) => { clearTimeout(timer); signal ? reject(new Error(phase + ' terminated by ' + signal)) : resolve(code); });
        });
    }
    commands.push({ phase, argv, exitCode, allowFailure, elapsedMs: performance.now() - start });
    if (!allowFailure) assert.equal(exitCode, 0, phase + ' failed');
    return { stdout, stderr, exitCode };
}
const stdlibJvm = bootstrap.artifacts.find((item) => item.id === 'stdlib-jvm').path;
const compiler = ['java', '-Xmx768m', '-cp', bootstrap.classPath];
const jvm = [...compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', '2.5', '-api-version', '2.5', ...sourceFlags];
const wasm = [...compiler, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-language-version', '2.5', '-api-version', '2.5', '-libraries', bootstrap.wasmJsStdlib, ...sourceFlags];
const probe = local('RegistryProbe.kt');
const jvmEntry = local('RegistryJvmEntry.kt');
const originalSubset = originalFiles.filter((file) => !file.endsWith('/TypeAttributes.kt'));
const originalJar = path.join(output, 'jvm/original.jar');
await command('official-registry-jvm-build', [...jvm, '-classpath', stdlibJvm, '-d', originalJar, ...originalSubset, probe, local('OriginalProbePolicy.kt'), jvmEntry]);
const originalUnmodified = originalFiles.filter((file) => file.endsWith('/ArrayMap.kt') || file.endsWith('/ComponentArrayOwner.kt'));
const common = [...prepared.commonSources.filter((file) => !file.endsWith('/TypeAttributes.kt')), ...originalUnmodified, probe, local('PortableProbePolicy.kt')];
const portableJar = path.join(output, 'jvm/portable.jar');
await command('portable-registry-jvm-build', [...jvm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-classpath', stdlibJvm, '-d', portableJar, ...common, jvmEntry]);
const main = 'org.jetbrains.kotlin.portable.registryprobe.RegistryJvmEntryKt';
const original = JSON.parse((await command('official-registry-jvm-observe', ['java', '-ea', '-cp', [originalJar, stdlibJvm].join(path.delimiter), main], { capture: true })).stdout.trim());
const portable = JSON.parse((await command('portable-registry-jvm-observe', ['java', '-ea', '-cp', [portableJar, stdlibJvm].join(path.delimiter), main], { capture: true })).stdout.trim());
assert.deepEqual(portable, original, 'Portable JVM registry differs from the actual official sources');
const klibArgs = ['-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-Xir-produce-klib-file', '-ir-output-name', 'registry-probe', ...common, local('RegistryWasmEntry.kt')];
const missingSource = await command('qualified-name-source-without-profile-flag', [...wasm, ...klibArgs, '-ir-output-dir', path.join(output, 'missing-flag-klib')], { allowFailure: true });
const omittedFlag = { sourceCompileExit: missingSource.exitCode, binaryLinkExit: null, runtimeExit: null, comparison: 'not-run' };
let omittedDiagnostic = missingSource.stdout + missingSource.stderr;
if (missingSource.exitCode === 0) {
    const missingLink = await command('qualified-name-link-without-profile-flag', [...wasm,
        '-Xir-produce-js', '-Xinclude=' + path.join(output, 'missing-flag-klib/registry-probe.klib'),
        '-ir-output-dir', path.join(output, 'missing-flag-wasm'), '-ir-output-name', 'registry-probe', '-main', 'noCall',
        '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts'], { allowFailure: true });
    omittedFlag.binaryLinkExit = missingLink.exitCode;
    omittedDiagnostic += missingLink.stdout + missingLink.stderr;
    if (missingLink.exitCode === 0) {
        const missingRun = await command('qualified-name-runtime-without-profile-flag', [process.execPath, '--experimental-wasm-exnref', '--input-type=module', '-e',
            'const module = await import(process.argv[1]); console.log(module.registryProbeJson());',
            pathToFileURL(path.join(output, 'missing-flag-wasm/registry-probe.mjs')).href], { allowFailure: true });
        omittedFlag.runtimeExit = missingRun.exitCode;
        omittedDiagnostic += missingRun.stdout + missingRun.stderr;
        if (missingRun.exitCode === 0) {
            const missingObserved = JSON.parse(missingRun.stdout.trim());
            omittedFlag.comparison = JSON.stringify(missingObserved) === JSON.stringify(original) ? 'equal' : 'different';
        }
    }
}
await writeFile(path.join(output, 'missing-flag-diagnostic.txt'), omittedDiagnostic, { flag: 'wx', mode: 0o600 });
await command('portable-registry-wasmjs-klib-build', [...wasm, ...prepared.requiredFlags, ...klibArgs, '-ir-output-dir', path.join(output, 'klib')]);
const binaryArgs = ['-Xir-produce-js', '-Xinclude=' + path.join(output, 'klib/registry-probe.klib'), '-ir-output-name', 'registry-probe', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts'];
await command('portable-registry-wasmjs-binary-build', [...wasm, ...prepared.requiredFlags, ...binaryArgs, '-ir-output-dir', path.join(output, 'wasm')]);
const observedWasm = JSON.parse((await command('portable-registry-wasmjs-observe', [process.execPath, '--experimental-wasm-exnref', '--input-type=module', '-e',
    'const module = await import(process.argv[1]); console.log(module.registryProbeJson());', pathToFileURL(path.join(output, 'wasm/registry-probe.mjs')).href], { capture: true })).stdout.trim());
assert.deepEqual(observedWasm, original, 'Portable Wasm registry differs from the actual official sources');
for (const [name, value] of [['original-jvm.json', original], ['portable-jvm.json', portable], ['portable-wasmjs.json', observedWasm]]) {
    await writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
const outputs = [];
for (const name of ['jvm/original.jar', 'jvm/portable.jar', 'klib/registry-probe.klib', 'missing-flag-diagnostic.txt', 'original-jvm.json', 'portable-jvm.json', 'portable-wasmjs.json',
    ...(await readdir(path.join(output, 'wasm'))).sort().map((name) => 'wasm/' + name)]) {
    const bytes = await readRegular(path.join(output, name));
    outputs.push({ path: name, bytes: bytes.byteLength, sha256: sha256(bytes) });
}
const observerSources = [];
for (const name of ['RegistryProbe.kt', 'RegistryJvmEntry.kt', 'RegistryWasmEntry.kt', 'OriginalProbePolicy.kt', 'PortableProbePolicy.kt']) {
    const bytes = await readRegular(local(name));
    observerSources.push({ path: name, bytes: bytes.byteLength, sha256: sha256(bytes) });
}
const receipt = { schemaVersion: 1, kind: 'official-compiler-type-registry-differential', status: 'passed', source: recipe.source,
    originals: recipe.originals, portable: recipe.portable, transformations: recipe.transformations,
    sourceBuildFlagsSha256: sha256(flagsBytes), requiredFlags: prepared.requiredFlags, flagProvenance: recipe.flagProvenance, omittedFlag,
    recipeSha256: recipe.recipeSha256, observerSources,
    buildScriptSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), prepareScriptSha256: sha256(await readRegular(local('prepare.mjs'))),
    bootstrapVersion: bootstrap.lock.version, bootstrapCompilerSourceCommit: bootstrap.lock.compilerSourceCommit,
    bootstrapArtifacts: bootstrap.artifacts.map(({ path: ignored, ...item }) => item), commands, outputs,
    comparison: { required: original.cases.length, passed: original.cases.length, failed: 0, skipped: 0, notRun: 0,
        originalJvmEqualsPortableJvm: true, originalJvmEqualsPortableWasm: true, observationsPerCasePerHost: 2 },
    wasmEngine: { kind: 'Node', version: process.version, flags: ['--experimental-wasm-exnref'] }, browserComparison: 'not-run',
    limitations: ['Compares the actual TypeRegistry, ArrayMap and owner algorithms, not the full compiler.',
        'TypeAttributes transformation is verified whole-file; its legacy callback policy is instrumented in the observer, while descriptor attribute semantics are not exercised here.',
        'Maps are for the selected single-Worker registry operations, not a general ConcurrentHashMap substitute or a concurrency guarantee.',
        'Named classes use official RTTI names with -Xwasm-kclass-fqn; anonymous/local keys retain the original null-name failure.',
        'The omitted-flag experiment records actual bootstrap source/link/runtime outcomes and does not infer rejection from upstream documentation.',
        'Registry IDs have one owning registry lifetime; no numeric reset or cross-build/session serialization contract is introduced.',
        'Render-map ordering and JVM class diagnostic rendering are host-specific.'],
    browserCompiler: 'not-built', languageReadiness: false };
await writeFile(path.join(output, 'registry-evidence.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, status: receipt.status, comparison: receipt.comparison, requiredFlags: receipt.requiredFlags, omittedFlag }));
