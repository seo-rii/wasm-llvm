import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
	PRODUCER_ROOT, OUTPUT_NAMES, inputHashes, readJson, sha256, validateLock, outputDirectory, writeJson, run,
	sourceTreeHash, assertSourceTree, assertValidation, VALIDATION_CASES
} from '../scripts/shared.mjs';
import { verifyArtifacts } from '../scripts/producer.mjs';

test('locks the LLVM archive and rejects a different Emscripten ABI or mutable source', async () => {
	const lock = await readJson(path.join(PRODUCER_ROOT, 'sources.lock.json'));
	assert.equal(validateLock(lock), lock);
	const changedAbi = structuredClone(lock);
	changedAbi.packages.find((item) => item.name === 'llvm').abi = 'wasi';
	assert.throws(() => validateLock(changedAbi), /Emscripten 4 ABI/);
	const mutableSource = structuredClone(lock);
	mutableSource.source.commit = 'main';
	assert.throws(() => validateLock(mutableSource), /Unpinned source/);
	const missingHash = structuredClone(lock);
	delete missingHash.packages[0].sha256;
	assert.throws(() => validateLock(missingHash), /SHA-256/);
});

test('terminates a compiler validation child that exceeds its execution limit', async () => {
	await assert.rejects(run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
		capture: true, timeoutMs: 100
	}), /exceeded 100 ms/);
});

test('write destinations remain in this checkout task output', () => {
	assert.match(outputDirectory(), /\/out\/lfortran-browser$/);
	assert.throws(() => outputDirectory('/tmp/lfortran'), /below this repository/);
	assert.throws(() => outputDirectory(path.resolve(PRODUCER_ROOT, '../../out')), /below this repository/);
});

test('rejects source edits beneath an otherwise unchanged cache identity', async (t) => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'lfortran-source-test-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = path.join(directory, 'compiler.cpp');
	await writeFile(file, 'upstream source');
	const identity = { treeSha256: await sourceTreeHash(directory) };
	await assertSourceTree(directory, identity);
	await writeFile(file, 'locally changed source');
	await assert.rejects(assertSourceTree(directory, identity), /Cached LFortran source changed/);
});

test('rejects stale validators, altered input results and missing LLVM generation evidence', async () => {
	// Receipt structure fixture only; this does not run or certify a compiler.
	const inputs = await inputHashes();
	const receipt = {
		inputs,
		validation: {
			passed: true, engine: 'node', validatorSha256: inputs['scripts/validate.mjs'],
			cases: VALIDATION_CASES.map((item) => ({
				name: item.name, exitCode: item.exitCode, stdout: item.stdout,
				sourceSha256: inputs[`fixtures/${item.fixture}`],
				stdinSha256: createHash('sha256').update(item.stdin).digest('hex'),
				diagnostic: item.exitCode ? 'this_symbol_is_not_declared' : '',
				generated: ['.o', '.wasm'].map((suffix) => ({ name: `fixture${suffix}`, size: 16, sha256: '0'.repeat(64) }))
			}))
		}
	};
	assertValidation(receipt);
	const stale = structuredClone(receipt);
	stale.validation.validatorSha256 = '0'.repeat(64);
	assert.throws(() => assertValidation(stale), /current validator/);
	const repeated = structuredClone(receipt);
	repeated.validation.cases[1].stdout = receipt.validation.cases[0].stdout;
	assert.throws(() => assertValidation(repeated), /read-array-other-input/);
	const missingOutput = structuredClone(receipt);
	missingOutput.validation.cases[0].generated.pop();
	assert.throws(() => assertValidation(missingOutput), /lacks generated LLVM outputs/);
});

test('artifact verification rejects tampering, stale inputs and absent real validation', async (t) => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'lfortran-producer-test-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	// A minimal module only tests the receipt verifier. It is never accepted as
	// a working compiler: real validation is deliberately absent from this fixture.
	await writeFile(path.join(directory, 'lfortran.wasm'), Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
	await writeFile(path.join(directory, 'lfortran.js'), '// verifier fixture\n');
	await writeFile(path.join(directory, 'lfortran.data'), 'fixture data');
	const files = {};
	for (const name of OUTPUT_NAMES) {
		files[name] = { sha256: await sha256(path.join(directory, name)), size: (await readFile(path.join(directory, name))).length };
	}
	const receipt = {
		inputs: await inputHashes(), files, backend: 'llvm', host: 'emscripten', execution: 'dynamic-side-module',
		validation: { passed: false }
	};
	await writeJson(path.join(directory, 'producer-receipt.json'), receipt);
	await verifyArtifacts(directory, false);
	await assert.rejects(verifyArtifacts(directory), /Real Fortran evaluation/);
	receipt.validation.passed = true;
	await writeJson(path.join(directory, 'producer-receipt.json'), receipt);
	await assert.rejects(verifyArtifacts(directory), /current validator/);
	await writeFile(path.join(directory, 'lfortran.data'), 'tampered');
	await assert.rejects(verifyArtifacts(directory, false), /hash or size mismatch/);
	await writeFile(path.join(directory, 'lfortran.data'), 'fixture data');
	receipt.inputs['sources.lock.json'] = '0'.repeat(64);
	await writeJson(path.join(directory, 'producer-receipt.json'), receipt);
	await assert.rejects(verifyArtifacts(directory, false), /rebuild required/);
});
