import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';

import { inspectProducerRepository } from '../scripts/check-repository.mjs';

test('keeps wasm-llvm private and producer-only', async () => {
	const report = await inspectProducerRepository();
	assert.deepEqual(report.errors, []);
	const producers = await readdir(new URL('../producer/', import.meta.url), { withFileTypes: true });
	assert.equal(report.producersChecked, producers.filter((entry) => entry.isDirectory() && entry.name.endsWith('-browser')).length);
	assert.ok(report.modulesChecked > 0);
});

async function fixture(t) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'producer-contract-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
	for (const entry of await readdir(new URL('../producer/', import.meta.url), { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.endsWith('-browser')) continue;
		const directory = path.join(root, 'producer', entry.name);
		await mkdir(directory, { recursive: true });
		await writeFile(path.join(directory, 'manifest.json'), await readFile(new URL(`../producer/${entry.name}/manifest.json`, import.meta.url)));
	}
	return root;
}

test('checks source pins nested inside manifest arrays', async (t) => {
	const root = await fixture(t);
	const manifestPath = path.join(root, 'producer/clang-browser/manifest.json');
	const manifest = JSON.parse(await readFile(manifestPath));
	manifest.sources = [{ nested: [{ repository: 'https://example.com/source', commit: 'main' }] }];
	await writeFile(manifestPath, JSON.stringify(manifest));
	assert.match((await inspectProducerRepository(root)).errors.join('\n'), /sources.0.nested.0 must pin/);
	manifest.sources[0].nested[0].commit = 'a'.repeat(40);
	await writeFile(manifestPath, JSON.stringify(manifest));
	assert.deepEqual((await inspectProducerRepository(root)).errors, []);
});

test('detects imports from syntax nodes across Node module extensions', async (t) => {
	const root = await fixture(t);
	const cases = {
		'side-effect.mjs': "import /* comment */ '@seo-rii/wasm-llvm';",
		'plain.js': "import value from '@seo-rii/wasm-llvm/runtime';",
		'common.cjs': "require /* comment */ ('@seo-rii/wasm-llvm');",
		'dynamic.mjs': "await import(`@seo-rii/wasm-llvm/runtime`);",
		'export.mjs': "export * from '@seo-rii/wasm-llvm';",
		'escaped.mjs': "import '@seo-rii/wasm-ll\\u0076m';"
	};
	for (const [name, source] of Object.entries(cases)) await writeFile(path.join(root, name), source);
	const report = await inspectProducerRepository(root);
	for (const name of Object.keys(cases)) assert.ok(report.errors.includes(`self runtime import remains: ${name}`), name);
	assert.equal(report.errors.length, Object.keys(cases).length);
});

test('ignores comments and string contents but checks ordinary JS syntax', async (t) => {
	const root = await fixture(t);
	await writeFile(path.join(root, 'safe.js'), `// import '@seo-rii/wasm-llvm';\nconst text = "require('@seo-rii/wasm-llvm')";`);
	await writeFile(path.join(root, 'broken.cjs'), 'const = ;');
	const templatePath = path.join(root, 'producer/wamr-browser/src');
	await mkdir(templatePath, { recursive: true });
	await writeFile(path.join(templatePath, 'wasm-debug-stdin.js'), '#if MEMORY64\n{{{ makeGetValue() }}}\n#endif');
	const report = await inspectProducerRepository(root);
	assert.equal(report.errors.length, 1);
	assert.match(report.errors[0], /invalid JavaScript: broken.cjs/);
	assert.equal(report.modulesChecked, 2);
});
