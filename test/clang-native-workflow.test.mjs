import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'acorn';

const root = new URL('../', import.meta.url);
const workflowPath = '.github/workflows/clang-native-cross.yml';
const workflow = await readFile(new URL(workflowPath, root), 'utf8');
// Deliberately accept only the workflow's quoted positive path-list syntax.
// A future YAML/glob feature must extend this check instead of being ignored.
const event = workflow.match(/^  pull_request:\n((?: {4}.*\n|[\t ]*\n)+)/m)?.[1];
assert(event, 'Missing pull_request mapping');
const list = event.match(/^    paths:\n((?: {6}.*\n|[\t ]*\n)+)/m)?.[1];
assert(list, 'Missing pull_request.paths list');
const patterns = list.trimEnd().split('\n').filter((line) => line.trim()).map((line) => {
	const match = /^      - '([\w./*+-]+)'$/.exec(line);
	assert(match, `Unsupported workflow path syntax: ${line}`);
	return match[1];
});
function triggers(file) {
	return patterns.some((pattern) => {
		if (path.matchesGlob) return path.matchesGlob(file, pattern);
		// Node 20 has no matchesGlob. Support the same * and ** subset there.
		const expression = pattern.split(/(\*\*\/|\*\*|\*)/).map((part) =>
			part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' :
				part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
		return new RegExp(`^${expression}$`).test(file);
	});
}

test('native qualification runs when any compiler, packaging or qualification input changes alone', async () => {
	const producer = 'producer/clang-browser/';
	const inputs = new Set([workflowPath, 'package.json', 'pnpm-lock.yaml',
		'test/clang-native-workflow.test.mjs', `${producer}manifest.json`,
		`${producer}cross/profile.json`, `${producer}tool-host/profile.json`,
		`${producer}scripts/hot-path-launcher.sh`]);
	const manifest = JSON.parse(await readFile(new URL(`${producer}manifest.json`, root), 'utf8'));
	for (const source of Object.values(manifest.sources)) {
		if (source.path?.startsWith('patches/')) inputs.add(producer + source.path);
	}
	const profile = JSON.parse(await readFile(new URL(`${producer}cross/profile.json`, root), 'utf8'));
	inputs.add(producer + profile.lldPatch.path);
	const host = JSON.parse(await readFile(new URL(`${producer}tool-host/profile.json`, root), 'utf8'));
	for (const input of [host.patch, host.initialCwd]) inputs.add(`${producer}tool-host/${input.path}`);
	const visited = new Set();
	async function collectImports(file) {
		if (visited.has(file)) return;
		visited.add(file); inputs.add(file);
		const module = parse(await readFile(new URL(file, root), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
		for (const statement of module.body) {
			const source = statement.source?.value;
			if (typeof source === 'string' && source.startsWith('.')) {
				await collectImports(path.posix.normalize(path.posix.join(path.posix.dirname(file), source)));
			}
		}
	}
	// Follow real imports so newly shared helpers also need trigger coverage.
	for (const entry of ['scripts/build-toolchain.mjs', 'tool-host/verify.mjs',
		'cross/import-sysroot.mjs', 'cross/package.mjs', 'cross/qualify.mjs']) {
		await collectImports(producer + entry);
	}
	assert.deepEqual([...inputs].filter((input) => !triggers(input)), [],
		'Native qualification must cover single-file changes to these inputs');
});

test('unrelated producers and documentation do not trigger the LLVM build', () => {
	for (const unrelated of ['producer/swift-browser/manifest.json', 'producer/tinygo-browser/scripts/build-llvm-wasi.mjs', 'README.md']) {
		assert.equal(triggers(unrelated), false, unrelated);
	}
});
