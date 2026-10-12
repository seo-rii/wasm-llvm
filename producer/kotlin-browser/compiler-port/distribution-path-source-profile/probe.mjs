import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readdir, lstat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { TARGETS, HOMONYM } from './references.mjs';
import { prepareDistributionPathSourceProfile, verifyDistributionPathSourceProfile, verifyFinalDistributionPathSourceProfile } from './prepare.mjs';
import { verifyServiceLoaderFinalSources, TARGET as SERVICE } from '../service-loader-profile/prepare.mjs';
import { verifyKlibDiskFinalSources } from '../klib-disk-source-profile/prepare.mjs';
import { verifyJvmUtilityFinalSources } from '../jvm-utility-source-profile/prepare.mjs';
import { verifyNioUtilityFinalSources } from '../nio-utility-source-profile/prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const start = performance.now(), outputRoot = path.resolve(process.argv[2]);
assert.equal(process.argv.length, 3); assert(outputRoot.startsWith(path.join(REPO, 'out/distribution-path-proof-')));
await mkdir(outputRoot, { mode: 0o700 });
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
async function pin(filename) { return { filename, ...identity(await readRegular(filename, 64 * 1024 * 1024)) }; }
const project = ({ path, filename, bytes, sha256 }) => ({ path, filename, bytes, sha256 });
const jobPath = '/tmp/wasm-kotlin-native-phase-whole-job.json', job = JSON.parse(await readRegular(jobPath));
const status = JSON.parse(await readRegular(job.status)); assert.equal(status.state, 'exited'); assert.equal(status.exitCode, 1); assert.equal(status.pid, job.pid);
const buildRoot = path.join(REPO, 'out/kotlin-compiler-port/builds/native-phase-whole-1791783153676530856');
assert.equal(job.output, buildRoot); assert.equal(job.head, 'c6777eb498ca125ac83f99bfa1e7ff2a58b13849');
const wholePath = path.join(buildRoot, 'compiler-build-receipt.json'), wholeBytes = await readRegular(wholePath, 64 * 1024 * 1024);
assert.equal(sha256(wholeBytes), '28db29fe84026ce086d53ce8ece45117df32f2bccbebdf8295b28d1cfca3ac55');
const whole = JSON.parse(wholeBytes), argumentsPath = path.join(buildRoot, 'compiler-klib.args'), argumentsBytes = await readRegular(argumentsPath);
assert.equal(whole.status, 'failed'); assert.equal(whole.compileSources.length, 3550);
const compilerCommand = whole.commands.find(row => row.phase === 'official-compiler-source-to-wasmjs-klib');
assert.equal(compilerCommand.exitCode, 1); assert.equal(compilerCommand.argumentFileSha256, sha256(argumentsBytes));
const compilerArguments = argumentsBytes.toString().trimEnd().split('\n').map(JSON.parse), filenames = compilerArguments.slice(-3550);
const retainedSources = whole.compileSources.map((row, n) => ({ path: row.path, filename: filenames[n], bytes: row.bytes, sha256: row.sha256, compile: true }));
assert.deepEqual(retainedSources.map(project), whole.serviceLoaderProfileReceipt.selection.sources.filter(row => row.path !== SERVICE));
const beforeHistory = await tree(buildRoot), historicalExecutionPins = await Promise.all([jobPath, job.status, job.log, job.runner, wholePath, argumentsPath].map(pin));
const currentInputs = [];
const componentDirectories = ['distribution-path-source-profile', 'service-loader-profile', 'klib-disk-source-profile',
    'jvm-utility-source-profile', 'nio-utility-source-profile', 'klib-signature-index'];
