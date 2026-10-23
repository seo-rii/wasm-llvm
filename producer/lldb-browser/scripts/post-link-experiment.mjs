import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Bind a local re-link experiment to its pinned input and generated outputs.
// This is evidence about a derived candidate, never a full source-build receipt.
export function validatePostLinkExperiment(
	proofBytes,
	{ jsBytes, wasmBytes, buildFlags, emsdkRevision }
) {
	const proof = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(proofBytes));
	assert.equal(proof.format, 'wasm-llvm-lldb-post-link-experiment-v1');
	assert.equal(proof.fullSourceBuild, false);
	assert.equal(proof.emsdkRevision, emsdkRevision);
	assert.equal(
		digest(proof.input.manifest),
		proof.input.manifestSha256,
		'Pinned input manifest receipt'
	);
	const manifest = JSON.parse(proof.input.manifest);
	assert.equal(proof.input.wasmSha256, manifest.debugger.lldb.wasmSha256);
	assert.match(proof.recoveredInputSha256, /^[a-f0-9]{64}$/u);
	assert(proof.commands.featureRecovery.includes('--emit-target-features'));
	assert(proof.commands.postLink.includes('--post-link'));
	for (const flag of buildFlags)
		assert(proof.commands.postLink.includes(flag), `Missing post-link flag: ${flag}`);
	for (const [kind, bytes] of [
		['js', jsBytes],
		['wasm', wasmBytes]
	]) {
		assert.equal(proof.output[kind].sha256, digest(bytes), `Candidate ${kind} digest`);
		assert.equal(proof.output[kind].bytes, bytes.byteLength, `Candidate ${kind} size`);
	}
	return proof;
}
