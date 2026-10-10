#!/usr/bin/env node
/** Execute only the actual pure helper and profile guard; full FIR execution remains not-run. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256 } from '../../scripts/source.mjs';
import { prepareParserProfileSourceCache } from './fetch.mjs';
import { prepareParserProfileSources } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);
const options = {};
const args = process.argv.slice(2);
while (args.length) {
    const key = args.shift();
    assert(['--output', '--source-root', '--bootstrap-cache', '--supplemental-source-root'].includes(key) && args[0] && !options[key], 'Invalid parser profile build option');
    options[key] = path.resolve(args.shift());
}
const output = options['--output'] ?? path.join(repository, 'out/kotlin-parser-profile-probe');
assert(output.startsWith(path.join(repository, 'out') + path.sep), 'Parser profile probe output must stay under repository out/');
await assertNoSymlink(output);
await mkdir(output, { recursive: false });
const commands = [];
const receipt = { schemaVersion: 1, kind: 'official-parser-profile-pure-helper-and-guard-differential', status: 'building',
    resolvedFirExecution: 'not-run', rawFirExecution: 'not-run', browserCompiler: 'not-built', languageReadiness: false, commands };
async function command(phase, argv, capture = false) {
    const start = performance.now();
    let stdout = '', exitCode = null, signal = null;
    try {
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
                child.once('exit', (code, stopped) => { clearTimeout(timer); signal = stopped; resolve(code); });
            });
        }
        assert.equal(signal, null, phase + ' terminated');
        assert.equal(exitCode, 0, phase + ' failed');
        return stdout;
    } catch (error) {
        if (exitCode === null && Number.isInteger(error.code)) exitCode = error.code;
        if (error.stderr) process.stderr.write(error.stderr.slice(-8192));
        throw error;
    } finally { commands.push({ phase, argv, exitCode, signal, elapsedMs: performance.now() - start }); }
}

try {
    const bootstrap = await verifyBootstrap(options['--bootstrap-cache'] ?? defaultCache);
    const cache = options['--supplemental-source-root'] ? { supplementalSourceRoot: options['--supplemental-source-root'] } : await prepareParserProfileSourceCache();
    const prepared = await prepareParserProfileSources({
        sourceRoot: options['--source-root'] ?? path.join(repository, 'out/kotlin-compiler-port/sources'),
        outputRoot: output, supplementalSourceRoot: cache.supplementalSourceRoot,
    });
    const recipe = prepared.receipt;
    receipt.source = recipe.source;
    receipt.preparation = recipe;
    receipt.bootstrap = { version: bootstrap.lock.version, compilerSourceCommit: bootstrap.lock.compilerSourceCommit,
        artifacts: bootstrap.artifacts.map(({ path: ignored, ...item }) => item) };
    const flagsPath = path.join(here, '../build-flags.json');
    const flagsBytes = await readRegular(flagsPath);
    const flags = JSON.parse(flagsBytes);
    assert.equal(flags.source.commit, recipe.source.commit);
    receipt.compilerFlags = { path: 'compiler-port/build-flags.json', sha256: sha256(flagsBytes), compilerFlags: flags.compilerFlags };
    receipt.toolSources = [];
    for (const name of ['build.mjs', 'prepare.mjs', 'fetch.mjs', 'ParserProfileProbe.kt', 'ParserProfileJvmEntry.kt',
        'ParserProfileWasmEntry.kt', 'OriginalOperations.kt', 'PortableOperations.kt']) {
        const bytes = await readRegular(path.join(here, name));
        receipt.toolSources.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    for (const name of ['original/classes', 'jvm', 'klib', 'wasm']) await mkdir(path.join(output, name), { recursive: true });
    const originalRecord = recipe.declarations.find((record) => record.name === 'KtPsiUtil.unquoteIdentifier');
    const source = (await readRegular(path.join(cache.supplementalSourceRoot, originalRecord.sourcePath))).toString('utf8');
    const exactMethod = source.slice(originalRecord.startUtf16, originalRecord.endUtf16);
    assert.equal(sha256(Buffer.from(exactMethod)), originalRecord.sha256);
    const originalSlice = 'package org.jetbrains.kotlin.portable.parserprofile.reference;\n\n' +
        'public final class OriginalIdentifier {\n' + exactMethod.replace('(@NotNull String quoted)', '(String quoted)') + '\n}\n';
    const originalFile = path.join(output, 'original/OriginalIdentifier.java');
    await writeFile(originalFile, originalSlice, { flag: 'wx', mode: 0o600 });
    receipt.originalJvmSlice = { source: originalRecord, removedAnnotation: 'parameter @NotNull only; algorithm body unchanged',
        generatedBytes: Buffer.byteLength(originalSlice), generatedSha256: sha256(Buffer.from(originalSlice)) };
    const classes = path.join(output, 'original/classes');
    const compiler = ['java', '-Xmx768m', '-cp', bootstrap.classPath];
    const stdlibJvm = bootstrap.artifacts.find((item) => item.id === 'stdlib-jvm').path;
    const jvm = [...compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17',
        '-language-version', '2.5', '-api-version', '2.5', ...flags.compilerFlags];
    const wasm = [...compiler, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js',
        '-language-version', '2.5', '-api-version', '2.5', ...flags.compilerFlags, '-libraries', bootstrap.wasmJsStdlib];
    const helper = prepared.commonSources.find((file) => file.endsWith('/ParserProfile.kt'));
    assert(helper);
    const probe = path.join(here, 'ParserProfileProbe.kt');
    const jvmEntry = path.join(here, 'ParserProfileJvmEntry.kt');
    const portableOperations = path.join(here, 'PortableOperations.kt');
    await command('original-selected-pure-method-javac', ['javac', '-d', classes, originalFile]);
    const originalJar = path.join(output, 'jvm/original.jar');
    await command('original-pure-method-observer-jvm-build', [...jvm, '-classpath', [classes, stdlibJvm].join(path.delimiter), '-d', originalJar,
        helper, probe, path.join(here, 'OriginalOperations.kt'), jvmEntry]);
    const common = [helper, probe, portableOperations];
    const portableJar = path.join(output, 'jvm/portable.jar');
    await command('portable-helper-and-guard-jvm-build', [...jvm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','),
        '-classpath', stdlibJvm, '-d', portableJar, ...common, jvmEntry]);
    const main = 'org.jetbrains.kotlin.portable.parserprofile.probe.ParserProfileJvmEntryKt';
    const original = JSON.parse((await command('original-pure-method-jvm-observe', ['java', '-cp', [classes, originalJar, stdlibJvm].join(path.delimiter), main], true)).trim());
    const portable = JSON.parse((await command('portable-helper-and-guard-jvm-observe', ['java', '-cp', [portableJar, stdlibJvm].join(path.delimiter), main], true)).trim());
    assert.deepEqual(portable, original, 'Portable helper differs from the exact selected Java method');
    await command('portable-helper-and-guard-wasmjs-klib-build', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','),
        '-Xir-produce-klib-file', '-ir-output-dir', path.join(output, 'klib'), '-ir-output-name', 'parser-profile-probe', ...common, path.join(here, 'ParserProfileWasmEntry.kt')]);
    await command('portable-helper-and-guard-wasmjs-binary-build', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(output, 'klib/parser-profile-probe.klib'),
        '-ir-output-dir', path.join(output, 'wasm'), '-ir-output-name', 'parser-profile-probe', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
    const observedWasm = JSON.parse((await command('portable-helper-and-guard-wasmjs-observe', [process.execPath, '--experimental-wasm-exnref', '--input-type=module', '-e',
        'const module = await import(process.argv[1]); console.log(module.parserProfileProbeJson());',
        pathToFileURL(path.join(output, 'wasm/parser-profile-probe.mjs')).href], true)).trim());
    assert.deepEqual(observedWasm, original, 'Portable Wasm helper/guard differs from JVM');
    for (const [name, value] of [['original-jvm.json', original], ['portable-jvm.json', portable], ['portable-wasmjs.json', observedWasm]])
        await writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    receipt.outputs = [];
    for (const name of ['original/OriginalIdentifier.java', 'original/classes/org/jetbrains/kotlin/portable/parserprofile/reference/OriginalIdentifier.class',
        'jvm/original.jar', 'jvm/portable.jar', 'klib/parser-profile-probe.klib', 'original-jvm.json', 'portable-jvm.json', 'portable-wasmjs.json',
        ...(await readdir(path.join(output, 'wasm'))).sort().map((name) => 'wasm/' + name)]) {
        const bytes = await readRegular(path.join(output, name));
        receipt.outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    receipt.comparison = { namedIdentifierCases: original.identifierCases.length, utf16Cases: original.utf16Cases,
        originalSelectedJavaSliceEqualsPortableJvm: true, originalSelectedJavaSliceEqualsPortableWasm: true,
        selectionGuardCases: 2, portableJvmGuardEqualsPortableWasm: true,
        required: original.identifierCases.length + original.utf16Cases + 2, failed: 0, skipped: 0, notRun: 0 };
    receipt.wasmEngine = { kind: 'Node', version: process.version, flags: ['--experimental-wasm-exnref'] };
    receipt.parserEntrySourceVerified = true;
    receipt.actualParserSelectionExecution = 'not-run';
    receipt.browserComparison = 'not-run';
    receipt.limitations = ['The original reference executes the exact selected pure Java method slice, not the full PSI facade.',
        'The browser-only boolean guard is new profile behavior; its JVM/Wasm equality is separate from the original pure-helper comparison.',
        'The actual MultiplatformParsing2Fir constructor and retained checker bodies are source-verified only; no Raw FIR/resolved FIR session was executed.',
        'Wasm component execution used Node; this is not a browser compiler or browser acceptance result.'];
    receipt.status = 'passed';
} catch (error) {
    receipt.status = 'failed';
    receipt.failure = { message: String(error.message).slice(0, 2048), lastPhase: commands.at(-1)?.phase ?? 'preparation' };
    process.exitCode = 1;
} finally {
    await writeFile(path.join(output, 'parser-profile-evidence.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ output, status: receipt.status, comparison: receipt.comparison ?? null, failure: receipt.failure ?? null }));
}
