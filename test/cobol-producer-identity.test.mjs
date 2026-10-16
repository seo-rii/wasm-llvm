import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verify } from '../producer/cobol-browser/scripts/verify-artifacts.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));

test('COBOL verifies authentic artifacts and rejects receipt identity changes without changing their bytes', async (t) => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'cobol-producer-identity-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await cp(path.join(repo, 'artifacts/cobol-browser'), directory, { recursive: true });
	const metadataPath = path.join(directory, 'toolchain.json');
	const original = JSON.parse(await readFile(metadataPath, 'utf8'));
	assert.deepEqual(await verify(directory), original);
	for (const mutate of [
		(value) => { delete value.producer; },
		(value) => { value.producer.id = 'wasm-llvm/unrelated-browser'; },
		(value) => { value.producer.manifest = 'producer/unrelated-browser/manifest.json'; },
		(value) => { value.producer.manifestSha256 = '0'.repeat(64); },
		(value) => { delete value.producer.manifestSha256; }
	]) {
		const changed = structuredClone(original);
		mutate(changed);
		await writeFile(metadataPath, JSON.stringify(changed));
		await assert.rejects(verify(directory), /producer identity does not match/);
	}
	await writeFile(metadataPath, JSON.stringify(original));
	assert.deepEqual(await verify(directory), original);
});
