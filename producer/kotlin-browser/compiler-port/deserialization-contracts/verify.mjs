import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, relativePath, sha256, verifyFile } from '../../scripts/source.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { verifyDeserializationContracts } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const evidence = JSON.parse(await readRegular(path.join(HERE, 'evidence/receipt.json')));
const root = path.resolve(evidence.outputRoot); assert(root.startsWith(path.join(REPO, 'out') + path.sep));
const local = new Set();
for (const pin of evidence.unitFiles) {
    relativePath(pin.path); assert(!local.has(pin.path)); local.add(pin.path);
    verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
}
assert.deepEqual([...local].sort(), ['ContractsOracle.java', 'DeserializationContracts.kt', 'README.md', 'prepare.mjs', 'probe.mjs', 'sources.lock.json', 'verify.mjs', 'TypedUsage.kt'].sort());
const actualBytes = await readRegular(path.join(root, 'receipt.json'));
assert.equal(sha256(actualBytes), evidence.receiptSha256);
const actual = JSON.parse(actualBytes);
assert.deepEqual(Object.fromEntries(Object.keys(actual).map(key => [key, evidence[key]])), actual);
assert.equal(actual.kind, 'genuine-deserialization-contracts-full-jvm-proof');
assert.equal(actual.result, 'pass'); assert.equal(actual.observations, 524);
assert.equal(actual.commands.length, 6); assert(actual.commands.every(command => command.exitCode === 0));
const seen = new Set();
for (const pin of actual.artifacts) {
    relativePath(pin.path); assert(!seen.has(pin.path)); seen.add(pin.path);
    const bytes = await readRegular(path.join(root, pin.path), pin.bytes);
    assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
}
assert.deepEqual(await verifyDeserializationContracts(path.join(root, 'prepared')), actual.preparation);
const bootstrap = await verifyBootstrap();
assert.equal(bootstrap.lock.version, actual.bootstrap.version); assert.equal(actual.bootstrap.sourceCommit, null);
assert.deepEqual(bootstrap.artifacts, actual.bootstrap.artifacts);
const original = (await readRegular(path.join(root, 'original-observe.stdout'))).toString().split('\n');
const common = (await readRegular(path.join(root, 'common-observe.stdout'))).toString().split('\n');
const records = lines => lines.filter(line => line.startsWith('record:'));
assert.deepEqual(records(original), records(common)); assert.equal(records(original).length, actual.observations);
assert.equal(sha256(Buffer.from(records(original).join('\n'))), actual.recordsSha256);
const invalid = lines => lines.filter(line => line.startsWith('invalid:'));
assert.deepEqual(invalid(original), actual.originalInvalidJavaNullArguments);
assert.deepEqual(invalid(common), actual.commonInvalidJavaNullArguments);
assert.equal(invalid(original).length, 3); assert.equal(invalid(common).length, 3); assert.notDeepEqual(invalid(original), invalid(common));
assert.equal(actual.normalization, false);
for (const name of ['fullCommonClassesWasmExecuted', 'fullCompilerBuilt', 'languageReadiness']) assert.equal(actual[name], false);
for (const pin of [evidence.execution.log, evidence.execution.status]) {
    const bytes = await readRegular(pin.filename); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
}
assert.equal(JSON.parse(await readRegular(evidence.execution.status.filename)).exitCode, 0);
for (const failure of evidence.retainedFailures ?? []) {
    for (const pin of failure.pins) {
        const bytes = await readRegular(pin.filename); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
    }
}
for (const previous of evidence.retainedProfiles ?? []) {
    for (const pin of previous.pins) {
        const bytes = await readRegular(pin.filename, pin.bytes); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
    }
    const original = (await readRegular(path.join(previous.outputRoot, 'original-observe.stdout'))).toString().split('\n');
    const common = (await readRegular(path.join(previous.outputRoot, 'common-observe.stdout'))).toString().split('\n');
    assert.deepEqual(records(original), records(common)); assert.equal(records(original).length, 521);
}
console.log(JSON.stringify({ observations: actual.observations, artifacts: seen.size, commands: actual.commands.length, fullCompilerBuilt: false }));
