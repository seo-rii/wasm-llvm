#!/usr/bin/env node
/** Seal the retained, source-bound run without repeating the native allocation-negative. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, verifyFile, writeJson } from '../../../scripts/source.mjs';
import { verifyBootstrap } from '../../../build/bootstrap.mjs';
import { verifyEvidence } from '../../js-ast/verify.mjs';
import { observeAstInChromium } from '../../js-ast/browser.mjs';
import { prepareAstIntegerConsumer } from './prepare.mjs';
import { extracts, inputSource, verifyExtracts, writerSource } from './extract.mjs';
import { compareLiteralProfile } from './compare-profile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../../..');
const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
const negativeBytes = await readRegular(path.join(HERE, 'evidence/malformed-allocation-negative.json')), negative = JSON.parse(negativeBytes);
assert.equal(negative.exitCode, 1);
assert.equal(negative.historicalCheckSha256, '230da3c935a11e98d013e2519fe69a6a35ef8eb76b3dd6a195d1461cb4e5f011');
assert.equal((await readRegular(negative.execution.status)).toString().trim(), '1');
assert.deepEqual(negative.differences, [{ index: 2714, original: 'malformed.7.failure=OutOfMemoryError', wasm: 'malformed.7.failure=IllegalArgumentException' }]);
const oldRoot = negative.artifactRoot;
const astReceipt = JSON.parse(verifyFile(await readRegular(path.join(HERE, lock.astEvidence.path)), lock.astEvidence));
const astExecution = path.join(REPO, 'out/kotlin-js-ast/differential-WViAyC');
await verifyEvidence(astReceipt, { artifactRoot: astExecution });
const output = await mkdtemp(path.join(REPO, 'out/kotlin-js-ast-integer-consumer/sealed-'));
const artifacts = [];
for (const pin of negative.outputs) {
    const bytes = verifyFile(await readRegular(path.join(oldRoot, pin.path)), pin);
    if (pin.path.startsWith('consumer/')) continue;
    const target = path.join(output, pin.path); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); artifacts.push(pin);
}
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const originalSources = await Promise.all(lock.sources.map(pin => readRegular(path.join(sourceRoot, pin.path))));
const parts = extracts(...originalSources); verifyExtracts(parts, lock.extracts);
for (const pin of lock.observers) assert.deepEqual(verifyFile(await readRegular(path.join(HERE, pin.path)), pin), await readRegular(path.join(output, pin.path)));
for (const [name, text] of Object.entries({ 'OriginalInput.kt': inputSource(parts, false), 'PortableInput.kt': inputSource(parts, true), 'ActualLiteralWriter.kt': writerSource(parts) })) {
    assert.deepEqual(await readRegular(path.join(output, name)), Buffer.from(text));
}
const args = verifyFile(await readRegular(path.join(HERE, lock.selectedBaseline.arguments.path)), lock.selectedBaseline.arguments);
const selectedRoot = path.dirname(path.join(HERE, lock.selectedBaseline.arguments.path));
const files = args.toString().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(value => !value.startsWith('-') && value.endsWith('.kt'));
assert.equal(files.length, lock.selectedBaseline.sourceCount);
const retainedSources = files.map(filename => ({ filename, path: filename.startsWith(path.join(selectedRoot, 'sources') + path.sep)
    ? path.relative(path.join(selectedRoot, 'sources'), filename) : path.relative(selectedRoot, filename) }));
const prepared = await prepareAstIntegerConsumer({ sourceRoot, outputRoot: path.join(output, 'consumer'), retainedSources });
const original = JSON.parse(await readRegular(path.join(output, 'original-jvm.json')));
const portable = JSON.parse(await readRegular(path.join(output, 'portable-jvm.json')));
const node = JSON.parse(await readRegular(path.join(output, 'portable-wasmjs.json')));
const browser = await observeAstInChromium(output, node.records);
await writeFile(path.join(output, 'portable-chromium.json'), browser.raw, { flag: 'wx', mode: 0o600 });
const comparison = compareLiteralProfile(original, portable, node, browser.observation);
const browserBytes = Buffer.from(browser.raw); artifacts.push({ path: 'portable-chromium.json', bytes: browserBytes.length, sha256: sha256(browserBytes) });
const bootstrap = await verifyBootstrap();
const receipt = { schemaVersion: 1, kind: 'pinned-actual-bigint-literal-byte-caller-profile', source: lock.source,
    sourceLockSha256: sha256(lockBytes), sealToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    preparation: prepared.receipt, extracts: lock.extracts, astEvidence: lock.astEvidence, astExecution,
    bootstrap: { version: bootstrap.lock.version, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    comparison, artifacts, browser: browser.receipt,
    retainedExecution: { artifactRoot: oldRoot, exitCode: 1, pid: negative.execution.pid, log: negative.execution.log,
        historicalCheckSha256: negative.historicalCheckSha256, nativeAllocationNegativeRepeated: false,
        provenance: 'Original/common JVM and Node Wasm phases completed; strict all-malformed comparison then failed at retained index 2714. Final sealing verifies all retained artifact hashes, current extracted observer bytes, AST/bootstrap pins and actual offline Chromium.' },
    negativeEvidenceSha256: sha256(negativeBytes),
    rawFailures: { originalJvm: original.failures, commonJvm: portable.failures, nodeWasm: node.failures, offlineChromium: browser.observation.failures },
    actualAlgorithm: 'Pinned signed constructor, readBytes/readByteArray, writeByteArray and visitBigInt bodies retained verbatim; only shipping integer import changes.',
    prefixBounds: 'Explicit prefix-underflow observer contract; raw JDK BufferUnderflow and bounded observer cursor categories/messages preserved. Shipping ByteBuffer remains unresolved.',
    fullDeserializerBuilt: false, byteBufferPorted: false, fullCompilerBuilt: false, languageReadiness: false };
await writeJson(path.join(output, 'receipt.json'), receipt);
console.log(JSON.stringify({ output, comparison, nativeAllocationNegativeRepeated: false }));
