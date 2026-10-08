#!/usr/bin/env node
/** Differential for selected official component writers; does not construct FIR/IR or compile Kotlin programs. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular } from '../../scripts/source.mjs';
import { prepareKlibSources } from '../klib/prepare.mjs';
import { prepareLinkerSources } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const execute = promisify(execFile);
const options = {};
const args = process.argv.slice(2);
while (args.length) { const key = args.shift(); assert(['--output', '--source-root', '--bootstrap-cache', '--target-stdlib'].includes(key) && args[0] && !options[key]); options[key] = path.resolve(args.shift()); }
const output = options['--output'] ?? path.join(repository, 'out/kotlin-linker-writer-probe');
const sourceRoot = options['--source-root'] ?? path.join(repository, 'out/kotlin-compiler-port/sources');
const target = options['--target-stdlib'] ?? path.join(repository, 'out/kotlin-stdlib-probe/builds/run-2c71e12f/stdlib/kotlin-stdlib-wasm-wasi.klib');
assert(output.startsWith(path.join(repository, 'out') + path.sep));
await assertNoSymlink(output);
await mkdir(output, { recursive: false });
const bootstrap = await verifyBootstrap(options['--bootstrap-cache'] ?? defaultCache);
const klibLockBytes = await readRegular(path.join(here, '../klib/sources.lock.json'));
const klibLock = JSON.parse(klibLockBytes);
const linkerLockBytes = await readRegular(path.join(here, 'sources.lock.json'));
const linkerLock = JSON.parse(linkerLockBytes);
const sourceBuildFlagsBytes = await readRegular(path.join(here, '../build-flags.json'));
const sourceBuildFlags = JSON.parse(sourceBuildFlagsBytes);
assert.equal(sourceBuildFlags.source.commit, linkerLock.source.commit);
const klib = await prepareKlibSources({ sourceRoot, outputRoot: path.join(output, 'portable-klib') });
const linker = await prepareLinkerSources({ sourceRoot, outputRoot: path.join(output, 'portable-linker') });
const unitPaths = linkerLock.sources.filter((pin) => pin.path.includes('/util-klib/') && !pin.path.includes('/loader/KlibLoader.kt')).map((pin) => pin.path);
const unitSet = new Set(unitPaths);
const original = [];
for (const pin of [...klibLock.sources, ...klibLock.referenceOnlySources, ...linkerLock.sources.filter((pin) => unitSet.has(pin.path))]) {
    if (original.some((filename) => filename.endsWith('/' + pin.path))) continue;
    const bytes = await readRegular(path.join(sourceRoot, pin.path));
    assert.equal(hash(bytes), pin.sha256);
    let filename = path.join(output, 'original', pin.path);
    let contents = bytes;
    if (pin.path.endsWith('/KlibImpl.kt')) {
        const text = bytes.toString();
        contents = Buffer.from(text.slice(0, text.indexOf('import org.jetbrains.kotlin.io.ZipFileSystemAccessor')) +
            'import org.jetbrains.kotlin.library.KlibComponentLayout\nimport org.jetbrains.kotlin.library.KlibConstants.KLIB_DEFAULT_COMPONENT_NAME\n' +
            'import org.jetbrains.kotlin.library.KlibConstants.KLIB_MANIFEST_FILE_NAME\nimport java.nio.file.Path\n\n' +
            text.slice(text.indexOf('internal class KlibManifestComponentLayout(')));
        filename = path.join(output, 'original/OriginalManifestLayout.kt');
    }
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, contents, { flag: 'wx', mode: 0o600 });
    original.push(filename);
}
const hostPath = path.join(here, '../host/LibraryPath.kt');
const hostBytes = await readRegular(hostPath);
const hostOutput = path.join(output, 'LibraryPath.kt');
await writeFile(hostOutput, hostBytes, { flag: 'wx', mode: 0o600 });
const common = [...klib.commonSources, ...linker.commonSources.filter((filename) =>
    [...unitSet].some((relative) => filename.endsWith('/' + relative)) ||
    ['MemoryKlibOutput.kt', 'SourcePathOperations.kt', 'MemoryJarManifest.kt', 'MemoryKlibLoader.kt'].includes(path.basename(filename))), hostOutput];
const observerNames = ['WriterFixture.kt', 'WriterConfiguration.kt', 'OriginalJvmEntry.kt', 'PortableObserver.kt', 'PortableChecks.kt', 'PortableJvmEntry.kt', 'WasmEntry.kt'];
const observerSources = [];
for (const name of observerNames) { const bytes = await readRegular(path.join(here, name)); observerSources.push({ path: name, bytes: bytes.byteLength, sha256: hash(bytes) }); }
const local = (filename) => path.join(here, filename);
const commands = [];
async function command(phase, argv, capture = false) {
    const started = performance.now();
    let stdout = '';
    let exitCode;
    if (capture) {
        const result = await execute(argv[0], argv.slice(1), { cwd: repository, timeout: 240000, maxBuffer: 65536 });
        stdout = result.stdout; if (result.stderr) process.stderr.write(result.stderr); exitCode = 0;
    } else exitCode = await new Promise((resolve, reject) => {
        const child = spawn(argv[0], argv.slice(1), { cwd: repository, stdio: ['ignore', 'inherit', 'inherit'] });
        const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code, signal) => { clearTimeout(timer); if (signal) reject(new Error(phase + ': ' + signal)); else resolve(code); });
    });
    commands.push({ phase, argv, exitCode, elapsedMs: performance.now() - started });
    assert.equal(exitCode, 0, phase + ' failed');
    return stdout;
}
await command('extract-real-stdlib', ['python3', path.join(here, '../klib/extract-fixture.py'), '--klib', target, '--output', path.join(output, 'fixture')]);
const indexBytes = await readRegular(path.join(output, 'fixture/index.json'));
const fixture = JSON.parse(indexBytes);
for (const directory of ['jvm', 'klib', 'wasm']) await mkdir(path.join(output, directory));
const java = ['java', '-Xmx1024m', '-cp', bootstrap.classPath];
const jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', '2.5', '-api-version', '2.5', ...sourceBuildFlags.compilerFlags, '-classpath', bootstrap.classPath];
// The original util-io and filesystem reader sources mix legacy positional and new syntax.
// Keep them byte-identical; complete name checking is the combined portable C source-set policy.
const originalJvm = jvm.map((arg) => arg === '-Xname-based-destructuring=complete' ? '-Xname-based-destructuring=only-syntax' : arg);
const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-language-version', '2.5', '-api-version', '2.5', ...sourceBuildFlags.compilerFlags, '-libraries', bootstrap.wasmJsStdlib];
const shared = [local('WriterFixture.kt'), local('WriterConfiguration.kt')];
const portableObservers = [local('PortableObserver.kt'), local('PortableChecks.kt')];
await command('original-jvm-build', [...originalJvm, '-d', path.join(output, 'jvm/original.jar'), ...original, ...shared, local('OriginalJvmEntry.kt')]);
await command('portable-jvm-build', [...jvm, '-d', path.join(output, 'jvm/portable.jar'), ...common, ...shared, ...portableObservers, local('PortableJvmEntry.kt')]);
await command('original-jvm-observe', ['java', '-Xmx1024m', '-cp', path.join(output, 'jvm/original.jar') + path.delimiter + bootstrap.classPath,
    'org.jetbrains.kotlin.portable.linkerprobe.OriginalJvmEntryKt', path.join(output, 'fixture/files'), path.join(output, 'original-written'), path.join(output, 'original-snapshot.bin'), path.join(output, 'original-jars.txt')], true);
await command('portable-jvm-observe', ['java', '-Xmx1024m', '-cp', path.join(output, 'jvm/portable.jar') + path.delimiter + bootstrap.classPath,
    'org.jetbrains.kotlin.portable.linkerprobe.PortableJvmEntryKt', path.join(output, 'fixture/files'), path.join(output, 'portable-snapshot.bin'), path.join(output, 'portable-jars.txt'), path.join(output, 'portable-guards.txt')], true);
const originalSnapshot = await readRegular(path.join(output, 'original-snapshot.bin'), 64 * 1024 * 1024);
assert(originalSnapshot.equals(await readRegular(path.join(output, 'portable-snapshot.bin'), 64 * 1024 * 1024)), 'Official component writer bytes differ');
const jars = await readRegular(path.join(output, 'original-jars.txt'));
assert.equal((await readRegular(path.join(output, 'portable-jars.txt'))).toString(), jars.toString(), 'JAR manifest main version semantics differ');
const guards = (await readRegular(path.join(output, 'portable-guards.txt'))).toString().split('\n');
await command('portable-wasmjs-klib-build', [...wasm, '-ir-output-dir', path.join(output, 'klib'), '-ir-output-name', 'linker-writer-probe', ...common, ...shared, ...portableObservers, local('WasmEntry.kt')]);
await command('portable-wasmjs-binary-build', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(output, 'klib/linker-writer-probe.klib'), '-ir-output-dir', path.join(output, 'wasm'), '-ir-output-name', 'linker-writer-probe', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const outputs = [];
for (const filename of ['jvm/original.jar', 'jvm/portable.jar', 'klib/linker-writer-probe.klib', 'original-snapshot.bin', 'portable-snapshot.bin', 'original-jars.txt', 'portable-jars.txt', 'portable-guards.txt',
    ...(await readdir(path.join(output, 'wasm'))).sort().map((name) => 'wasm/' + name)]) {
    const bytes = await readRegular(path.join(output, filename), 64 * 1024 * 1024);
    outputs.push({ path: filename, bytes: bytes.byteLength, sha256: hash(bytes) });
}
const receipt = {
    schemaVersion: 1, kind: 'official-memory-klib-component-writer-build', status: 'passed', source: linkerLock.source,
    sourceLockSha256: hash(linkerLockBytes), patch: linkerLock.patch, preparation: linker.receipt,
    klibSourceLockSha256: hash(klibLockBytes), klibPatch: klibLock.patch, klibPreparation: klib.receipt,
    observerSources, buildScriptSha256: hash(await readRegular(fileURLToPath(import.meta.url))), hostLibraryPathSha256: hash(hostBytes),
    sourceBuildFlags: { ...sourceBuildFlags, sha256: hash(sourceBuildFlagsBytes) },
    bootstrapVersion: bootstrap.lock.version, bootstrapCompilerSourceCommit: bootstrap.lock.compilerSourceCommit,
    bootstrapArtifacts: bootstrap.artifacts.map(({ path: ignored, ...record }) => record), commands,
    targetStdlib: { path: target, sha256: fixture.stdlibSha256, sourceCommit: fixture.sourceCommit, fixtureIndexSha256: hash(indexBytes), files: fixture.files.length, decodedBytes: fixture.decodedBytes },
    jvmComparison: { everyOutputByteEqual: true, snapshotBytes: originalSnapshot.byteLength, snapshotSha256: hash(originalSnapshot), jarCases: jars.toString().split('\n').length, guards }, outputs,
    browserComparison: 'not-run', languageReadiness: false,
    limitations: ['Actual KlibWriter and metadata/IR component writer boundary only; source-to-KLIB and loadIr are not executed by this unit.',
        'Genuine rebuilt stdlib metadata/main/inlinable bytes are repackaged by official writers; probe paths only impose stable row order.',
        'Original JVM reference extracts only the exact unchanged manifest-layout declaration from KlibImpl; original writer/validator/component algorithms remain selected source.',
        'Byte-identical original util-io/filesystem reference sources require name-based-destructuring=only-syntax; portable JVM/Wasm use the combined C flags complete mode.',
        'JVM reference locale is ROOT; portable metadata fragment ordinals use ASCII decimal digits.',
        'Compatibility host checks and verified virtual lookup are exercised, but the full CompilerConfiguration special-check entry is a separate integration gate.',
        'Official bootstrap builds portable Wasm; its source commit is not proved equal to selected candidate.',
        'No entire G2 gate, full browser compiler, persistent offline app shell, total GC heap hard cap or browser matrix is established.'],
};
await writeFile(path.join(output, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, status: 'passed', snapshotBytes: originalSnapshot.byteLength, jarCases: receipt.jvmComparison.jarCases, guards: guards.length }));
