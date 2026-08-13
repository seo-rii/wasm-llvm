import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inspectProducerRepository } from '../scripts/check-repository.mjs';

test('keeps wasm-llvm private and producer-only', async () => {
	const report = await inspectProducerRepository();
	assert.deepEqual(report.errors, []);
	assert.equal(report.producersChecked, 9);
	assert.ok(report.modulesChecked > 0);
});