const seenInputs = new Set();
for (const directory of componentDirectories) {
    const root = path.join(HERE, '..', directory), lockPath = path.join(root, 'sources.lock.json');
    await capture(lockPath);
    const lock = JSON.parse(await readRegular(lockPath));
    for (const dependency of lock.dependencies ?? []) await capture(path.resolve(root, dependency.path));
    if (directory === 'distribution-path-source-profile') { await capture(path.join(root, 'probe.mjs')); await capture(path.join(root, 'README.md')); }
}
const originalSourcePins = [];
for (const row of retainedSources) { const actual = await pin(row.filename); assert.deepEqual(actual, { filename: row.filename, bytes: row.bytes, sha256: row.sha256 }); originalSourcePins.push(actual); }
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources'), preparedRoot = path.join(outputRoot, 'prepared');
const jvm = await component('jvmUtilitySourceProfileReceipt');
const prepared = await prepareDistributionPathSourceProfile({ sourceRoot, outputRoot: preparedRoot, retainedSources,
    preparedJvmUtilityProfile: jvm, recordedPropertyImports: whole.propertyImports.imports });
const options = { sourceRoot, outputRoot: preparedRoot, expectedReceiptSha256: prepared.receiptSha256 };
await verifyDistributionPathSourceProfile(options);
const actual = retainedSources.filter(row => !TARGETS.includes(row.path)); assert.equal(actual.length, 3547);
const initial = await verifyFinalDistributionPathSourceProfile({ ...options, retainedSources: actual });
assert.deepEqual(initial.predecessorRetainedSources, retainedSources);
assert.equal(initial.receipt.restoredPredecessors.length, 3);
await writeJson(path.join(outputRoot, 'inputs-before.json'), { schemaVersion: 1, historicalExecutionPins, currentInputs,
    historicalInventory: beforeHistory, originalSourcePins, retainedSources, actualSources: actual,
    preparationReceipt: await pin(prepared.receiptPath), compilerArgumentsSha256: sha256(argumentsBytes),
    fullCompilerBuilt: false });

