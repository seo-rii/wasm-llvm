#!/usr/bin/env node
/** Compare actual selected message sources on JVM and their common Wasm host. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { prepareCompilerMessageSources } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);

export async function buildCompilerMessageProbe({ sourceRoot, outputRoot }) {
    outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    await assertNoSymlink(outputRoot);
    await mkdir(path.dirname(outputRoot), { recursive: true, mode: 0o700 });
    await mkdir(outputRoot, { mode: 0o700 });
    const prepared = await prepareCompilerMessageSources({ sourceRoot, outputRoot });
    const bootstrap = await verifyBootstrap();
    const flagBytes = await readRegular(path.join(here, '../build-flags.json'));
    const flags = JSON.parse(flagBytes);
    assert.equal(flags.source.commit, prepared.receipt.source.commit);
    const observers = [];
    for (const name of ['MessageProbe.kt', 'JvmEntry.kt', 'WasmEntry.kt']) {
        const bytes = await readRegular(path.join(here, name));
        await writeFile(path.join(outputRoot, name), bytes, { flag: 'wx', mode: 0o600 });
        observers.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    for (const dir of ['jvm', 'klib', 'wasm']) await mkdir(path.join(outputRoot, dir));
    const commands = [];
    async function run(phase, command, args) {
        const result = await execute(command, args, { cwd: outputRoot, timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
        if (result.stderr) process.stderr.write(result.stderr);
        commands.push({ phase, command: [command, ...args], exitCode: 0 });
        return result.stdout;
    }
    const compiler = ['-Xmx768m', '-cp', bootstrap.classPath];
    const commonFlags = ['-language-version', '2.5', '-api-version', '2.5', ...flags.compilerFlags];
    const stdlib = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path;
    const jvm = [...compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17',
        '-jvm-default', 'no-compatibility', ...commonFlags, '-classpath', stdlib];
    const probe = path.join(outputRoot, 'MessageProbe.kt');
    const jvmEntry = path.join(outputRoot, 'JvmEntry.kt');
    const originalJar = path.join(outputRoot, 'jvm/original.jar');
    const commonJar = path.join(outputRoot, 'jvm/common.jar');
    await run('selected-original-jvm-build', 'java', [...jvm, '-d', originalJar, ...prepared.originalSources, probe, jvmEntry]);
    const common = [...prepared.commonSources, probe];
    await run('common-jvm-build', 'java', [...jvm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-d', commonJar, ...common, jvmEntry]);
    const main = 'org.jetbrains.kotlin.portable.messages.probe.JvmEntryKt';
    const original = await run('selected-original-jvm-observe', 'java', ['-ea', '-Xmx256m', '-cp', [originalJar, stdlib].join(path.delimiter), main]);
    const observedJvm = await run('common-jvm-observe', 'java', ['-ea', '-Xmx256m', '-cp', [commonJar, stdlib].join(path.delimiter), main]);
    assert.equal(observedJvm, original, 'Original/common JVM compiler messages differ');
    const wasm = [...compiler, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js',
        '-libraries', bootstrap.wasmJsStdlib, ...commonFlags];
    await run('common-wasmjs-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','),
        '-Xir-produce-klib-file', '-ir-output-dir', path.join(outputRoot, 'klib'), '-ir-output-name', 'compiler-messages',
        ...common, path.join(outputRoot, 'WasmEntry.kt')]);
    await run('common-wasmjs-binary-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/compiler-messages.klib'),
        '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'compiler-messages', '-main', 'noCall',
        '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
    const observedWasm = await run('common-node-wasmjs-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
        'const m = await import(process.argv[1]); process.stdout.write(m.compilerMessageProbe());',
        pathToFileURL(path.join(outputRoot, 'wasm/compiler-messages.mjs')).href]);
    assert.equal(observedWasm, original, 'Original JVM/common Wasm compiler messages differ');
    const outputs = [];
    for (const [name, text] of [['original-jvm.txt', original], ['common-jvm.txt', observedJvm], ['common-wasmjs.txt', observedWasm]]) {
        await writeFile(path.join(outputRoot, name), text, { flag: 'wx', mode: 0o600 });
    }
    const files = ['jvm/original.jar', 'jvm/common.jar', 'klib/compiler-messages.klib', 'original-jvm.txt', 'common-jvm.txt', 'common-wasmjs.txt'];
    for (const entry of await readdir(path.join(outputRoot, 'wasm'), { withFileTypes: true })) {
        assert(entry.isFile()); files.push('wasm/' + entry.name);
    }
    for (const name of files.sort()) {
        const bytes = await readRegular(path.join(outputRoot, name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const receipt = { schemaVersion: 1, kind: 'official-compiler-message-host-differential', source: prepared.receipt.source,
        sourceLockSha256: prepared.receipt.sourceLockSha256, preparationReceiptSha256: sha256(await readRegular(prepared.receiptPath)),
        buildToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), buildFlagsSha256: sha256(flagBytes), observers,
        bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null,
            artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) }, commands, outputs,
        comparison: { observations: original.split('\n').length, originalJvmEqualsCommonJvm: true, originalJvmEqualsCommonWasm: true,
            observationSha256: sha256(Buffer.from(original)), scope: 'Actual compiler message/severity/location/collector source; not parser/FIR or whole compiler acceptance.' },
        wasmEngine: { kind: 'Node', version: process.version, flags: ['--experimental-wasm-exnref'] }, browserComparison: 'not-run',
        fullCompilerBuilt: false, freshBrowserSourceCompilation: 'not-run', publicLanguageSupport: false };
    await writeJson(path.join(outputRoot, 'receipt.json'), receipt);
    return { outputRoot, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const args = process.argv.slice(2), options = {};
        for (let index = 0; index < args.length; index += 2) {
            assert(['--source-root', '--output'].includes(args[index]) && args[index + 1] && !options[args[index]]);
            options[args[index]] = args[index + 1];
        }
        assert(options['--source-root'] && options['--output']);
        const result = await buildCompilerMessageProbe({ sourceRoot: options['--source-root'], outputRoot: options['--output'] });
        console.log(JSON.stringify({ outputRoot: result.outputRoot, comparison: result.receipt.comparison, publicLanguageSupport: false }));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
