import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { runOverridingIntegrity } from './integrity.mjs';
import { OVERLAYS } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const outputRoot = path.resolve(process.argv[2]), mode = process.argv[3] ?? 'source';
assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(outputRoot, { mode: 0o700 });
async function recordedPin(bytes, pin) { assert.equal(bytes.length, pin.bytes, 'Recorded overriding evidence bytes changed'); assert.equal(sha256(bytes), pin.sha256, 'Recorded overriding evidence SHA changed'); }
let proof;
if (mode === 'source') proof = await runOverridingIntegrity(outputRoot);
else if (mode === 'runtime-reuse') {
    const draft = path.join(REPO, 'out/overriding-private-draft-1791793342203338045'), runtime = path.join(draft, 'wasm-overriding-private-runtime-1791793541809898941');
    const sealFile = path.join(draft, 'private-draft-receipt.json'), sealBytes = await readRegular(sealFile), seal = JSON.parse(sealBytes);
    for (const pin of seal.files) await recordedPin(await readRegular(pin.filename ?? path.join(draft, pin.path)), pin);
    const proofFile = path.join(runtime, 'runtime-proof.json'), bytes = await readRegular(proofFile, 64 * 1024 * 1024), raw = JSON.parse(bytes);
    assert.equal(raw.result, 'pass'); assert.equal(raw.recordCount, 32); assert.equal(raw.controlledProviderRecordCount, 12); assert.equal(raw.constructorFailureRecords.length, 2);
    assert.equal(raw.commands.length, 10); assert(raw.commands.every(command => command.exitCode === 0)); assert.equal(raw.bootstrapSourceCommit, null);
    for (const pin of raw.inputPins) await recordedPin(await readRegular(pin.filename), pin);
    const shippingMatches = [];
    for (const name of ['OverridingUtil.kt', 'OverridingHost.kt', 'OverridingUtilProperties.kt']) shippingMatches.push([name, 'common/' + name]);
    for (const spec of OVERLAYS) shippingMatches.push(['contracts/' + spec[1], 'consumers/' + spec[1]]);
    const pins = [];
    for (const [shipping, privatePath] of shippingMatches) { const current = await readRegular(path.join(HERE, shipping)), prior = await readRegular(path.join(draft, privatePath));
        assert(current.equals(prior), 'Raw JVM proof cannot be reused after shipping source changes'); pins.push({ path: shipping, bytes: current.length, sha256: sha256(current), privatePath }); }
    await writeFile(path.join(outputRoot, 'raw-runtime.json'), bytes, { flag: 'wx', mode: 0o600 });
    proof = { schemaVersion: 1, kind: 'genuine-descriptor-overriding-unchanged-runtime-proof-reuse', result: 'pass', shippingMatches: pins,
        rawProof: { filename: proofFile, bytes: bytes.length, sha256: sha256(bytes) }, privateSeal: { filename: sealFile, bytes: sealBytes.length, sha256: sha256(sealBytes) },
        sourceReview: JSON.parse(await readRegular(path.join(draft, 'source-review.json'))), recheckedPrivateSealPins: seal.files.length, recheckedRuntimeInputPins: raw.inputPins.length,
        originalRecordedJvmCommands: raw.commands.length, originalRecordedJvmCommandsAllExited0: true, ordinaryRecords: raw.recordCount, spiRecords: raw.controlledProviderRecordCount, constructorFailureRecords: raw.constructorFailureRecords.length,
        recordedCompilerAndConsumersComplete: true, originalRuntimeUsesCompletePinnedJavaTypeSubstitutor: true, newJvmCommandsExecuted: 0, reuseReason: 'All seven shipping source bodies are byte-identical to the completed complete-provider JVM oracle; all raw input and artifact pins were rechecked.',
        bootstrapSourceCommit: null, portableThreeProvidersImplemented: false, browserProviderInitializationChosen: false, concurrentHostInitializationProven: false, recursiveJavaClassInitializationParity: false,
        architectureIssue: 'ARCH-010', fullCommonClassWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
} else throw new Error('Unknown overriding proof mode');
await writeJson(path.join(outputRoot, 'proof.json'), proof);
console.log(JSON.stringify({ result: proof.result, outputRoot, mode, guards: proof.guardCount, recordedJvmCommands: proof.originalRecordedJvmCommands, newJvmCommandsExecuted: proof.newJvmCommandsExecuted }));
