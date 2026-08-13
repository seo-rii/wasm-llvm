import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const producerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('documents the reproducible Swift producer flow', async () => {
	const readme = await readFile(path.join(producerRoot, 'README.md'), 'utf8');
	for (const requiredText of [
		'`manifest.json` pins the Swift release',
		'`runner-worker.js`',
		'`swiftc.wasm`',
		'`swiftpm.wasm`',
		'`sdk.tar.gz`',
		'pnpm --dir producer/swift-browser run bootstrap:source',
		'--swift-ref swift-6.3.3-RELEASE',
		'--dependency-scheme release/6.3',
		'pnpm --dir producer/swift-browser run build:browser-compiler',
		'--execute-browser-build-command',
		'pnpm --dir producer/swift-browser run run:upstream-baseline',
		'pnpm --dir producer/swift-browser run verify:build-outputs',
		'--require-source-bootstrap-provenance',
		'pnpm --dir producer/swift-browser run package:from-plan',
		'pnpm --dir producer/swift-browser run export:runtime',
		'--browser-contract',
		'.github/workflows/swift-browser-producer.yml',
		'never npm package content'
	]) {
		assert.ok(readme.includes(requiredText), `README is missing: ${requiredText}`);
	}
	assert.doesNotMatch(readme, /packages\/core\/src\/languages\.ts/u);
	assert.doesNotMatch(readme, /apply:wasm-swift-registration/u);
});
