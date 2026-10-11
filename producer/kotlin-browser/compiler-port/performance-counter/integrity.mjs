import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { COUNTER } from './transform.mjs';
import { preparePerformanceCounter, verifyPerformanceCounter, verifyFinalPerformanceCounter } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
assert.equal(process.argv.length, 3); const output = path.resolve(process.argv[2]);
assert(output.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(output, { mode: 0o700 });
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const prepared = await preparePerformanceCounter({ sourceRoot, outputRoot: path.join(output, 'prepared') });
const backups = new Map(); for (const filename of prepared.commonSources) backups.set(filename, await readRegular(filename));
const selected = async () => Promise.all(prepared.commonSources.map(async filename => { const bytes = await readRegular(filename);
    return { path: path.relative(prepared.outputRoot, filename), filename, bytes: bytes.length, sha256: sha256(bytes) }; }));
const buildPath = path.join(REPO, 'out/kotlin-compiler-port/builds/module-ir-native-whole-1791654238457260213/compiler-build-receipt.json');
const buildBytes = await readRegular(buildPath, 64 * 1024 * 1024), build = JSON.parse(buildBytes), properties = build.propertyImports.imports;
const positives = [], negatives = [];
const final = async (retainedSources = undefined, recordedPropertyImports = properties) => verifyFinalPerformanceCounter({ sourceRoot,
    outputRoot: prepared.outputRoot, retainedSources: retainedSources ?? await selected(), recordedPropertyImports });
async function reject(label, operation, pattern) { await assert.rejects(operation, error => pattern.test(error.message), label); negatives.push({ label, reason: String(pattern) }); }
async function changed(filename, bytes, action) { const previous = await readRegular(filename); try { await writeFile(filename, bytes); await action(); } finally { await writeFile(filename, previous); } }
const insert = (bytes, block) => { const text = bytes.toString(), pkg = /^package[^\r\n]+/m.exec(text), end = pkg.index + pkg[0].length;
    return Buffer.from(text.slice(0, end) + block + text.slice(end)); };
await final(); positives.push('canonical exact output with actual recorded property list');
await final(undefined, []); positives.push('canonical exact output without recorded imports preserves blank lines');
const propertyBlock = '\n' + properties.map(name => 'import ' + name).join('\n') + '\n';
const jvmBlock = '\nimport kotlin.jvm.*\n', assertionBlock = '\nimport org.jetbrains.kotlin.portable.assertions.compilerAssert as assert\n';
try {
    for (const filename of prepared.commonSources) {
        let bytes = insert(backups.get(filename), jvmBlock);
        bytes = insert(bytes, propertyBlock);
        if (filename.endsWith('PerformanceCounter.kt')) bytes = insert(bytes, assertionBlock);
        await writeFile(filename, bytes);
    }
    const actual = await selected(); await final(actual); positives.push('exact actual ordered property/JVM/assertion prefix assembly');
    await reject('missing counter', () => final(actual.slice(1)), /Missing counter final source/);
    await reject('missing host', () => final(actual.slice(0, 1)), /Missing counter final source/);
    await reject('duplicate logical path', () => final([...actual, actual[0]]), /Duplicate counter selection logical path/);
    await reject('duplicate selected file', () => final([...actual, { ...actual[0], path: 'other.kt' }]), /Duplicate counter selection file/);
    await reject('wrong component owner', () => final(actual.map((item, i) => i ? item : { ...item, filename: path.join(output, 'foreign.kt') })), /Wrong counter output owner/);
    await reject('claimed source size differs', () => final(actual.map((item, i) => i ? item : { ...item, bytes: item.bytes + 1 })), /Counter final size mismatch/);
    await reject('claimed source hash differs', () => final(actual.map((item, i) => i ? item : { ...item, sha256: '0'.repeat(64) })), /Counter final hash mismatch/);
    await reject('wrong recorded import order', () => final(actual, [...properties].reverse()), /Pinned source content mismatch/);
    const filename = prepared.commonSources[0], bytes = await readRegular(filename);
    await changed(filename, Buffer.from(bytes.toString().replace('count++', 'count += 2')), () => reject('changed timing/count algorithm', () => final(), /Pinned source content mismatch/));
    await changed(filename, Buffer.from(bytes.toString().replace('fun increment()', '\nfun increment()')), () => reject('changed body whitespace', () => final(), /Pinned source content mismatch/));
    await changed(filename, insert(bytes, '\nimport accidental.Replacement\n'), () => reject('unrecorded import', () => final(), /Pinned source content mismatch/));
    await changed(filename, insert(bytes, assertionBlock), () => reject('duplicate assertion block', () => final(), /Duplicate counter assembly import block/));
    await changed(filename, Buffer.from(bytes.toString().replace('"$name performed $count times"', '"$name performed $count times!"')), () => reject('changed report literal', () => final(), /Pinned source content mismatch/));
    const host = prepared.commonSources[1], hostBytes = await readRegular(host);
    await changed(host, Buffer.from(hostBytes.toString().replace('currentPerformanceCounterClock = previous', 'currentPerformanceCounterClock = null')), () => reject('changed host restoration', () => final(), /Pinned source content mismatch/));
    const receiptBytes = await readRegular(prepared.receiptPath), receipt = JSON.parse(receiptBytes); receipt.originalAlgorithmsRetained = false;
    await changed(prepared.receiptPath, Buffer.from(JSON.stringify(receipt)), () => reject('changed preparation receipt', () => final(), /Counter preparation receipt changed/));
    await unlink(filename); await symlink(path.join(sourceRoot, COUNTER), filename);
    try { await reject('symlink counter source', () => final(actual), /Symlink paths are not accepted/); }
    finally { await unlink(filename); await writeFile(filename, bytes); }
    await final(); positives.push('restored actual assembled source outputs');
} finally { for (const [filename, bytes] of backups) await writeFile(filename, bytes); }
await verifyPerformanceCounter({ sourceRoot, outputRoot: prepared.outputRoot });
const privateRoot = path.join(output, 'private-original'), originalPath = path.join(privateRoot, COUNTER);
await mkdir(path.dirname(originalPath), { recursive: true }); const original = await readRegular(path.join(sourceRoot, COUNTER));
await writeFile(originalPath, Buffer.concat([original, Buffer.from('\n')]));
await reject('changed immutable original', () => preparePerformanceCounter({ sourceRoot: privateRoot, outputRoot: path.join(output, 'rejected-original') }), /Pinned source content mismatch/);
assert.equal(sha256(await readRegular(path.join(sourceRoot, COUNTER))), prepared.receipt.original.sha256);
const inputs = [];
for (const name of ['integrity.mjs', 'prepare.mjs', 'transform.mjs', 'sources.lock.json', 'PerformanceCounterHost.kt']) {
    const bytes = await readRegular(path.join(HERE, name)); inputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
const receipt = { schemaVersion: 1, kind: 'performance-counter-public-integrity-guards', artifactRoot: path.relative(REPO, output),
    inputs, originalSourceUnchanged: true, preparation: prepared.receipt, positives, negatives,
    frozenAssembly: { receiptPath: path.relative(REPO, buildPath), bytes: buildBytes.length, sha256: sha256(buildBytes), recordedPropertyImports: properties },
    fullCompilerBuilt: false, languageReadiness: false };
await writeJson(path.join(output, 'receipt.json'), receipt); console.log(JSON.stringify({ output, positives: positives.length, negatives: negatives.length }));