const negatives = [];
async function reject(name, reason, call) {
    let failure; try { await call(); } catch (error) { failure = error; }
    assert(failure, 'Accepted negative: ' + name); assert.equal(failure.code, 'ERR_ASSERTION');
    assert(failure.message.split('\n')[0].startsWith(reason), 'Unexpected rejection reason for ' + name + ': ' + failure.message);
    assert(!/ENOENT|EEXIST/.test(failure.message), 'Filesystem failure cannot count as a guarded rejection');
    negatives.push({ name, result: 'rejected', code: failure.code, reason: failure.message.split('\n')[0], expectedReason: reason });
}
const call = (rows = actual, overrides = {}) => verifyFinalDistributionPathSourceProfile({ ...options, ...overrides, retainedSources: rows });
await reject('missing external digest', 'Distribution external receipt digest required', () => call(actual, { expectedReceiptSha256: '' }));
await reject('wrong external digest', 'Distribution preparation receipt changed', () => call(actual, { expectedReceiptSha256: '0'.repeat(64) }));
await reject('excluded original reintroduced', 'Distribution exact three exclusion targets required', () => call([...actual, retainedSources.find(row => row.path === TARGETS[0])]));
await reject('missing actual row', 'Distribution final graph changed beyond exactly three exclusions', () => call(actual.slice(1)));
const injections = path.join(outputRoot, 'injections'); await mkdir(injections, { mode: 0o700 });
async function injected(name, text, logical = 'fixture/' + name + '.kt') {
    const filename = path.join(injections, name + '.kt'), bytes = Buffer.from(text);
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return { path: logical, filename, ...identity(bytes), compile: true };
}
const extra = await injected('Extra', 'package fixture\nval extra = 1\n');
await reject('extra unrelated row', 'Distribution final graph changed beyond exactly three exclusions', () => call([...actual, extra]));
const original = retainedSources.find(row => row.path === TARGETS[0]);
const copied = await injected('RelocatedTarget', (await readRegular(original.filename)).toString(), 'fixture/' + original.path);
await reject('excluded full source relocated', 'Distribution excluded source relocated under a replacement path', () => call([...actual, copied]));
const first = actual[0], wrongDigest = { ...first, sha256: 'f'.repeat(64) };
await reject('selected hash forged', 'Distribution selected source bytes changed: ' + first.path, () => call(actual.map(row => row.path === first.path ? wrongDigest : row)));
const rehashed = await injected('HonestChangedBody', (await readRegular(first.filename)).toString() + '\n// changed source\n', first.path);
await reject('changed unrelated full body with honest digest', 'Distribution final graph changed beyond exactly three exclusions', () => call(actual.map(row => row.path === first.path ? rehashed : row)));
for (const [name, text] of [
    ['Qualified', 'package fixture\nval x = org.jetbrains.kotlin.utils.PathUtil.KOTLIN_COMPILER_JAR\n'],
    ['Alias', 'package fixture\nimport org.jetbrains.kotlin.utils.KotlinPaths as Paths\nval x: Paths? = null\n'],
    ['String', 'package fixture\nval x = "org.jetbrains.kotlin.utils.KotlinPathsFromHomeDir"\n'],
    ['Backtick', 'package fixture\nval x = org.jetbrains.kotlin.utils.`PathUtil`\n'],
    ['Unicode', 'package fixture\nval x = "KotlinP\\u0061ths"\n'],
    ['SplitLiteral', 'package fixture\nval x = "KotlinPathsFrom" + "HomeDir"\n'],
]) {
    const added = await injected(name, text);
    await reject('new distribution reference: ' + name, 'Distribution retained source refers to excluded distribution path declaration: ' + added.path, () => call([...actual, added]));
}
const homonym = actual.find(row => row.path === HOMONYM), homonymBytes = await readRegular(homonym.filename);
const foreign = await injected('ForeignHomonym', homonymBytes.toString(), HOMONYM);
await reject('identical homonym under foreign physical owner', 'Distribution final graph changed beyond exactly three exclusions', () => call(actual.map(row => row.path === HOMONYM ? foreign : row)));
const changedHomonym = await injected('ChangedHomonym', homonymBytes.toString().replace('PathUtil.getFileName(container.fileName)', 'PathUtil.getFileName("other")'), HOMONYM);
await reject('homonym algorithm changed with honest digest', 'Distribution exact IntelliJ homonym consumer body changed', () => call(actual.map(row => row.path === HOMONYM ? changedHomonym : row)));
const changedImport = await injected('ForeignHomonymImport', homonymBytes.toString().replace('import com.intellij.util.PathUtil\n', 'import org.jetbrains.kotlin.utils.PathUtil\n'), HOMONYM);
await reject('homonym exception cannot hide a distribution import', 'Distribution exact IntelliJ homonym consumer body changed', () => call(actual.map(row => row.path === HOMONYM ? changedImport : row)));
const receiptBytes = await readRegular(prepared.receiptPath, 64 * 1024 * 1024), changedReceipt = JSON.parse(receiptBytes);
changedReceipt.sourceRoot = path.join(outputRoot, 'foreign-source-root');
const changedReceiptBytes = Buffer.from(JSON.stringify(changedReceipt, null, 2) + '\n'); await writeFile(prepared.receiptPath, changedReceiptBytes);
try { await reject('rehashed receipt with foreign source root', 'Distribution original source root changed', () => call(actual, { expectedReceiptSha256: sha256(changedReceiptBytes) })); }
finally { await writeFile(prepared.receiptPath, receiptBytes); }
const restored = await call(); assert.deepEqual(restored, initial);

