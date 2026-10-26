import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('locked patches apply incrementally, preserve the real index, and reject source drift', async () => {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gcc-wasi-source-test-'));
	try {
		const source = path.join(temp, 'gcc');
		await fs.mkdir(source);
		const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		git('init', '-q');
		await fs.writeFile(path.join(source, 'target.cc'), 'first\nsecond\nthird\n');
		git('add', 'target.cc');
		git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'test: source fixture');
		const commit = git('rev-parse', 'HEAD').trim();
		const script = path.join(temp, 'prepare-source.py');
		await fs.copyFile(new URL('./prepare-source.py', import.meta.url), script);
		const patches = [
			'--- a/target.cc\n+++ b/target.cc\n@@ -1,3 +1,3 @@\n-first\n+FIRST\n second\n third\n',
			'--- a/target.cc\n+++ b/target.cc\n@@ -1,3 +1,3 @@\n FIRST\n-second\n+SECOND\n third\n'
		];
		const pins = [];
		for (const [index, contents] of patches.entries()) {
			const name = `${index}.patch`;
			await fs.writeFile(path.join(temp, name), contents);
			pins.push({ path: name, sha256: createHash('sha256').update(contents).digest('hex') });
		}
		const lock = async (count) => fs.writeFile(path.join(temp, 'sources.lock.json'), JSON.stringify({ gcc: { commit, patches: pins.slice(0, count) } }));
		const run = (apply = false) => spawnSync('python3', [script, '--source', source, ...(apply ? ['--apply'] : [])], { encoding: 'utf8' });
		await lock(1);
		assert.notEqual(run().status, 0, 'unpatched source must fail verification');
		assert.equal(run(true).status, 0);
		assert.equal(await fs.readFile(path.join(source, 'target.cc'), 'utf8'), 'FIRST\nsecond\nthird\n');
		await lock(2);
		assert.equal(run(true).status, 0, 'exact prefix should permit the next locked patch');
		assert.equal(run().status, 0);
		assert.equal(run(true).status, 0, 'already patched source should be idempotent');
		assert.equal(git('diff', '--cached'), '', 'preparation must not stage source changes');
		await fs.writeFile(path.join(source, 'target.cc'), 'unknown local work\n');
		assert.notEqual(run(true).status, 0, 'unknown source changes must never be patched over');
		assert.equal(await fs.readFile(path.join(source, 'target.cc'), 'utf8'), 'unknown local work\n');
		await fs.writeFile(path.join(source, 'target.cc'), 'FIRST\nSECOND\nthird\n');
		await fs.writeFile(path.join(source, 'unexpected.h'), 'untracked input\n');
		assert.notEqual(run().status, 0, 'untracked compilation inputs must fail verification');
	} finally { await fs.rm(temp, { recursive: true, force: true }); }
});
