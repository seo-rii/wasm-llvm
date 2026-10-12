import assert from 'node:assert/strict';
import path from 'node:path';
import { assertNoSymlink, readRegular, sha256, verifyFile } from '../../scripts/source.mjs';
import { verifyFinalLoweringPhaseFactories } from '../lowering-phase-factories/prepare.mjs';
import { RECIPE, transformLoweringPhaseSource } from '../lowering-phase-factories/transform.mjs';
import { verifyNativeFirstPhaseFinalSources } from '../native-first-phase-source-profile/prepare.mjs';

export const PHASE_BOUNDARIES = [
    'compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/JsLoweringPhases.kt',
    'compiler/ir/backend.wasm/src/org/jetbrains/kotlin/backend/wasm/WasmLoweringPhases.kt',
];

/** Keep the native actual graph intact; only the phase checker may receive a verified one-row predecessor. */
export async function bindNativeLoweringPhaseBoundary({ sourceRoot, boundary, retainedSources, recordedPropertyImports, requiredBoundaries, source }) {
    assert.equal(path.resolve(boundary.sourceRoot), path.resolve(sourceRoot), 'Native and phase canonical source roots differ');
    assert.equal(path.resolve(boundary.outputRoot), boundary.outputRoot, 'Canonical phase output root required');
    assert.match(boundary.expectedReceiptSha256 ?? '', /^[a-f0-9]{64}$/, 'External phase preparation receipt digest required');
    await assertNoSymlink(boundary.outputRoot);
    const phaseBoundary = { sourceRoot, outputRoot: boundary.outputRoot, expectedReceiptSha256: boundary.expectedReceiptSha256 };
    const profile = boundary.nativeFirstPhaseProfile;
    const nativeFirstPhase = profile ? await verifyNativeFirstPhaseFinalSources({ ...profile, sourceRoot, retainedSources,
        loweringPhaseBoundary: phaseBoundary, recordedPropertyImports }) : undefined;
    const phaseSources = nativeFirstPhase?.predecessorRetainedSources ?? retainedSources;
    const final = await verifyFinalLoweringPhaseFactories({ ...phaseBoundary, retainedSources: phaseSources, recordedPropertyImports });
    assert.equal(final.checked.length, 6, 'Native composition requires all six canonical phase outputs');
    assert.equal(final.exactBodyAndOwnerVerified, true);
    assert.equal(final.receiptSha256, boundary.expectedReceiptSha256);
    const receiptPath = path.join(boundary.outputRoot, 'receipt.json'), receiptBytes = await readRegular(receiptPath);
    assert.equal(sha256(receiptBytes), boundary.expectedReceiptSha256);
    const receipt = JSON.parse(receiptBytes);
    assert.deepEqual(receipt.source, source);
    const intersection = receipt.originals.filter(pin => requiredBoundaries.some(required => required.path === pin.path)).map(pin => pin.path);
    assert.deepEqual(intersection, [...PHASE_BOUNDARIES].reverse(), 'Only genuine JS/Wasm native boundaries may compose phase metadata');
    const mappings = new Map(), proofMappings = [];
    for (const logical of PHASE_BOUNDARIES) {
        const nativePin = requiredBoundaries.find(pin => pin.path === logical), originalPin = receipt.originals.find(pin => pin.path === logical), outputPin = receipt.files.find(pin => pin.path === logical);
        for (const field of ['bytes', 'sha256', 'gitBlob']) assert.equal(originalPin[field], nativePin[field], 'Phase upstream native boundary pin changed');
        const originalFilename = path.join(boundary.outputRoot, 'reference-original', logical);
        const original = verifyFile(await readRegular(originalFilename), nativePin);
        const common = verifyFile(transformLoweringPhaseSource(logical, original), outputPin);
        let reconstructed = common.toString();
        for (const [before, after, count] of [...RECIPE[logical]].reverse()) {
            assert(after, 'Native phase recipe must be reversible');
            assert.equal(reconstructed.split(after).length - 1, count, 'Native phase reverse recipe changed');
            reconstructed = reconstructed.split(after).join(before);
        }
        assert.deepEqual(Buffer.from(reconstructed), original, 'Entire genuine native phase caller must roundtrip');
        const filename = path.join(boundary.outputRoot, logical), checked = final.checked.find(pin => pin.path === logical);
        assert(checked && checked.filename === filename, 'Phase final does not bind actual native owner');
        const proof = { path: logical, filename, originalFilename, upstreamPin: nativePin, outputPin,
            preparationReceiptSha256: boundary.expectedReceiptSha256, sourceLockSha256: final.sourceLockSha256,
            entireOriginalRoundtripVerified: true, ...(nativeFirstPhase ? {
                actualSelectedPhaseOutputs: 5, restoredExcludedPhaseOutputs: 1, fullCanonicalOutputsVerified: 6,
            } : { fullActualPhaseOutputsChecked: 6 }) };
        proofMappings.push(proof); mappings.set(logical, { original, common, outputPin, filename, proof });
    }
    return { mappings, receipt: { component: 'loweringPhaseFactoriesReceipt', receiptPath,
        preparationReceiptSha256: boundary.expectedReceiptSha256, sourceLockSha256: final.sourceLockSha256,
        checked: final.checked, mappings: proofMappings, actualFinalSelectionUsed: true,
        ...(nativeFirstPhase ? { actualSelectedPhaseOutputs: 5, restoredExcludedPhaseOutputs: 1, fullCanonicalOutputsVerified: 6,
            phaseVerificationSelection: 'actual graph plus exactly one independently verified excluded predecessor',
            nativeFirstPhaseProfile: nativeFirstPhase.receipt } : {}),
        fullIrLoweringExecuted: false, fullCompilerBuilt: false, languageReadiness: false } };
}
