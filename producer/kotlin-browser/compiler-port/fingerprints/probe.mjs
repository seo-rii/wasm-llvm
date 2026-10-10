import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareCompilerTextSources } from '../text/prepare.mjs';
import { prepareCompilerFingerprints, verifyCompilerFingerprints } from './prepare.mjs';
import { PATHS } from './generate.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const REPO = path.resolve(HERE, '../../../..'); const execute = promisify(execFile);
const METHOD = '        private fun calculateFileFingerprint(ir: KlibIrComponent, fileIndex: Int): FingerprintHash {';
const CONSTRUCTOR = '    constructor(lib: KotlinLibrary, fileIndex: Int) : this(calculateFileFingerprint(lib.irOrFail, fileIndex))\n';

function project(source, lock) {
    let text = source.toString('utf8'); const start = text.indexOf(METHOD), end = text.indexOf('\n        }', start) + '\n        }'.length;
    assert(start >= 0 && end > start); assert.equal(sha256(Buffer.from(text.slice(start, end))), lock.projection.libraryCalculationSha256);
    assert.equal(sha256(Buffer.from(CONSTRUCTOR)), lock.projection.libraryConstructorSha256);
    text = text.slice(0, start) + text.slice(end); assert.equal(text.split(CONSTRUCTOR).length, 2); text = text.replace(CONSTRUCTOR, '');
    for (const name of ['org.jetbrains.kotlin.library.KotlinLibrary', 'org.jetbrains.kotlin.library.components.KlibIrComponent', 'org.jetbrains.kotlin.library.components.irOrFail']) {
        assert.equal(text.split('import ' + name + '\n').length, 2); text = text.replace('import ' + name + '\n', '');
    }
    return Buffer.from(text);
}

