import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { typeAliasIntegrity } from './integrity.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), outputRoot = path.resolve(process.argv[2]), mode = process.argv[3] ?? 'source';
assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(outputRoot, { mode: 0o700 }); let proof;
async function frozen(bytes, pin) { assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256); }
if (mode === 'source') proof = await typeAliasIntegrity(outputRoot);
else if (mode === 'runtime-reuse') {
    const root = path.join(REPO, 'out/typealias-constructor-private-draft-20261012-cycle1'), sealFile = path.join(root, 'private-draft-receipt.json'), sealBytes = await readRegular(sealFile), seal = JSON.parse(sealBytes);
    assert.equal(seal.result, 'pass'); for (const pin of seal.artifactPins) await frozen(await readRegular(pin.filename), pin);
    const rawFile = path.join(root, 'runtime-retry1-1791797387308690502/runtime-proof.json'), rawBytes = await readRegular(rawFile, 64 * 1024 * 1024), raw = JSON.parse(rawBytes); assert.equal(raw.result, 'pass'); assert.equal(raw.recordCount, 7); assert.equal(raw.commands.length, 3); assert(raw.commands.every(c => c.exitCode === 0));
    for (const pin of raw.inputPins) await frozen(await readRegular(pin.filename), pin);
    const matches = [];
    for (const [shipping, prior] of [['TypeAliasConstructorBindings.kt', 'TypeAliasConstructorBindings.kt'], ['contracts/TypeAliasConstructorDescriptor.kt', 'TypeAliasConstructorDescriptor.kt']]) {
        const a = await readRegular(path.join(HERE, shipping)), b = await readRegular(path.join(root, prior)); assert(a.equals(b), 'Changed typealias source cannot reuse raw JVM proof'); matches.push({ path: shipping, bytes: a.length, sha256: sha256(a), privateFilename: path.join(root, prior) }); }
    await writeFile(path.join(outputRoot, 'raw-runtime.json'), rawBytes, { flag: 'wx', mode: 0o600 });
    proof = { schemaVersion: 1, kind: 'genuine-typealias-constructor-unchanged-runtime-reuse', result: 'pass', rawProof: { filename: rawFile, bytes: rawBytes.length, sha256: sha256(rawBytes) }, privateSeal: { filename: sealFile, bytes: sealBytes.length, sha256: sha256(sealBytes) }, shippingMatches: matches,
        recheckedSealArtifacts: seal.artifactPins.length, recheckedRawInputPins: raw.inputPins.length, records: raw.records, recordCount: raw.recordCount, recordedJvmCommands: raw.commands.length, newJvmCommandsExecuted: 0,
        nullableElementsReadOrCopiedByHelper: false, helperNonnullContainerCheckPresent: true, reachableContainersMappedOrEmpty: true, rawInvalidNullContainerParity: false,
        originalConsumerComplete: true, commonConsumerComplete: true, ownKotlinConstructorContractFromGenuineParent: true, bootstrapSourceCommit: null, fullCommonConsumerWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
} else throw new Error('Unknown typealias proof mode');
await writeJson(path.join(outputRoot, 'proof.json'), proof); console.log(JSON.stringify({ result: 'pass', mode, outputRoot, guards: proof.guardCount, records: proof.recordCount, newJvmCommandsExecuted: proof.newJvmCommandsExecuted }));
