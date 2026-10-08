#!/usr/bin/env node
/** Compares real storage state machines; this does not build the browser compiler. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256 } from '../../scripts/source.mjs';
import { prepareStorageSources } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);
const options = {};
const args = process.argv.slice(2);
while (args.length) {
    const key = args.shift();
    assert(['--output', '--source-root', '--bootstrap-cache'].includes(key) && args[0] && !options[key], 'Invalid storage build option');
    options[key] = path.resolve(args.shift());
}
const output = options['--output'] ?? path.join(repository, 'out/kotlin-compiler-storage-probe');
assert(output.startsWith(path.join(repository, 'out') + path.sep), 'storage probe output must stay under repository out/');
await assertNoSymlink(output);
const bootstrap = await verifyBootstrap(options['--bootstrap-cache'] ?? defaultCache);
assert.equal(bootstrap.lock.selectedSourceCommit, '4d78aae1e337cd40f69baa865aed950fe807a775');
await mkdir(output, { recursive: false });
const prepared = await prepareStorageSources({ sourceRoot: options['--source-root'] ?? path.join(repository, 'out/kotlin-compiler-port/sources'), outputRoot: output });
const recipe = prepared.receipt;
const recipeDefinition = JSON.parse((await readRegular(localRecipePath())).toString('utf8'));
function localRecipePath() { return path.join(here, 'storage.recipe.json'); }
const local = (name) => path.join(here, name);
const originals = path.join(output, 'original');
const referenceClasses = path.join(originals, 'classes');
await mkdir(referenceClasses, { recursive: true });
const originalFiles = [];
for (const pin of recipe.originals) {
    const destination = path.join(originals, pin.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readRegular(path.join(options['--source-root'] ?? path.join(repository, 'out/kotlin-compiler-port/sources'), pin.path), pin.bytes), { flag: 'wx', mode: 0o600 });
    originalFiles.push(destination);
}
for (const name of ['jvm', 'klib', 'wasm']) await mkdir(path.join(output, name));
const commands = [];
async function command(phase, argv, capture = false) {
    const start = performance.now();
    let stdout = '';
    let exitCode;
    if (capture) {
        const result = await execute(argv[0], argv.slice(1), { timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
        stdout = result.stdout;
        if (result.stderr) process.stderr.write(result.stderr);
        exitCode = 0;
    } else {
        exitCode = await new Promise((resolve, reject) => {
            const child = spawn(argv[0], argv.slice(1), { cwd: repository, stdio: ['ignore', 'inherit', 'inherit'] });
            const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
            child.once('error', (error) => { clearTimeout(timer); reject(error); });
            child.once('exit', (code, signal) => { clearTimeout(timer); signal ? reject(new Error(phase + ' terminated by ' + signal)) : resolve(code); });
        });
    }
    commands.push({ phase, argv, exitCode, elapsedMs: performance.now() - start });
    assert.equal(exitCode, 0, phase + ' failed');
    return stdout;
}
const stdlibJvm = bootstrap.artifacts.find((item) => item.id === 'stdlib-jvm').path;
const annotations = bootstrap.artifacts.find((item) => item.id === 'annotations').path;
const compiler = ['java', '-Xmx768m', '-cp', bootstrap.classPath];
const jvm = [...compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', '2.5', '-api-version', '2.5'];
const wasm = [...compiler, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-language-version', '2.5', '-api-version', '2.5', '-libraries', bootstrap.wasmJsStdlib];
const probe = local('StorageProbe.kt');
const jvmEntry = local('StorageJvmEntry.kt');
const originalSupport = path.join(output, 'jvm/original-support.jar');
const originalKotlin = originalFiles.filter((file) => file.endsWith('.kt') && !file.endsWith('ObservableStorageManager.kt'));
await command('original-storage-kotlin-interfaces', [...jvm, '-classpath', stdlibJvm, '-d', originalSupport, ...originalKotlin, local('ProcessCanceledException.kt')]);
await command('original-storage-javac', ['javac', '-classpath', [originalSupport, annotations, stdlibJvm].join(path.delimiter), '-d', referenceClasses, ...originalFiles.filter((file) => file.endsWith('.java'))]);
const originalJar = path.join(output, 'jvm/original.jar');
await command('original-storage-jvm-observer-build', [...jvm, '-classpath', [referenceClasses, originalSupport, stdlibJvm].join(path.delimiter), '-d', originalJar, probe, local('OriginalProbeMap.kt'), jvmEntry]);
const storageTypes = originalFiles.find((file) => file.endsWith('/storage.kt'));
const common = [...prepared.commonSources, storageTypes, probe, local('PortableProbeMap.kt')];
const portableJar = path.join(output, 'jvm/portable.jar');
await command('portable-storage-jvm-build', [...jvm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-classpath', stdlibJvm, '-d', portableJar, ...common, jvmEntry]);
const original = JSON.parse((await command('original-storage-jvm-observe', ['java', '-ea', '-cp', [referenceClasses, originalJar, originalSupport, stdlibJvm].join(path.delimiter), 'org.jetbrains.kotlin.portable.storageprobe.StorageJvmEntryKt'], true)).trim());
const portable = JSON.parse((await command('portable-storage-jvm-observe', ['java', '-ea', '-cp', [portableJar, stdlibJvm].join(path.delimiter), 'org.jetbrains.kotlin.portable.storageprobe.StorageJvmEntryKt'], true)).trim());
assert.deepEqual(portable, original, 'Portable JVM storage differs from the official Java storage sources');
await command('portable-storage-wasmjs-klib-build', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-Xir-produce-klib-file', '-ir-output-dir', path.join(output, 'klib'), '-ir-output-name', 'storage-probe', ...common, local('StorageWasmEntry.kt')]);
await command('portable-storage-wasmjs-binary-build', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(output, 'klib/storage-probe.klib'), '-ir-output-dir', path.join(output, 'wasm'), '-ir-output-name', 'storage-probe', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const observedWasm = JSON.parse((await command('portable-storage-wasmjs-observe', [process.execPath, '--experimental-wasm-exnref', '--input-type=module', '-e',
    'const module = await import(process.argv[1]); console.log(module.storageProbeJson());', pathToFileURL(path.join(output, 'wasm/storage-probe.mjs')).href], true)).trim());
assert.deepEqual(observedWasm, original, 'Portable Wasm storage differs from the official Java storage sources');
for (const [name, value] of [['original-jvm.json', original], ['portable-jvm.json', portable], ['portable-wasmjs.json', observedWasm]]) {
    await writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
const outputs = [];
for (const name of ['jvm/original-support.jar', 'jvm/original.jar', 'jvm/portable.jar', 'klib/storage-probe.klib', 'original-jvm.json', 'portable-jvm.json', 'portable-wasmjs.json',
    ...(await readdir(path.join(output, 'wasm'))).sort().map((name) => 'wasm/' + name)]) {
    const bytes = await readRegular(path.join(output, name));
    outputs.push({ path: name, bytes: bytes.byteLength, sha256: sha256(bytes) });
}
const observerSources = [];
for (const name of ['StorageProbe.kt', 'StorageJvmEntry.kt', 'StorageWasmEntry.kt', 'OriginalProbeMap.kt', 'PortableProbeMap.kt']) {
    const bytes = await readRegular(local(name));
    observerSources.push({ path: name, bytes: bytes.byteLength, sha256: sha256(bytes) });
}
const receipt = { schemaVersion: 1, kind: 'official-compiler-core-storage-differential', status: 'passed', source: recipe.source,
    originals: recipe.originals, portable: recipeDefinition.portable, mapInterfaceReplacements: recipeDefinition.mapInterfaceReplacements,
    recipeSha256: recipe.recipeSha256, observerSources,
    buildScriptSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), prepareScriptSha256: sha256(await readRegular(local('prepare.mjs'))),
    bootstrapVersion: bootstrap.lock.version, bootstrapCompilerSourceCommit: bootstrap.lock.compilerSourceCommit,
    bootstrapArtifacts: bootstrap.artifacts.map(({ path: ignored, ...item }) => item), commands, outputs,
    comparison: { required: original.cases.length, passed: original.cases.length, failed: 0, skipped: 0, notRun: 0,
        originalJavaEqualsPortableJvm: true, originalJavaEqualsPortableWasm: true },
    wasmEngine: { kind: 'Node', version: process.version, flags: ['--experimental-wasm-exnref'] }, browserComparison: 'not-run',
    limitations: ['Tests the actual storage dependency state machines, not the full browser compiler.',
        'Host profile is one serial Worker; JVM contention, interruption and cross-thread visibility are excluded.',
        'ProcessCanceledException is a typed cancellation marker tested against the original reflection classifier, not an IntelliJ service implementation.',
        'Object identity debug strings and JVM stack traces are not claimed byte-identical.',
        'Both original JVM references run with assertions enabled; portable non-null result guards are retained.'],
    browserCompiler: 'not-built', languageReadiness: false };
await writeFile(path.join(output, 'storage-evidence.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, status: receipt.status, comparison: receipt.comparison }));
