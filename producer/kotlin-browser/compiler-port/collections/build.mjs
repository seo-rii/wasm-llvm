#!/usr/bin/env node
/** Actual official DFS/SmartList dependency comparison, not compiler C or Kotlin language acceptance. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, verifyFile } from '../../scripts/source.mjs';
import { prepareCollectionsSources } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);
const options = {};
const args = process.argv.slice(2);
while (args.length) {
    const key = args.shift();
    assert(['--output', '--source-root', '--bootstrap-cache'].includes(key) && args[0] && !options[key], 'Invalid collections build option');
    options[key] = path.resolve(args.shift());
}
const output = options['--output'] ?? path.join(repository, 'out/kotlin-compiler-collections-probe');
const sourceRoot = options['--source-root'] ?? path.join(repository, 'out/kotlin-compiler-port/sources');
assert(output.startsWith(path.join(repository, 'out') + path.sep), 'Collections output must stay under repository out/');
await assertNoSymlink(output);
const bootstrap = await verifyBootstrap(options['--bootstrap-cache'] ?? defaultCache);
assert.equal(bootstrap.lock.selectedSourceCommit, '4d78aae1e337cd40f69baa865aed950fe807a775');
await mkdir(output, { recursive: false });
const prepared = await prepareCollectionsSources({ sourceRoot, outputRoot: output });
const recipe = prepared.receipt;
const local = (name) => path.join(here, name);
const flagsBytes = await readRegular(path.join(here, '../build-flags.json'));
const flags = JSON.parse(flagsBytes);
assert.equal(flags.source.commit, recipe.source.commit);
assert(Array.isArray(flags.compilerFlags) && flags.compilerFlags.every((item) => typeof item === 'string'));
const sourceFlags = flags.compilerFlags;
const originalFiles = [];
for (const pin of recipe.originals) {
    const destination = path.join(output, 'original', pin.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, verifyFile(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), pin), { flag: 'wx', mode: 0o600 });
    originalFiles.push(destination);
}
for (const name of ['jvm/classes', 'klib', 'wasm']) await mkdir(path.join(output, name), { recursive: true });
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
const jvm = [...compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', '2.5', '-api-version', '2.5', ...sourceFlags];
const wasm = [...compiler, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-language-version', '2.5', '-api-version', '2.5', '-libraries', bootstrap.wasmJsStdlib, ...sourceFlags];
const referenceClasses = path.join(output, 'jvm/classes');
await command('official-collections-javac', ['javac', '-classpath', [annotations, stdlibJvm].join(path.delimiter), '-d', referenceClasses, ...originalFiles.filter((file) => file.endsWith('.java')), local('OriginalCollectionsBridge.java')]);
const probe = local('CollectionsProbe.kt');
const jvmEntry = local('CollectionsJvmEntry.kt');
const originalJar = path.join(output, 'jvm/original.jar');
await command('official-collections-jvm-observer-build', [...jvm, '-classpath', [referenceClasses, stdlibJvm].join(path.delimiter), '-d', originalJar, probe, local('OriginalProbeOperations.kt'), jvmEntry]);
const common = [...prepared.commonSources.filter((file) => !file.endsWith('/FirNonExpansiveInheritanceRestrictionChecker.kt')), probe, local('PortableProbeOperations.kt')];
const portableJar = path.join(output, 'jvm/portable.jar');
await command('portable-collections-jvm-build', [...jvm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-classpath', stdlibJvm, '-d', portableJar, ...common, jvmEntry]);
const main = 'org.jetbrains.kotlin.portable.collectionsprobe.CollectionsJvmEntryKt';
const original = JSON.parse((await command('official-collections-jvm-observe', ['java', '-ea', '-cp', [referenceClasses, originalJar, stdlibJvm].join(path.delimiter), main], true)).trim());
const portable = JSON.parse((await command('portable-collections-jvm-observe', ['java', '-ea', '-cp', [portableJar, stdlibJvm].join(path.delimiter), main], true)).trim());
assert.deepEqual(portable, original, 'Portable JVM DFS/SmartList differ from their exact original Java sources');
await command('portable-collections-wasmjs-klib-build', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-Xir-produce-klib-file', '-ir-output-dir', path.join(output, 'klib'), '-ir-output-name', 'collections-probe', ...common, local('CollectionsWasmEntry.kt')]);
await command('portable-collections-wasmjs-binary-build', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(output, 'klib/collections-probe.klib'), '-ir-output-dir', path.join(output, 'wasm'), '-ir-output-name', 'collections-probe', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const observedWasm = JSON.parse((await command('portable-collections-wasmjs-observe', [process.execPath, '--experimental-wasm-exnref', '--input-type=module', '-e',
    'const module = await import(process.argv[1]); console.log(module.collectionsProbeJson());', pathToFileURL(path.join(output, 'wasm/collections-probe.mjs')).href], true)).trim());
assert.deepEqual(observedWasm, original, 'Portable Wasm DFS/SmartList differ from their exact original Java sources');
for (const [name, value] of [['original-jvm.json', original], ['portable-jvm.json', portable], ['portable-wasmjs.json', observedWasm]]) {
    await writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
const outputs = [];
const classFiles = await readdir(path.join(referenceClasses, 'org/jetbrains/kotlin/utils'));
for (const name of ['jvm/original.jar', 'jvm/portable.jar', ...classFiles.sort().map((name) => 'jvm/classes/org/jetbrains/kotlin/utils/' + name), 'jvm/classes/org/jetbrains/kotlin/portable/collectionsprobe/OriginalCollectionsBridge.class',
    'klib/collections-probe.klib', 'original-jvm.json', 'portable-jvm.json', 'portable-wasmjs.json',
    ...(await readdir(path.join(output, 'wasm'))).sort().map((name) => 'wasm/' + name)]) {
    const bytes = await readRegular(path.join(output, name));
    outputs.push({ path: name, bytes: bytes.byteLength, sha256: sha256(bytes) });
}
const observerSources = [];
for (const name of ['CollectionsProbe.kt', 'CollectionsJvmEntry.kt', 'CollectionsWasmEntry.kt', 'OriginalProbeOperations.kt', 'PortableProbeOperations.kt', 'OriginalCollectionsBridge.java']) {
    const bytes = await readRegular(local(name));
    observerSources.push({ path: name, bytes: bytes.byteLength, sha256: sha256(bytes) });
}
const receipt = { schemaVersion: 1, kind: 'official-compiler-dfs-smartlist-differential', status: 'passed', source: recipe.source,
    originals: recipe.originals, portable: recipe.portable, callerTransformations: recipe.callerTransformations,
    sourceBuildFlagsSha256: sha256(flagsBytes), recipeSha256: recipe.recipeSha256, observerSources,
    buildScriptSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), prepareScriptSha256: sha256(await readRegular(local('prepare.mjs'))),
    bootstrapVersion: bootstrap.lock.version, bootstrapCompilerSourceCommit: bootstrap.lock.compilerSourceCommit,
    bootstrapArtifacts: bootstrap.artifacts.map(({ path: ignored, ...item }) => item), commands, outputs,
    comparison: { required: original.cases.length, passed: original.cases.length, failed: 0, skipped: 0, notRun: 0,
        originalJavaEqualsPortableJvm: true, originalJavaEqualsPortableWasm: true, mutationOperations: 2048, mutationSeedHex: '01234567' },
    wasmEngine: { kind: 'Node', version: process.version, flags: ['--experimental-wasm-exnref'] }, browserComparison: 'not-run',
    limitations: ['Tests actual compiler DFS/SmartList dependency algorithms, not the whole browser compiler.',
        'The selected generic Graph<T> caller is transformed only at its Java-flexible T? override signature; nullable DFS type arguments are exercised.',
        'DFS handler list carrier is common ArrayDeque instead of JVM LinkedList; mutable order/prepend and visited equality/identity policies remain tested.',
        'JVM reflection-based array component introspection and invalid typed-array stores are outside the browser host profile.',
        'Sorting preserves stable sequence order and exception propagation; underlying platform comparison schedules are not required equal.',
        'Original and portable JVM references run with assertions enabled; Wasm array range checks and assertions are enabled.'],
    browserCompiler: 'not-built', languageReadiness: false };
await writeFile(path.join(output, 'collections-evidence.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, status: receipt.status, comparison: receipt.comparison }));
