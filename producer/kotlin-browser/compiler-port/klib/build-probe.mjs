#!/usr/bin/env node
/** Build real official KLIB format readers on original JVM, portable JVM and browser Wasm hosts. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, relativePath } from '../../scripts/source.mjs';
import { prepareKlibSources } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const options = {};
const args = process.argv.slice(2);
while (args.length) {
    const key = args.shift();
    assert(['--output', '--source-root', '--bootstrap-cache', '--target-stdlib'].includes(key) && args[0] && !options[key]);
    options[key] = path.resolve(args.shift());
}
const output = options['--output'] ?? path.join(repository, 'out/kotlin-klib-probe');
const sourceRoot = options['--source-root'] ?? path.join(repository, 'out/kotlin-compiler-port/sources');
const target = options['--target-stdlib'] ?? path.join(repository, 'out/kotlin-stdlib-probe/builds/run-2c71e12f/stdlib/kotlin-stdlib-wasm-wasi.klib');
assert(output.startsWith(path.join(repository, 'out') + path.sep));
await assertNoSymlink(output);
await mkdir(output, { recursive: false });
const lockBytes = await readRegular(path.join(here, 'sources.lock.json'));
const lock = JSON.parse(lockBytes);
const bootstrap = await verifyBootstrap(options['--bootstrap-cache'] ?? defaultCache);
const commands = [];
async function command(phase, argv, capture = false) {
    const start = performance.now();
    let stdout = '';
    let exitCode;
    if (capture) {
        const result = await execute(argv[0], argv.slice(1), { cwd: repository, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
        stdout = result.stdout;
        if (result.stderr) process.stderr.write(result.stderr);
        exitCode = 0;
    } else {
        exitCode = await new Promise((resolve, reject) => {
            const child = spawn(argv[0], argv.slice(1), { cwd: repository, stdio: ['ignore', 'inherit', 'inherit'] });
            const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
            child.once('error', (error) => { clearTimeout(timer); reject(error); });
            child.once('exit', (code, signal) => { clearTimeout(timer); if (signal) reject(new Error(phase + ' terminated by ' + signal)); else resolve(code); });
        });
    }
    commands.push({ phase, argv, exitCode, elapsedMs: performance.now() - start });
    assert.equal(exitCode, 0, phase + ' failed');
    return stdout;
}

const prepared = await prepareKlibSources({ sourceRoot, outputRoot: path.join(output, 'portable') });
const originalSources = [];
for (const pin of [...lock.sources, ...lock.referenceOnlySources]) {
    const bytes = await readRegular(path.join(sourceRoot, relativePath(pin.path)));
    assert.equal(hash(bytes), pin.sha256);
    assert.equal(bytes.byteLength, pin.bytes);
    const filename = path.join(output, 'original', pin.path);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    originalSources.push(filename);
}
const local = (name) => path.join(here, name);
const localFiles = ['Probe.kt', 'PortableChecks.kt', 'OriginalJvmEntry.kt', 'PortableJvmEntry.kt', 'WasmEntry.kt', 'extract-fixture.py'];
const observerSources = [];
for (const filename of localFiles) { const bytes = await readRegular(local(filename)); observerSources.push({ path: filename, bytes: bytes.byteLength, sha256: hash(bytes) }); }
const hostPath = path.join(here, '../host/LibraryPath.kt');
const hostPathBytes = await readRegular(hostPath);
const generatedHostPath = path.join(output, 'portable/compiler-port-klib/LibraryPath.kt');
await writeFile(generatedHostPath, hostPathBytes, { flag: 'wx', mode: 0o600 });
const common = [...prepared.commonSources, generatedHostPath];
await command('extract-real-stdlib-fixture', ['python3', local('extract-fixture.py'), '--klib', target, '--output', path.join(output, 'fixture')]);
const fixtureBytes = await readRegular(path.join(output, 'fixture/index.json'));
const fixture = JSON.parse(fixtureBytes);
for (const directory of ['jvm', 'klib', 'wasm']) await mkdir(path.join(output, directory));
const compiler = ['java', '-Xmx1024m', '-cp', bootstrap.classPath];
const jvm = [...compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17',
    '-language-version', '2.5', '-api-version', '2.5', '-classpath', bootstrap.classPath];
const wasm = [...compiler, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js',
    '-language-version', '2.5', '-api-version', '2.5', '-libraries', bootstrap.wasmJsStdlib];
await command('original-jvm-build', [...jvm, '-d', path.join(output, 'jvm/original.jar'), ...originalSources, local('Probe.kt'), local('OriginalJvmEntry.kt')]);
await command('portable-jvm-build', [...jvm, '-d', path.join(output, 'jvm/portable.jar'), ...common, local('Probe.kt'), local('PortableChecks.kt'), local('PortableJvmEntry.kt')]);
const snapshots = [];
for (const variant of ['original', 'portable']) {
    const className = 'org.jetbrains.kotlin.portable.klibprobe.' + (variant === 'original' ? 'OriginalJvmEntryKt' : 'PortableJvmEntryKt');
    const stdout = await command(variant + '-jvm-observe', ['java', '-Xmx1024m', '-cp', path.join(output, 'jvm/' + variant + '.jar') + path.delimiter + bootstrap.classPath,
        className, path.join(output, 'fixture/files'), path.join(output, variant + '-snapshot.bin')], true);
    const lines = stdout.trim().split('\n');
    const observed = { unit: JSON.parse(lines[0]), manifest: JSON.parse(lines[1]), ...(variant === 'portable' ? { guards: JSON.parse(lines[2]) } : {}) };
    await writeFile(path.join(output, variant + '-jvm.json'), JSON.stringify(observed, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    snapshots.push(observed);
}
assert.deepEqual(snapshots[1].unit, snapshots[0].unit);
assert.deepEqual(snapshots[1].manifest, snapshots[0].manifest);
const originalSnapshot = await readRegular(path.join(output, 'original-snapshot.bin'), 64 * 1024 * 1024);
const portableSnapshot = await readRegular(path.join(output, 'portable-snapshot.bin'), 64 * 1024 * 1024);
assert(originalSnapshot.equals(portableSnapshot), 'Actual stdlib metadata/IR byte access differs between original and portable JVM');
await command('portable-wasmjs-klib-build', [...wasm, '-Xir-produce-klib-file', '-ir-output-dir', path.join(output, 'klib'), '-ir-output-name', 'klib-probe',
    ...common, local('Probe.kt'), local('PortableChecks.kt'), local('WasmEntry.kt')]);
await command('portable-wasmjs-binary-build', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(output, 'klib/klib-probe.klib'), '-ir-output-dir', path.join(output, 'wasm'),
    '-ir-output-name', 'klib-probe', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const outputs = [];
for (const filename of ['jvm/original.jar', 'jvm/portable.jar', 'klib/klib-probe.klib', 'original-jvm.json', 'portable-jvm.json', 'original-snapshot.bin', 'portable-snapshot.bin',
    ...(await readdir(path.join(output, 'wasm'))).sort().map((name) => 'wasm/' + name)]) {
    const bytes = await readRegular(path.join(output, filename), 64 * 1024 * 1024);
    outputs.push({ path: filename, bytes: bytes.byteLength, sha256: hash(bytes) });
}
const receipt = { schemaVersion: 1, kind: 'official-klib-real-stdlib-host-build', status: 'passed', source: lock.source, sourceLockSha256: hash(lockBytes), patch: lock.patch,
    preparation: prepared.receipt, referenceOnlySources: lock.referenceOnlySources, observerSources, buildScriptSha256: hash(await readRegular(fileURLToPath(import.meta.url))),
    hostLibraryPathSha256: hash(hostPathBytes), bootstrapVersion: bootstrap.lock.version, bootstrapCompilerSourceCommit: bootstrap.lock.compilerSourceCommit,
    bootstrapArtifacts: bootstrap.artifacts.map(({ path: ignored, ...record }) => record), commands,
    targetStdlib: { path: target, sha256: fixture.stdlibSha256, sourceCommit: fixture.sourceCommit, fixtureIndexSha256: hash(fixtureBytes), files: fixture.files.length,
        decodedBytes: fixture.decodedBytes, directories: fixture.directories.length },
    jvmComparison: { unitCases: Object.keys(snapshots[0].unit).length, manifestCases: Object.keys(snapshots[0].manifest).length, guards: snapshots[1].guards,
        stdlibByteEquality: true, snapshotBytes: originalSnapshot.byteLength, snapshotSha256: hash(originalSnapshot) }, outputs,
    browserComparison: 'not-run', languageReadiness: false,
    limitations: ['KLIB container/component and byte-encoding boundary only; protobuf decoding, library FIR symbols and linking are separate work.',
        'The target fixture is the rebuilt selected-source stdlib, produced using the locked official bootstrap compiler; compiler source commit is not proven equal to candidate.',
        'Finite byte/table limits are explicit new host policy; invalid inputs now fail before allocation or crossing a table row.',
        'String-only manifest properties do not implement arbitrary Java Properties object values/default property chains.',
        'No full browser-hosted Kotlin compiler, whole G2 gate, browser matrix or GC heap cap is established by this build.'] };
await writeFile(path.join(output, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, status: receipt.status, unitCases: receipt.jvmComparison.unitCases, stdlibSnapshotBytes: originalSnapshot.byteLength,
    wasm: outputs.filter((record) => record.path.endsWith('.wasm')) }));
