import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { prepareNullConstantValue, verifyNullConstantValue } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const execute = promisify(execFile); assert.equal(process.argv.length, 3);
const outputRoot = path.resolve(process.argv[2]); assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
await mkdir(outputRoot, { mode: 0o700 });
const prepared = await prepareNullConstantValue({ sourceRoot: path.join(repository, 'out/kotlin-compiler-port/sources'), outputRoot: path.join(outputRoot, 'prepared') });
const verified = await verifyNullConstantValue(prepared.outputRoot), bootstrap = await verifyBootstrap();
const flagsBytes = await readRegular(path.join(here, '../build-flags.json')), flags = JSON.parse(flagsBytes);
const commands = [], artifacts = [], raw = {};
async function record(filename) { const bytes = await readRegular(filename); artifacts.push({ path: path.relative(outputRoot, filename), bytes: bytes.length, sha256: sha256(bytes) }); }
async function run(phase, args) {
    console.log('phase: ' + phase); const started = performance.now();
    try {
        const result = await execute('java', args, { cwd: outputRoot, timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
        commands.push({ phase, command: ['java', ...args], exitCode: 0, elapsedMs: performance.now() - started });
        if (result.stderr) process.stderr.write(result.stderr); return result.stdout;
    } catch (error) {
        await writeJson(path.join(outputRoot, 'failure.json'), { phase, exitCode: error.code, killed: error.killed,
            signal: error.signal, commands, stderr: String(error.stderr ?? '').slice(-12000) });
        if (error.stderr) process.stderr.write(String(error.stderr).slice(-12000));
        throw new Error(phase + ' failed; exit=' + error.code + '; killed=' + error.killed);
    }
}
const compiler = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
    '-jvm-target', '17', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags, '-classpath', bootstrap.classPath];
const observer = path.join(outputRoot, 'Probe.kt'); await writeFile(observer, await readRegular(path.join(here, 'Probe.kt')), { flag: 'wx', mode: 0o600 });
await record(observer);
for (const [variant, source] of [
    ['original', path.join(prepared.outputRoot, 'reference', prepared.receipt.originals[0].path)],
    ['common', prepared.commonSources[0]],
]) {
    const jar = path.join(outputRoot, variant + '.jar');
    await run(variant + '-full-constant-source-jvm-build', [...compiler, '-d', jar, source, observer]); await record(jar);
    raw[variant] = await run(variant + '-genuine-null-constant-jvm-observe', ['-ea', '-cp', jar + path.delimiter + bootstrap.classPath,
        'org.jetbrains.kotlin.portable.nullconstant.probe.ProbeKt']);
    const output = path.join(outputRoot, variant + '.txt'); await writeFile(output, raw[variant], { flag: 'wx', mode: 0o600 }); await record(output);
}
assert.equal(raw.original, raw.common, 'Actual complete constant source observations differ');
assert.equal(raw.original.trimEnd().split('\n').length, 2048);
await verifyNullConstantValue(prepared.outputRoot);
const localFiles = [];
for (const filename of ['prepare.mjs', 'sources.lock.json', 'Probe.kt', 'probe.mjs', 'integrity.test.mjs', 'README.md']) {
    const bytes = await readRegular(path.join(here, filename)); localFiles.push({ path: filename, bytes: bytes.length, sha256: sha256(bytes) });
}
const preparationFiles = [];
for (const filename of [prepared.receiptPath, ...prepared.commonSources, ...prepared.receipt.originals.map(pin => path.join(prepared.outputRoot, 'reference', pin.path))]) {
    const bytes = await readRegular(filename); preparationFiles.push({ path: path.relative(outputRoot, filename), bytes: bytes.length, sha256: sha256(bytes) });
}
await writeJson(path.join(outputRoot, 'differential.json'), { schemaVersion: 1, kind: 'genuine-null-constant-source-differential', result: 'pass',
    source: prepared.receipt.source, preparation: prepared.receipt, preparationReceiptSha256: verified.receiptSha256,
    commands, artifacts, preparationFiles, localFiles, observations: 2048, originalSha256: sha256(Buffer.from(raw.original)), commonSha256: sha256(Buffer.from(raw.common)),
    fullOriginalAndCommonSourceCompiled: true, actualBuiltinsAndModule: true, visitor: 'Observer proxy implements the genuine JVM interface; records receiver/data identity and dispatch count',
    flagsSha256: sha256(flagsBytes), bootstrap: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    normalizedText: false, genericReflectiveSignatureParity: false, fullConstantsWasmExecuted: false, fullCompilerBuilt: false, publicLanguageSupport: false });
console.log(JSON.stringify({ result: 'pass', observations: 2048, outputRoot, fullCompilerBuilt: false }));
