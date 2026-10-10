#!/usr/bin/env node
/** Exact selected Java/common JVM/actual Wasm version-algorithm differential. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { prepareVersionSources } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const execute = promisify(execFile);

export async function buildVersionProbe({ sourceRoot, outputRoot, buildVersionInput, buildVersionInputSha256 }) {
    outputRoot = path.resolve(outputRoot); assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    await assertNoSymlink(outputRoot); await mkdir(outputRoot, { mode: 0o700 });
    const prepared = await prepareVersionSources({ sourceRoot, outputRoot, buildVersionInput, buildVersionInputSha256 });
    const bootstrap = await verifyBootstrap();
    const flagsBytes = await readRegular(path.join(HERE, '../build-flags.json'));
    const flags = JSON.parse(flagsBytes).compilerFlags;
    const observerSources = [];
    for (const name of ['UnicodeReference.java', 'JavaApiProbe.java', 'VersionProbe.kt', 'OriginalAlias.kt', 'CommonAlias.kt', 'JvmEntry.kt', 'WasmEntry.kt']) {
        const bytes = await readRegular(path.join(HERE, name));
        await writeFile(path.join(outputRoot, name), bytes, { flag: 'wx', mode: 0o600 });
        observerSources.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    for (const name of ['java', 'jvm', 'klib', 'wasm', 'java-api-original', 'java-api-common']) await mkdir(path.join(outputRoot, name));
    const commands = [];
    const observed = {};
    async function run(phase, command, args) {
        const started = Date.now();
        try {
            const result = await execute(command, args, { cwd: outputRoot, timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
            if (result.stderr) process.stderr.write(result.stderr);
            commands.push({ phase, command: [command, ...args], exitCode: 0, elapsedMs: Date.now() - started });
            return result.stdout;
        } catch (error) {
            if (error.stderr) process.stderr.write(error.stderr);
            commands.push({ phase, command: [command, ...args], exitCode: error.code, elapsedMs: Date.now() - started });
            throw error;
        }
    }
    const java = prepared.originalSources.filter(name => name.endsWith('.java'));
    const tooling = prepared.originalSources.find(name => name.endsWith('KotlinToolingVersion.kt')); assert(tooling);
    const stdlib = bootstrap.artifacts.find(pin => pin.id === 'stdlib-jvm').path;
    const commonFlags = ['-language-version', '2.5', '-api-version', '2.5', ...flags];
    const compiler = ['-Xmx768m', '-cp', bootstrap.classPath];
    const jvm = [...compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', ...commonFlags];
    const probe = path.join(outputRoot, 'VersionProbe.kt');
    const jvmEntry = path.join(outputRoot, 'JvmEntry.kt');
    const originals = path.join(outputRoot, 'java');
    const originalJar = path.join(outputRoot, 'jvm/original.jar');
    const commonJar = path.join(outputRoot, 'jvm/common.jar');
    let result = 'fail';
    try {
        await run('selected-java-build', 'javac', ['-J-Xmx384m', '-encoding', 'UTF-8', '-cp', bootstrap.classPath, '-d', originals, ...java,
            path.join(outputRoot, 'UnicodeReference.java')]);
        await run('selected-original-jvm-build', 'java', [...jvm, '-classpath', [originals, stdlib].join(path.delimiter), '-d', originalJar,
            tooling, probe, path.join(outputRoot, 'OriginalAlias.kt'), jvmEntry]);
        const common = [...prepared.commonSources, probe, path.join(outputRoot, 'CommonAlias.kt')];
        await run('common-jvm-build', 'java', [...jvm, '-classpath', stdlib, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','),
            '-d', commonJar, ...common, jvmEntry]);
        for (const [label, classPath] of [['original', originals], ['common', commonJar]]) {
            await run(`${label}-real-java-api-client-build`, 'javac', ['-J-Xmx384m', '-encoding', 'UTF-8', '-cp',
                [classPath, stdlib].join(path.delimiter), '-d', path.join(outputRoot, 'java-api-' + label), path.join(outputRoot, 'JavaApiProbe.java')]);
            observed['javaApi' + label] = await run(`${label}-real-java-api-client-observe`, 'java', ['-Xmx256m', '-cp',
                [path.join(outputRoot, 'java-api-' + label), classPath, path.join(outputRoot, 'resources'), stdlib].join(path.delimiter),
                'org.jetbrains.kotlin.portable.versions.probe.JavaApiProbe']);
            await writeFile(path.join(outputRoot, label + '-java-api.txt'), observed['javaApi' + label], { flag: 'wx', mode: 0o600 });
        }
        assert.equal(observed.javaApioriginal, observed.javaApicommon, 'Selected original/common public Java member surface differs');
        const main = 'org.jetbrains.kotlin.portable.versions.probe.JvmEntryKt';
        const locale = ['-Duser.language=tr', '-Duser.country=TR'];
        observed.original = await run('selected-original-jvm-observe', 'java', ['-ea', '-Xmx384m', ...locale, '-cp',
            [originalJar, originals, path.join(outputRoot, 'resources'), stdlib].join(path.delimiter), main]);
        observed.jvm = await run('common-jvm-observe', 'java', ['-ea', '-Xmx384m', ...locale, '-cp', [commonJar, stdlib].join(path.delimiter), main]);
        await writeFile(path.join(outputRoot, 'original-jvm.txt'), observed.original, { flag: 'wx', mode: 0o600 });
        await writeFile(path.join(outputRoot, 'common-jvm.txt'), observed.jvm, { flag: 'wx', mode: 0o600 });
        const difference = (expected, actual) => {
            const left = expected.split('\n'), right = actual.split('\n'), differences = [];
            for (let index = 0; index < Math.max(left.length, right.length); index++) if (left[index] !== right[index]) {
                differences.push({ index, original: left[index]?.slice(0, 200), common: right[index]?.slice(0, 200) });
                if (differences.length >= 8) break;
            }
            return differences;
        };
        const jvmDifferences = difference(observed.original, observed.jvm);
        if (jvmDifferences.length) { console.error(JSON.stringify({ jvmDifferences })); throw new Error('Selected Java/common JVM version algorithms differ'); }
        const wasm = [...compiler, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js',
            '-libraries', bootstrap.wasmJsStdlib, ...commonFlags];
        await run('common-wasmjs-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','),
            '-Xir-produce-klib-file', '-ir-output-dir', path.join(outputRoot, 'klib'), '-ir-output-name', 'compiler-versions',
            ...common, path.join(outputRoot, 'WasmEntry.kt')]);
        await run('common-wasmjs-binary-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/compiler-versions.klib'),
            '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'compiler-versions', '-main', 'noCall',
            '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
        observed.wasm = await run('common-node-wasmjs-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
            'const m = await import(process.argv[1]); process.stdout.write(m.versionProbeSnapshot());',
            pathToFileURL(path.join(outputRoot, 'wasm/compiler-versions.mjs')).href]);
        await writeFile(path.join(outputRoot, 'common-wasmjs.txt'), observed.wasm, { flag: 'wx', mode: 0o600 });
        const wasmDifferences = difference(observed.original, observed.wasm);
        if (wasmDifferences.length) { console.error(JSON.stringify({ wasmDifferences })); throw new Error('Selected Java/common Wasm version algorithms differ'); }
        result = 'pass';
    } finally {
        const outputs = [];
        const names = ['original-jvm.txt', 'common-jvm.txt', 'common-wasmjs.txt', 'original-java-api.txt', 'common-java-api.txt',
            'jvm/original.jar', 'jvm/common.jar', 'klib/compiler-versions.klib'];
        for (const entry of await readdir(path.join(outputRoot, 'wasm'), { withFileTypes: true })) {
            assert(entry.isFile()); names.push('wasm/' + entry.name);
        }
        for (const name of names.sort()) {
            try { const bytes = await readRegular(path.join(outputRoot, name), 16 * 1024 * 1024); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const lines = observed.original?.trimEnd().split('\n');
        const receipt = { schemaVersion: 1, kind: 'official-version-java-common-differential', result, source: prepared.receipt.source,
            sourceLockSha256: prepared.receipt.sourceLockSha256, preparation: prepared.receipt,
            preparationReceiptSha256: sha256(await readRegular(prepared.receiptPath)),
            verificationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
            buildFlagsSha256: sha256(flagsBytes), observerSources, commands, outputs,
            bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null,
                artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
            comparison: { observations: lines?.length ?? null, originalJvmEqualsCommonJvm: observed.original !== undefined && observed.original === observed.jvm,
                originalJvmEqualsCommonWasm: observed.original !== undefined && observed.original === observed.wasm,
                originalSha256: observed.original === undefined ? null : sha256(Buffer.from(observed.original)),
                unicodeSingleCodePoints: 0x110000, sigmaContexts: 3 * 65536,
                realJavaApiObservations: observed.javaApioriginal?.trimEnd().split('\n').length ?? null,
                originalPublicJavaApiEqualsCommonJvm: observed.javaApioriginal !== undefined && observed.javaApioriginal === observed.javaApicommon,
                exactFullComparison: 'Full UTF-16 mapping outputs, complete BMP Sigma masks and comparison return/equals/hash observations; no expected response emitter.' },
            runtime: { javaUnicodeOrigin: prepared.receipt.unicodePolicyOrigin.jdkRuntimeVersion, configuredJvmDefaultLocale: 'tr_TR',
                wasmEngine: 'Node', nodeVersion: process.version, flags: ['--experimental-wasm-exnref'] }, browserComparison: 'not-run',
            limitations: ['This is a real official version-helper boundary port; it does not establish a complete browser compiler or KLIB compatibility gate.',
                'The CI policy data is pinned to the actual JDK17 reference. It is not a claim that all future JDKs share its Unicode policy.',
                'Compiler resource filtering follows pinned rule + explicit input; a full upstream Gradle ProcessResources build is not run.',
                'The original nullable @snapshot@ getVersion branch is kept but not accepted as a production C resource.',
                'The selected source preserves case-insensitive tooling equality and original case-sensitive hash behavior; no adjacent correction is made.',
                'Only actual generic version methods are tested; KLIB ABI/metadata/IR checks are not bypassed or counted as passed.'],
            fullCompilerBuilt: false, freshBrowserSourceCompilation: 'not-run', readiness: false };
        await writeJson(path.join(outputRoot, 'differential-receipt.json'), receipt);
    }
    return { outputRoot, result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const args = process.argv.slice(2), options = {};
        for (let index = 0; index < args.length; index += 2) {
            assert(['--source-root', '--output', '--version-input', '--version-input-sha256'].includes(args[index]) && args[index + 1] && !options[args[index]]);
            options[args[index]] = args[index + 1];
        }
        const result = await buildVersionProbe({ sourceRoot: options['--source-root'], outputRoot: options['--output'],
            buildVersionInput: options['--version-input'], buildVersionInputSha256: options['--version-input-sha256'] });
        console.log(JSON.stringify({ ...result, readiness: false }));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