// The four existing tail APIs are called unchanged on the exact verified three-row
// predecessor. They are read-only; whole-file and directory metadata snapshots below
// reject any mutation or newly-created artifact anywhere in the historical BUILD.
const predecessor = restored.predecessorRetainedSources, service = await component('serviceLoaderProfileReceipt', 'service-loader-inputs.json');
const disk = { ...await component('klibDiskSourceProfileReceipt'), serviceLoaderProfile: service };
const utility = { ...jvm, klibDiskProfile: disk }, nio = { ...await component('nioUtilitySourceProfileReceipt'), jvmUtilityProfile: utility };
const tail = [];
async function runTail(method, run) { const began = performance.now(), receipt = await run(); tail.push({ method, result: 'pass', elapsedSeconds: (performance.now() - began) / 1000, receipt }); return receipt; }
const serviceFinal = await runTail('verifyServiceLoaderFinalSources', () => verifyServiceLoaderFinalSources({ ...service, retainedSources: predecessor }));
const diskFinal = await runTail('verifyKlibDiskFinalSources', () => verifyKlibDiskFinalSources({ ...disk, retainedSources: predecessor }));
const utilityFinal = await runTail('verifyJvmUtilityFinalSources', () => verifyJvmUtilityFinalSources({ ...utility, retainedSources: predecessor }));
const nioFinal = await runTail('verifyNioUtilityFinalSources', () => verifyNioUtilityFinalSources({ ...nio, retainedSources: predecessor }));
assert.deepEqual(diskFinal.serviceFinal, serviceFinal); assert.deepEqual(utilityFinal.diskFinal, diskFinal); assert.deepEqual(nioFinal.utilityFinal, utilityFinal);
assert.deepEqual(await tree(buildRoot), beforeHistory, 'Historical BUILD files or directory metadata changed');
for (const p of [...historicalExecutionPins, ...currentInputs, ...originalSourcePins]) assert.deepEqual(await pin(p.filename), p, 'Pinned input changed');
await writeJson(path.join(outputRoot, 'final-sources.json'), actual);
await writeJson(path.join(outputRoot, 'receipt.json'), { schemaVersion: 1, kind: 'actual-distribution-path-selection-and-tail-proof', result: 'pass',
    elapsedSeconds: (performance.now() - start) / 1000, actualSourcesBefore: 3550, actualSourcesAfter: 3547,
    originalArgumentVectorReconstructed: true, historicalCompilerExitCode: 1, sourceSetExclusions: TARGETS, commonOutputs: 0,
    preparationReceipt: await pin(prepared.receiptPath), final: restored.receipt, exactPredecessorRowsAndOrderRestored: true,
    negatives, reasonMatchedNegativeChecks: negatives.length, restoredPositivePassed: true, publicTailCalls: tail,
    explicitPublicTailCalls: 4, nestedPublicTailCallsIncludingRepeatedComposition: 10,
    historicalBuildRoot: buildRoot, historicalExecutionPins, historicalInventory: beforeHistory, historicalDirectoriesAndFilesUnchanged: true,
    currentInputs, originalSourcePins, finalSourceInventorySha256: sha256(Buffer.from(JSON.stringify(actual))),
    sourceRoot, fullCompilerBuilt: false, filesystemImplemented: false, languageReadiness: false });
console.log(JSON.stringify({ result: 'pass', outputRoot, before: 3550, after: 3547, negatives: negatives.length, tailCalls: 4, historicalImmutable: true }));

async function capture(filename) { if (!seenInputs.has(filename)) { seenInputs.add(filename); currentInputs.push(await pin(filename)); } }
async function component(key, basename = 'receipt.json') {
    const outputRoot = path.join(buildRoot, 'components', key), receiptPath = path.join(outputRoot, basename), bytes = await readRegular(receiptPath, 64 * 1024 * 1024);
    assert.deepEqual(JSON.parse(bytes), whole[key], 'Actual canonical component receipt changed: ' + key);
    return { outputRoot, expectedReceiptSha256: sha256(bytes) };
}
async function tree(root) {
    const entries = [];
    async function visit(filename) {
        const info = await lstat(filename, { bigint: true }); assert(info.isFile() || info.isDirectory(), 'Nonregular historical artifact');
        const metadata = Object.fromEntries(['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'mtimeNs', 'ctimeNs'].map(key => [key, String(info[key])]));
        entries.push({ filename, type: info.isDirectory() ? 'directory' : 'file', metadata, ...(info.isFile() ? identity(await readRegular(filename, 64 * 1024 * 1024)) : {}) });
        if (info.isDirectory()) for (const child of (await readdir(filename)).sort((a, b) => a.localeCompare(b))) await visit(path.join(filename, child));
    }
    await visit(root); return entries;
}
