#!/usr/bin/env node
/** Execute genuine original lazy/delegate bodies and selected cache contracts. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareFirStorageSources } from './prepare.mjs';
import { projectTraversal } from './traversal.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);
const options = new Map();
const args = process.argv.slice(2);
while (args.length) {
    const key = args.shift();
    assert(['--output', '--source-root', '--bootstrap-cache'].includes(key) && args[0] && !options.has(key), 'Invalid FIR storage check option');
    options.set(key, path.resolve(args.shift()));
}
const parent = path.join(repository, 'out/kotlin-compiler-fir-storage');
await assertNoSymlink(parent);
await mkdir(parent, { recursive: true, mode: 0o700 });
const output = options.get('--output') ?? await mkdtemp(path.join(parent, 'run-'));
assert(output.startsWith(path.join(repository, 'out') + path.sep));
await assertNoSymlink(output);
if (options.has('--output')) await mkdir(output, { recursive: false, mode: 0o700 });
await execute('git', ['init', '--quiet', output]);
const sourceRoot = options.get('--source-root') ?? path.join(repository, 'out/kotlin-compiler-port/sources');
const prepared = await prepareFirStorageSources({ sourceRoot, outputRoot: output });
const lockBytes = await readRegular(path.join(here, 'sources.lock.json'));
const lock = JSON.parse(lockBytes);
for (const pin of lock.observers) {
    const bytes = await readRegular(path.join(here, relativePath(pin.path)), pin.bytes);
    assert.equal(bytes.length, pin.bytes);
    assert.equal(sha256(bytes), pin.sha256, 'Changed observer: ' + pin.path);
}
const sourcePin = lock.sources.find(pin => pin.path === lock.traversal.sourcePath);
assert(sourcePin);
const traversal = projectTraversal(verifyFile(await readRegular(path.join(sourceRoot, sourcePin.path), sourcePin.bytes), sourcePin).toString(), lock.traversal);
const projected = path.join(output, 'FillUnboundTraversal.kt');
await writeFile(projected, traversal.source, { flag: 'wx', mode: 0o600 });
const originalPaths = lock.sources.filter(pin => /\/(IrLock|lazyUtil|threadLocal)\.kt$/.test(pin.path)).map(pin => pin.path);
assert.equal(originalPaths.length, 3);
const originalSources = [];
for (const originalPath of originalPaths) {
    const pin = lock.sources.find(item => item.path === originalPath);
    const filename = path.join(output, 'original', originalPath);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, verifyFile(await readRegular(path.join(sourceRoot, originalPath), pin.bytes), pin), { flag: 'wx', mode: 0o600 });
    originalSources.push(filename);
}
const bootstrap = await verifyBootstrap(options.get('--bootstrap-cache') ?? defaultCache);
assert.equal(bootstrap.lock.selectedSourceCommit, lock.source.commit);
const flagsBytes = await readRegular(path.join(here, '../build-flags.json'));
const flags = JSON.parse(flagsBytes);
assert.equal(flags.source.commit, lock.source.commit);
const stdlib = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path;
const compiler = ['-Xmx768m', '-cp', bootstrap.classPath];
const jvm = [...compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
    '-jvm-target', '17', '-language-version', '2.5', '-api-version', '2.5', ...flags.compilerFlags, '-classpath', stdlib];
const wasm = [...compiler, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js',
    '-language-version', '2.5', '-api-version', '2.5', ...flags.compilerFlags, '-libraries', bootstrap.wasmJsStdlib];
const commands = [];
async function command(phase, executable, argv) {
    const started = performance.now();
    const result = await execute(executable, argv, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    if (result.stderr) process.stderr.write(result.stderr);
    commands.push({ phase, argv: [executable, ...argv], exitCode: 0, elapsedMs: performance.now() - started });
    return result.stdout;
}
const local = name => path.join(here, name);
const common = [
    ...prepared.commonSources.filter(filename => originalPaths.some(originalPath => filename.endsWith('/' + originalPath)) || filename.endsWith('/SerialFirCacheMap.kt')),
    local('FirStorageProbe.kt'), local('PortableProbeSupport.kt'), projected,
];
assert.equal(common.length, 7);
const originalJar = path.join(output, 'original.jar');
const portableJar = path.join(output, 'portable.jar');
await command('original-jvm-build', 'java', [...jvm, '-d', originalJar, ...originalSources,
    local('FirStorageProbe.kt'), local('OriginalProbeSupport.kt'), projected, local('FirStorageJvmEntry.kt')]);
await command('portable-common-jvm-build', 'java', [...jvm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','),
    '-d', portableJar, ...common, local('FirStorageJvmEntry.kt')]);
const entry = 'org.jetbrains.kotlin.portable.firstorageprobe.FirStorageJvmEntryKt';
const original = JSON.parse((await command('original-jvm-execute', 'java', ['-ea', '-cp', [originalJar, stdlib].join(path.delimiter), entry])).trim());
const portable = JSON.parse((await command('portable-common-jvm-execute', 'java', ['-ea', '-cp', [portableJar, stdlib].join(path.delimiter), entry])).trim());
assert.deepEqual(portable.cases, original.cases, 'Common JVM differs from original JVM observations');
const klib = path.join(output, 'klib');
const wasmOutput = path.join(output, 'wasm');
await mkdir(klib); await mkdir(wasmOutput);
await command('portable-wasmjs-klib', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','),
    '-Xir-produce-klib-file', '-ir-output-dir', klib, '-ir-output-name', 'fir-storage', ...common, local('FirStorageWasmEntry.kt')]);
await command('portable-wasmjs-binary', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(klib, 'fir-storage.klib'),
    '-ir-output-dir', wasmOutput, '-ir-output-name', 'fir-storage', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const observedWasm = JSON.parse((await command('portable-wasmjs-execute', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const module = await import(process.argv[1]); console.log(module.firStorageProbeJson());', pathToFileURL(path.join(wasmOutput, 'fir-storage.mjs')).href])).trim());
assert.deepEqual(observedWasm.cases, original.cases, 'Actual Wasm differs from original JVM observations');
assert(original.cases.length >= 50 && original.cases.every(value => value.endsWith(':ok')));
assert.equal(new Set(original.cases).size, original.cases.length);
const outputs = [];
for (const [name, observation] of [['original-jvm.json', original], ['portable-jvm.json', portable], ['portable-wasmjs.json', observedWasm]]) {
    await writeJson(path.join(output, name), observation);
}
for (const name of ['original.jar', 'portable.jar', 'klib/fir-storage.klib', 'original-jvm.json', 'portable-jvm.json', 'portable-wasmjs.json',
    ...(await readdir(wasmOutput)).sort().map(name => 'wasm/' + name)]) {
    const bytes = await readRegular(path.join(output, name));
    outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
}
const receipt = {
    schemaVersion: 1, kind: 'official-fir-serial-storage-differential', status: 'passed', source: lock.source,
    sourceLockSha256: sha256(lockBytes), sourceClosureLockSha256: lock.sourceClosureLockSha256,
    sources: lock.sources, referenceDependencies: lock.referenceDependencies, observers: lock.observers,
    checkToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    prepareToolSha256: sha256(await readRegular(local('prepare.mjs'))), buildFlagsSha256: sha256(flagsBytes),
    traversal: { ...lock.traversal, projectedBytes: Buffer.byteLength(traversal.source), projectedSha256: sha256(Buffer.from(traversal.source)),
        substitutions: traversal.substitutions, fullFirExecution: false },
    bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: bootstrap.lock.compilerSourceCommit,
        artifacts: bootstrap.artifacts.map(({ path: ignored, ...pin }) => pin) },
    commands, outputs, comparison: { required: original.cases.length, passed: original.cases.length,
        failed: 0, skipped: 0, notRun: 0, originalJvmEqualsCommonJvm: true, originalJvmEqualsWasm: true },
    observations: original.cases,
    rawTraversal: { originalJvm: original.rawTraversal, commonJvm: portable.rawTraversal, wasmJs: observedWasm.rawTraversal,
        comparedBy: 'Locked traversal control-flow and weak-view invariants; insertion order and later-append visibility are not promised.' },
    runtimeClasspath: 'Original and common JVM applications use only their observer JAR and the verified Kotlin stdlib; no compiler JAR.',
    wasmEngine: { kind: 'Node', version: process.version, flags: ['--experimental-wasm-exnref'] },
    limits: ['The three genuine original JVM IrLock/lazy/delegate sources are executed, not substituted fixtures.',
        'Traversal uses the locked fillUnboundSymbols body with only its concrete type/operation bindings parameterized; no FIR/IR types are fabricated.',
        'Full coupled FIR storage, declarations, symbol tables and browser source compilation are not executed by this dependency probe.',
        'Cache weak traversals retain existing entries and permit observing or omitting later appends; raw JDK order is preserved separately.',
        'Serial Worker ownership excludes multithread contention/cross-Worker sharing; garbage-collection timing is not asserted.',
        'JDK callback violations, mutable collection views and cache removal/clear are outside the selected API.',
        'ThreadLocal diagnostics use #worker rather than a JVM thread ID.'],
    browserExecution: 'not-run', browserCompilerBuilt: false, readiness: false,
};
await writeJson(path.join(output, 'fir-storage-evidence.json'), receipt);
console.log(JSON.stringify({ output, comparison: receipt.comparison, browserCompilerBuilt: false }));
