import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { test } from 'node:test';

import { inspectProducerRepository } from '../scripts/check-repository.mjs';

test('keeps wasm-llvm private and producer-only', async () => {
	const report = await inspectProducerRepository();
	assert.deepEqual(report.errors, []);
	const producers = await readdir(new URL('../producer/', import.meta.url), { withFileTypes: true });
	assert.equal(report.producersChecked, producers.filter((entry) => entry.isDirectory() && entry.name.endsWith('-browser')).length);
	assert.ok(report.modulesChecked > 0);
});
