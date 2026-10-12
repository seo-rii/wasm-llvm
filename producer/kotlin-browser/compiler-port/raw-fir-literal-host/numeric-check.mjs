import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { TARGET, extractLiteralHelpers } from './transform.mjs';
import { prepareRawFirLiteralSourceCache } from './fetch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), execute = promisify(execFile);
assert.equal(process.argv.length, 3, 'Usage: check.mjs NEW_OUTPUT_ROOT');
const output = path.resolve(process.argv[2]); assert(output.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(output, { mode: 0o700 });
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources'), local = name => path.join(output, name);
const bootstrap = await verifyBootstrap(), commands = [], inputs = [], adapters = [];
async function store(name, bytes) { const filename = local(name); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename; }
for (const name of ['NumericProbe.kt', 'NumericJvmEntry.kt', 'NumericWasmEntry.kt', 'RawFirLiteralHelpers.kt', 'numeric-check.mjs', 'prepare.mjs', 'transform.mjs', 'sources.lock.json']) {
    const bytes = await readRegular(path.join(HERE, name)); inputs.push({ path: path.join(HERE, name), bytes: bytes.length, sha256: sha256(bytes) });
    if (name.endsWith('.kt')) await store(name, bytes);
}
const compiler = bootstrap.artifacts.find(pin => pin.id === 'compiler').path;
for (const directory of ['jvm', 'klib', 'wasm']) await mkdir(local(directory));
async function run(phase, binary, args) {
    console.log('phase: ' + phase);
    const argName = phase + '.arguments.json'; await store(argName, Buffer.from(JSON.stringify([binary, ...args], null, 2) + '\n'));
    try {
        const result = await execute(binary, args, { cwd: output, timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
        commands.push({ phase, command: [binary, ...args], argumentFileSha256: sha256(await readRegular(local(argName))), exitCode: 0 });
        if (result.stderr) process.stderr.write(result.stderr); return result.stdout;
    } catch (error) {
        await writeJson(local('failure.json'), { phase, exitCode: error.code, stderr: String(error.stderr ?? '').slice(-12000), commands });
        if (error.stderr) process.stderr.write(String(error.stderr).slice(-12000)); throw new Error(phase + ' failed');
    }
}
const java = ['-Xmx768m', '-cp', bootstrap.classPath], stdlib = bootstrap.artifacts.find(pin => pin.id === 'stdlib-jvm').path;
const flagsBytes = await readRegular(path.join(HERE, '../build-flags.json')), flags = JSON.parse(flagsBytes);
inputs.push({ path: path.join(HERE, '../build-flags.json'), bytes: flagsBytes.length, sha256: sha256(flagsBytes) });
const compilerFlags = ['-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
const jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', ...compilerFlags];
const sourceLock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json'))), cache = await prepareRawFirLiteralSourceCache();
const supplemental = [];
for (const pin of sourceLock.supplementalSources) {
    const bytes = await readRegular(path.join(cache.sourceRoot, pin.path)); supplemental.push(bytes);
    inputs.push({ path: path.join(cache.sourceRoot, pin.path), bytes: bytes.length, sha256: sha256(bytes) });
}
const numbersBytes = await readRegular(path.join(sourceRoot, sourceLock.numbers.path));
inputs.push({ path: path.join(sourceRoot, sourceLock.numbers.path), bytes: numbersBytes.length, sha256: sha256(numbersBytes) });
const numbers = await store('numbers.kt', numbersBytes);
const commonHelper = local('RawFirLiteralHelpers.kt'), originalHelper = await store('original-helpers.kt', extractLiteralHelpers(...supplemental, false));
const parserBytes = await readRegular(path.join(HERE, '../parser-profile/ParserProfile.kt'));
inputs.push({ path: path.join(HERE, '../parser-profile/ParserProfile.kt'), bytes: parserBytes.length, sha256: sha256(parserBytes) });
const parser = await store('ParserProfile.kt', parserBytes), probe = local('NumericProbe.kt');
const observed = {};
for (const [label, helper] of [['original', originalHelper], ['common', commonHelper]]) {
    await run(label + '-full-pure-helpers-jvm-build', 'java', [...jvm, '-classpath', [stdlib, compiler].join(path.delimiter), '-d', local('jvm/' + label + '.jar'),
        helper, parser, numbers, probe, local('NumericJvmEntry.kt')]);
    observed[label] = await run(label + '-numeric-jvm-observe', 'java', ['-ea', '-cp', [local('jvm/' + label + '.jar'), stdlib, compiler].join(path.delimiter),
        'org.jetbrains.kotlin.portable.rawfir.probe.NumericJvmEntryKt']);
    await store(label + '-observations.txt', Buffer.from(observed[label]));
}
assert.equal(observed.common, observed.original, 'Original Java/common JVM pure helper observations differ');
const common = [commonHelper, parser, numbers, probe];
const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-libraries', bootstrap.wasmJsStdlib, ...compilerFlags];
await run('full-pure-helpers-wasm-klib', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-ir-output-dir', local('klib'), '-ir-output-name', 'raw-fir-literal', ...common, local('NumericWasmEntry.kt')]);
await run('full-pure-helpers-wasm-link', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + local('klib/raw-fir-literal.klib'), '-ir-output-dir', local('wasm'), '-ir-output-name', 'raw-fir-literal', '-main', 'noCall']);
observed.wasm = await run('numeric-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const m=await import(process.argv[1]);process.stdout.write(m.numericObservation());', pathToFileURL(local('wasm/raw-fir-literal.mjs')).href]);
await store('wasm-observations.txt', Buffer.from(observed.wasm));
const classNameObservation = await run('common-class-name-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const m=await import(process.argv[1]);process.stdout.write(m.classNameBoundary());', pathToFileURL(local('wasm/raw-fir-literal.mjs')).href]);
await store('class-name-observation.txt', Buffer.from(classNameObservation));
if (observed.wasm !== observed.original) {
    const left = observed.original.split('\n'), right = observed.wasm.split('\n'), mismatch = [];
    for (let index = 0; index < Math.max(left.length, right.length); index++) if (left[index] !== right[index]) mismatch.push({ index, original: left[index], wasm: right[index], preceding: left.slice(Math.max(0, index - 2), index) });
    await writeJson(local('mismatches.json'), mismatch); throw new Error('Original JVM/common Node-Wasm helper differences: ' + mismatch.length);
}
for (const pin of inputs) { const bytes = await readRegular(pin.path); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'Numeric proof input changed'); }
const artifacts = [];
async function collect(directory) { for (const entry of await readdir(local(directory), { withFileTypes: true })) {
    const name = directory ? directory + '/' + entry.name : entry.name;
    if (entry.isDirectory()) await collect(name);
    else { const bytes = await readRegular(local(name), 32 * 1024 * 1024); artifacts.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
} }
await collect(''); const records = observed.original.trimEnd().split('\n');
await writeJson(local('receipt.json'), { schemaVersion: 1, kind: 'genuine-raw-fir-pure-literal-jvm-wasm-differential', source: sourceLock.source,
    sourceLockSha256: sha256(await readRegular(path.join(HERE, 'sources.lock.json'))), inputs, artifacts, commands,
    comparison: { records: records.length, originalJvmEqualsCommonJvm: true, originalJvmEqualsNodeWasm: true, rawSha256: sha256(Buffer.from(observed.original)), normalizedText: false },
    bootstrap: { version: bootstrap.lock.version, sourceCommit: null },
    scope: 'Complete extracted genuine pure helper declarations and suffix/boolean wrappers; decimal/hex/binary integral signed/unsigned bounds and bits, Float/Double raw bits, extrema/subnormals/rounding/overflow, underscore/suffix/malformed candidate diagnostics and existing genuine identifier unquoting.',
    classNameBoundary: { observation: classNameObservation, jvmBinaryNameParity: false },
    fullRawFirBuilderWasmExecuted: false, universalJavaNumberStringParity: false, fullCompilerBuilt: false, languageReadiness: false });
console.log(JSON.stringify({ records: records.length, rawSha256: sha256(Buffer.from(observed.original)), commands: commands.length }));
