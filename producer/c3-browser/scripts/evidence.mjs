import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { producerRoot, sha256 } from './producer.mjs';

export const acceptanceInputs = [
	'fixtures/program.c3',
	'fixtures/invalid.c3',
	'scripts/smoke-worker.mjs',
	'scripts/smoke.mjs',
	'scripts/browser-smoke.mjs',
	'scripts/evidence.mjs',
	'scripts/package.mjs'
];

export async function acceptanceHashes(root = producerRoot) {
	return Object.fromEntries(await Promise.all(acceptanceInputs.map(async (name) => [
		name, sha256(await readFile(path.join(root, name)))
	])));
}

export async function assertAcceptanceInputs(evidence, root = producerRoot) {
	const expected = await acceptanceHashes(root);
	const actual = evidence?.inputs ?? {};
	if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(expected).sort()) ||
		Object.entries(expected).some(([name, hash]) => actual[name] !== hash)) {
		throw new Error('Compiler acceptance inputs changed; rerun Node and Chromium smoke checks');
	}
}
