import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readPackageJson() {
	return JSON.parse(await readFile(path.join(RUNTIME_ROOT, 'package.json'), 'utf8'));
}

test('exposes wasm-swift runtime workflow scripts', async () => {
	const pkg = await readPackageJson();

	assert.equal(pkg.scripts.test, 'node --test ./scripts/*.test.mjs');
	assert.equal(pkg.scripts['bootstrap:source'], 'node ./scripts/bootstrap-source-checkout.mjs');
	assert.equal(pkg.scripts['build:browser-compiler'], 'node ./scripts/build-browser-compiler.mjs');
	assert.equal(pkg.scripts['run:upstream-baseline'], 'node ./scripts/run-upstream-baseline.mjs');
	assert.equal(pkg.scripts['discover:build-outputs'], 'node ./scripts/discover-build-outputs.mjs');
	assert.equal(pkg.scripts['package:from-plan'], 'node ./scripts/package-from-build-plan.mjs');
	assert.equal(pkg.scripts['import:runtime'], 'node ./scripts/import-runtime.mjs');
	assert.equal(pkg.scripts['export:runtime'], 'node ./scripts/export-runtime.mjs');
	assert.equal(pkg.scripts.readiness, 'node ./scripts/readiness.mjs');
	assert.equal(pkg.scripts['validate:contract'], 'node ./scripts/runtime-contract-runner.mjs');
	assert.equal(pkg.scripts['verify:build-outputs'], 'node ./scripts/verify-build-outputs.mjs');
	assert.equal(pkg.scripts['verify:wasi-frontend'], 'node ./scripts/verify-wasi-frontend.mjs');
});

test('keeps wasm-swift package script targets present', async () => {
	const pkg = await readPackageJson();
	const missing = [];
	for (const [name, script] of Object.entries(pkg.scripts)) {
		const match = /^node\s+(\.\/scripts\/[^\s]+\.mjs)(?:\s|$)/u.exec(script);
		if (!match) continue;
		const targetPath = path.join(RUNTIME_ROOT, match[1]);
		try {
			await readFile(targetPath, 'utf8');
		} catch {
			missing.push(`${name}: ${match[1]}`);
		}
	}

	assert.deepEqual(missing, []);
});