export async function runFingerprintsProbe({ sourceRoot, frozenBuildRoot, outputRoot }) {
    const bootstrap = await verifyBootstrap(); const lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
    const frozen = JSON.parse(await readRegular(path.join(frozenBuildRoot, 'compiler-build-receipt.json'), 32 * 1024 * 1024));
    const args = (await readRegular(path.join(frozenBuildRoot, 'compiler-klib.args'), 32 * 1024 * 1024)).toString().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const filenames = args.filter(value => !value.startsWith('-') && value.endsWith('.kt'));
    assert.equal(filenames.length, frozen.compileSources.length);
    const retainedSources = frozen.compileSources.map((pin, index) => ({ ...pin, filename: filenames[index] }));
    await mkdir(outputRoot, { mode: 0o700 }); const prepared = await prepareCompilerFingerprints({ sourceRoot, outputRoot, retainedSources });
    const verified = await verifyCompilerFingerprints(path.dirname(prepared.receiptPath));
    const text = await prepareCompilerTextSources({ sourceRoot, outputRoot });
    const commonText = text.commonSources.filter(file => !file.endsWith('/WasmIrToBinary.kt') && !file.endsWith('/WasmIrToText.kt'));
    const locals = [], commands = [], projections = []; const local = {};
    for (const name of ['FingerprintsProbe.kt', 'JvmEntry.kt', 'WasmEntry.kt']) {
        const bytes = await readRegular(path.join(HERE, name)); local[name] = path.join(outputRoot, name); await writeFile(local[name], bytes, { flag: 'wx', mode: 0o600 });
        locals.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    for (const dir of ['original', 'portable', 'jvm', 'klib', 'wasm']) await mkdir(path.join(outputRoot, dir), { mode: 0o700 });
    const variants = {};
    const carrier = verifyFile(await readRegular(path.join(sourceRoot, lock.projection.carrier.path)), lock.projection.carrier);
    const carrierPath = path.join(outputRoot, 'SerializedDataStructures.kt'); await writeFile(carrierPath, carrier, { flag: 'wx', mode: 0o600 });
    for (const variant of ['original', 'portable']) {
        variants[variant] = [carrierPath, local['FingerprintsProbe.kt']];
        for (const logical of PATHS) {
            let bytes = variant === 'original' ? verifyFile(await readRegular(path.join(sourceRoot, logical)), lock.originals.find(pin => pin.path === logical))
                : await readRegular(path.join(path.dirname(prepared.receiptPath), logical));
            if (logical.endsWith('/FileFingerprints.kt')) bytes = project(bytes, lock);
            const filename = path.join(outputRoot, variant, path.basename(logical)); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
            variants[variant].push(filename); projections.push({ path: variant + '/' + path.basename(logical), bytes: bytes.length, sha256: sha256(bytes) });
        }
        if (variant === 'portable') variants[variant].push(...commonText, prepared.commonSources.find(file => file.endsWith('/FingerprintByteBuffer.kt')));
    }
    async function run(phase, command, args) {
        try {
            const result = await execute(command, args, { cwd: outputRoot, timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
            if (result.stderr) process.stderr.write(result.stderr); commands.push({ phase, command: [command, ...args], exitCode: 0 }); return result.stdout;
        } catch (error) {
            await writeJson(path.join(outputRoot, 'failure.json'), { phase, exitCode: error.code, stderr: String(error.stderr ?? '').slice(-16384) });
            if (error.stderr) process.stderr.write(String(error.stderr).slice(-16384)); throw new Error(phase + ' failed');
        }
    }
    const flags = JSON.parse(await readRegular(path.join(HERE, '../build-flags.json')));
    const stdlibJvm = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path;
    const jvm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', '2.5', '-api-version', '2.5', ...flags.compilerFlags, '-classpath', stdlibJvm];
    const observed = {};
    for (const variant of ['original', 'portable']) {
        const jar = path.join(outputRoot, 'jvm', variant + '.jar');
        await run(variant + '-jvm-build', 'java', [...jvm, ...(variant === 'portable' ? ['-Xmulti-platform', '-Xcommon-sources=' + variants[variant].join(',')] : []), '-d', jar, ...variants[variant], local['JvmEntry.kt']]);
        observed[variant] = await run(variant + '-jvm-observe', 'java', ['-ea', '-cp', [jar, stdlibJvm].join(path.delimiter), 'org.jetbrains.kotlin.backend.common.serialization.probe.JvmEntryKt']);
    }
    assert.equal(observed.portable, observed.original, 'Common JVM differs from original JVM');
    const wasm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-language-version', '2.5', '-api-version', '2.5', ...flags.compilerFlags, '-libraries', bootstrap.wasmJsStdlib];
    await run('portable-wasm-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + variants.portable.join(','), '-Xir-produce-klib-file', '-ir-output-dir', path.join(outputRoot, 'klib'), '-ir-output-name', 'fingerprints-probe', ...variants.portable, local['WasmEntry.kt']]);
    await run('portable-wasm-link', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/fingerprints-probe.klib'), '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'fingerprints-probe', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
    observed.wasm = await run('portable-node-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e', 'const m=await import(process.argv[1]);process.stdout.write(m.fingerprintsProbe());', pathToFileURL(path.join(outputRoot, 'wasm/fingerprints-probe.mjs')).href]);
    assert.equal(observed.wasm, observed.original, 'Wasm differs from original JVM');
    const outputs = [];
    for (const variant of ['original', 'portable', 'wasm']) { const bytes = Buffer.from(observed[variant]); const name = variant + '-observations.txt'; await writeFile(path.join(outputRoot, name), bytes, { flag: 'wx', mode: 0o600 }); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
    for (const name of ['jvm/original.jar', 'jvm/portable.jar', 'klib/fingerprints-probe.klib', ...(await readdir(path.join(outputRoot, 'wasm'))).map(name => 'wasm/' + name)]) {
        const bytes = await readRegular(path.join(outputRoot, name), 32 * 1024 * 1024); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const receipt = { schemaVersion: 1, kind: 'official-memory-compiler-fingerprints-differential', result: 'pass', source: lock.source,
        sourceLockSha256: sha256(await readRegular(path.join(HERE, 'sources.lock.json'))), buildToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
        preparation: verified.receipt, preparationReceiptSha256: verified.receiptSha256,
        actualFrozenBuildReceiptSha256: sha256(await readRegular(path.join(frozenBuildRoot, 'compiler-build-receipt.json'), 32 * 1024 * 1024)),
        bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
        observer: locals, projections, projectionScope: 'Actual SerializedIrFile carrier and complete file/list/hash algorithms; only KotlinLibrary reader overload omitted from probe. Shipping source retains it. Disk APIs are not exercised.',
        commands, outputs, cases: observed.original.trimEnd().split('\n').length,
        comparison: { originalJvmEqualsCommonJvm: true, originalJvmEqualsWasm: true, exceptions: 'IndexOutOfBoundsException with exact message comparison', observationSha256: sha256(Buffer.from(observed.original)) },
        wasmEngine: { kind: 'Node', version: process.version }, browserComparison: 'not-run', fullCompilerBuilt: false, languageReadiness: false };
    await writeJson(path.join(outputRoot, 'differential.json'), receipt); return { receiptPath: path.join(outputRoot, 'differential.json'), cases: receipt.cases, result: 'pass' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const options = {}; for (let i = 2; i < process.argv.length; i += 2) { assert(['--source-root', '--frozen-build-root', '--output'].includes(process.argv[i])); options[process.argv[i]] = process.argv[i + 1]; }
    console.log(JSON.stringify(await runFingerprintsProbe({ sourceRoot: options['--source-root'], frozenBuildRoot: options['--frozen-build-root'], outputRoot: options['--output'] })));
}
