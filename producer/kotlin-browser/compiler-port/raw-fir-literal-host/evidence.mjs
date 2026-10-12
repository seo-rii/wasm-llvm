import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { TARGET, RECIPE, NUMERIC_RECIPE, transformRawFirLiteral, extractLiteralHelpers } from './transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
assert.equal(process.argv.length, 6, 'Usage: evidence.mjs TYPECHECK_JOB NUMERIC_JOB BUILDER_METHODS_JOB GUARDS_JOB');
async function pin(filename) {
    const bytes = await readRegular(filename, 64 * 1024 * 1024);
    return { path: filename, bytes: bytes.length, sha256: sha256(bytes) };
}
async function verify(filename, expected) {
    const actual = await pin(filename);
    assert.equal(actual.bytes, expected.bytes); assert.equal(actual.sha256, expected.sha256, filename);
}
async function artifacts(root) {
    const result = [];
    async function collect(directory) {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const filename = path.join(directory, entry.name);
            if (entry.isDirectory()) await collect(filename);
            else result.push(await pin(filename));
        }
    }
    await collect(root); return result;
}
const scripts = ['typecheck.mjs', 'numeric-check.mjs', 'fir-runtime.mjs', 'integrity.test.mjs'];
const labels = ['typecheck', 'numeric', 'builder-methods', 'integrity'], jobs = [];
for (const [index, filename] of process.argv.slice(2).entries()) {
    const manifest = JSON.parse(await readRegular(filename)), status = JSON.parse(await readRegular(manifest.status));
    assert.equal(status.state, 'exited'); assert.equal(status.exitCode, 0); assert.equal(status.pid, manifest.pid);
    assert(manifest.output.startsWith(path.join(REPO, 'out') + path.sep));
    assert(manifest.log.startsWith('/home/seorii/logs/')); assert(manifest.status.startsWith('/home/seorii/logs/'));
    assert.equal(manifest.argv.length, 3); assert.equal(manifest.argv[0], process.execPath);
    assert.equal(manifest.argv[1], 'producer/kotlin-browser/compiler-port/raw-fir-literal-host/' + scripts[index]);
    assert.equal(manifest.argv[2], manifest.output);
    const receiptBytes = await readRegular(path.join(manifest.output, 'receipt.json')), receipt = JSON.parse(receiptBytes);
    jobs.push({ manifest, status, receipt, receiptBytes,
        execution: await Promise.all([filename, manifest.status, manifest.log, manifest.runner].map(pin)),
        artifactPins: await artifacts(manifest.output) });
}
const [typecheck, numeric, methods, guards] = jobs;
const sourceLockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(sourceLockBytes);
assert.deepEqual(lock.recipe, RECIPE); assert.deepEqual(lock.numericRecipe, NUMERIC_RECIPE);
for (const dependency of lock.dependencies) verifyFile(await readRegular(path.resolve(HERE, dependency.path)), dependency);
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const original = verifyFile(await readRegular(path.join(sourceRoot, TARGET)), lock.original);
const common = verifyFile(transformRawFirLiteral(original), lock.output);
const helper = verifyFile(await readRegular(path.join(HERE, 'RawFirLiteralHelpers.kt')), lock.helpers);
const numbers = verifyFile(await readRegular(path.join(sourceRoot, lock.numbers.path)), lock.numbers);
const parser = await readRegular(path.join(HERE, '../parser-profile/ParserProfile.kt'));
assert.equal(typecheck.receipt.kind, 'genuine-complete-raw-fir-builder-jvm-typecheck');
assert.equal(typecheck.receipt.originalAndCommonCompleteSourcesCompiled, true);
assert.equal(typecheck.receipt.bootstrapSourceCommit, null);
assert.equal(typecheck.receipt.sourceLockSha256, sha256(sourceLockBytes));
for (const [name, bytes] of [['original.kt', Buffer.from(original.toString().replaceAll('import com.intellij.', 'import org.jetbrains.kotlin.com.intellij.'))],
    ['common.kt', common], ['RawFirLiteralHelpers.kt', helper], ['numbers.kt', numbers], ['ParserProfile.kt', parser]]) {
    assert.deepEqual(await readRegular(path.join(typecheck.manifest.output, name)), bytes, name);
}
async function commands(job, count, argumentName) {
    assert.equal(job.receipt.commands.length, count);
    for (const command of job.receipt.commands) {
        assert.equal(command.exitCode, 0);
        const bytes = await readRegular(path.join(job.manifest.output, argumentName(command)));
        assert.deepEqual(JSON.parse(bytes), command.command);
        if (command.argumentFileSha256) assert.equal(sha256(bytes), command.argumentFileSha256);
    }
}
await commands(typecheck, 2, command => command.phase + '-arguments.json');
await commands(numeric, 8, command => command.phase + '.arguments.json');
await commands(methods, 4, command => command.phase + '.arguments.json');
assert.equal(numeric.receipt.kind, 'genuine-raw-fir-pure-literal-jvm-wasm-differential');
assert.equal(numeric.receipt.sourceLockSha256, sha256(sourceLockBytes));
for (const input of numeric.receipt.inputs) await verify(input.path, input);
for (const artifact of numeric.receipt.artifacts) await verify(path.join(numeric.manifest.output, artifact.path), artifact);
const supplemental = [];
for (const source of lock.supplementalSources) {
    const input = numeric.receipt.inputs.find(row => row.path.endsWith('/' + source.path));
    assert(input, 'Missing genuine supplemental numeric input');
    supplemental.push(verifyFile(await readRegular(input.path), source));
}
assert.deepEqual(extractLiteralHelpers(...supplemental), helper);
assert.deepEqual(await readRegular(path.join(numeric.manifest.output, 'original-helpers.kt')), extractLiteralHelpers(...supplemental, false));
assert.equal(numeric.receipt.comparison.records, 19735);
assert.equal(numeric.receipt.comparison.rawSha256, '7774520e01ea7988e889cb9f7fe34fb92f475304af5767a5eee125e6bb1f052d');
assert.equal(numeric.receipt.comparison.originalJvmEqualsCommonJvm, true);
assert.equal(numeric.receipt.comparison.originalJvmEqualsNodeWasm, true);
assert.equal(numeric.receipt.classNameBoundary.jvmBinaryNameParity, false);
assert.deepEqual(await readRegular(path.join(numeric.manifest.output, 'class-name-observation.txt')), Buffer.from(numeric.receipt.classNameBoundary.observation));
assert.equal(numeric.receipt.classNameBoundary.observation, 'org.jetbrains.kotlin.portable.rawfir.probe.NamedClassBoundary|<anonymous>');
assert.equal(numeric.receipt.universalJavaNumberStringParity, false);
assert.equal(numeric.receipt.fullRawFirBuilderWasmExecuted, false);
assert.equal(methods.receipt.kind, 'genuine-full-raw-fir-builder-methods-jvm-differential');
assert.equal(methods.receipt.typecheckReceiptSha256, sha256(typecheck.receiptBytes));
assert.equal(methods.receipt.genuineFullBuilderAndFirObjectsExecuted, true);
assert.equal(methods.receipt.typedNodeAndLightTreeSourceCallbacksOutsideCompilerPackages, true);
assert.equal(methods.receipt.fullFirPipeline, false); assert.equal(methods.receipt.fullRawFirBuilderWasmExecuted, false);
await verify(methods.receipt.observer.path, methods.receipt.observer);
assert.equal(methods.receipt.observer.path, path.join(HERE, 'FirJvmProbe.kt'));
assert.equal(methods.receipt.comparison.records, 720);
assert.equal(methods.receipt.comparison.rawSha256, '5a976b4d561285b3bcf1592dbddf6c1bc82a558251f795d0ed8876882f70dd8e');
assert.equal(methods.receipt.comparison.originalJvmEqualsCommonJvm, true);
for (const job of [numeric, methods]) {
    assert.equal(job.receipt.comparison.normalizedText, false);
    for (const host of job === numeric ? ['original', 'common', 'wasm'] : ['original', 'common']) {
        const bytes = await readRegular(path.join(job.manifest.output, host + '-observations.txt'));
        assert.equal(sha256(bytes), job.receipt.comparison.rawSha256);
        assert.equal(bytes.toString().trimEnd().split('\n').length, job.receipt.comparison.records);
    }
}
assert.equal(guards.receipt.kind, 'genuine-raw-fir-literal-integrity'); assert.equal(guards.receipt.result, 'pass');
assert.equal(guards.receipt.historical.selectedSources, 3540); assert.equal(guards.receipt.finalSources, 3541);
assert.deepEqual(guards.receipt.passed, ['full-builder-roundtrip', 'actual-selection-positive', 'body-negatives-restored',
    'receipt-snapshot-negatives-restored', 'owner-negatives-restored', 'late-assembly-negatives-restored', 'node-profile-negatives-restored', 'roots-cache-negatives']);
for (const input of guards.receipt.inputs) await verify(input.path, input);
assert.equal(guards.receipt.originalInventory.length, 3540);
for (let offset = 0; offset < guards.receipt.originalInventory.length; offset += 24) {
    const checked = await Promise.allSettled(guards.receipt.originalInventory.slice(offset, offset + 24).map(input => verify(input.filename, input)));
    for (const result of checked) if (result.status !== 'fulfilled') throw result.reason;
}
for (const job of jobs) assert.equal(job.receipt.fullCompilerBuilt, false);
const lexerPath = 'compiler/multiplatform-parsing/common/src/org/jetbrains/kotlin/kmp/lexer/Kotlin.flex';
const upstreamLock = JSON.parse(await readRegular(path.join(HERE, '../../sources.lock.json')));
const lexerPin = upstreamLock.files.find(row => row.path === lexerPath); assert(lexerPin);
const lexerFilename = path.join(REPO, 'out/kotlin-parser-probe/sources', lexerPath), lexer = verifyFile(await readRegular(lexerFilename), lexerPin);
assert(lexer.toString().includes('DIGIT=[0-9]\n')); assert(lexer.toString().includes('HEX_DIGIT=[0-9A-Fa-f]\n'));
const bootstrap = await verifyBootstrap();
assert.equal(bootstrap.lock.version, '2.5.0-dev-10106'); assert.equal(bootstrap.lock.compilerSourceCommit, null);
const currentFiles = ['transform.mjs', 'RawFirLiteralHelpers.kt', 'prepare.mjs', 'fetch.mjs', 'sources.lock.json', 'fixture.mjs',
    'typecheck.mjs', 'NumericProbe.kt', 'NumericJvmEntry.kt', 'NumericWasmEntry.kt', 'numeric-check.mjs', 'FirJvmProbe.kt',
    'fir-runtime.mjs', 'integrity.test.mjs', 'evidence.mjs', 'README.md'];
const current = await Promise.all(currentFiles.map(name => pin(path.join(HERE, name))));
const sharedInputs = await Promise.all(['../../build/bootstrap.mjs', '../../build/bootstrap.lock.json', '../build-flags.json',
    '../../sources.lock.json', '../../manifest.json', '../closure.lock.json'].map(name => pin(path.resolve(HERE, name))));
const evidenceRoot = path.join(HERE, 'evidence'); await mkdir(evidenceRoot, { mode: 0o700 });
for (const [index, job] of jobs.entries()) await writeFile(path.join(evidenceRoot, labels[index] + '.json'), job.receiptBytes, { flag: 'wx', mode: 0o600 });
await writeJson(path.join(evidenceRoot, 'executions.json'), {
    schemaVersion: 1, kind: 'genuine-raw-fir-literal-host-evidence-executions', sourceLockSha256: sha256(sourceLockBytes),
    executions: await Promise.all(jobs.map(async (job, index) => ({ label: labels[index], ...job.manifest, statusResult: job.status,
        pins: job.execution, receipt: await pin(path.join(job.manifest.output, 'receipt.json')), artifacts: job.artifactPins }))),
    current, sharedInputs, bootstrap: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts },
    numericGrammar: { lexer: { ...lexerPin, filename: lexerFilename }, numericDigitsAsciiOnly: true, universalJavaNumberStringParity: false },
    exactRawReceiptsCopied: true, fullCompilerBuilt: false, fullRawFirBuilderWasmExecuted: false, psiAttachmentParity: false,
    classBinaryNameParity: false, languageReadiness: false,
});
console.log(JSON.stringify({ executions: jobs.length, numericRecords: 19735, genuineBuilderRecords: 720, guards: 8, historicalSources: 3540, currentFiles: current.length }));
