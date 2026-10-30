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
		await fs.writeFile(path.join(source, '.gitignore'), '/gmp*/\n');
		git('add', 'target.cc', '.gitignore');
		git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'test: source fixture');
		const commit = git('rev-parse', 'HEAD').trim();
		const script = path.join(temp, 'prepare-source.py');
		await fs.copyFile(new URL('./prepare-source.py', import.meta.url), script);
		const patches = [
			'--- a/target.cc\n+++ b/target.cc\n@@ -1,3 +1,3 @@\n-first\n+FIRST\n second\n third\n',
			'--- a/target.cc\n+++ b/target.cc\n@@ -1,3 +1,3 @@\n FIRST\n-second\n+SECOND\n third\n',
			'--- /dev/null\n+++ b/target.opt\n@@ -0,0 +1,2 @@\n+msimd128\n+Target Mask(SIMD128)\n',
			'--- a/target.opt\n+++ b/target.opt\n@@ -1,2 +1,2 @@\n msimd128\n-Target Mask(SIMD128)\n+Target Mask(SIMD128) Init(0)\n'
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
		{ const result = run(true); assert.equal(result.status, 0, `exact prefix should permit the next locked patch: ${result.stderr}`); }
		assert.equal(run().status, 0);
		assert.equal(run(true).status, 0, 'already patched source should be idempotent');
		assert.equal(git('diff', '--cached'), '', 'preparation must not stage source changes');
		git('add', 'target.cc');
		const stagedBefore = git('diff', '--cached', '--binary');
		await lock(3);
		assert.equal(run(true).status, 0, 'a locked patch may introduce a target source file');
		assert.equal(run().status, 0, 'the exact newly added file is a verified input');
		assert.equal(git('diff', '--cached', '--binary'), stagedBefore, 'the real index must remain unchanged');
		await fs.writeFile(path.join(source, 'target.opt'), 'unlocked option\n');
		assert.notEqual(run(true).status, 0, 'new-file content drift must not be accepted');
		await fs.writeFile(path.join(source, 'target.opt'), 'msimd128\nTarget Mask(SIMD128)\n');
		await lock(4);
		assert.equal(run(true).status, 0, 'a later locked patch may update the new file');
		assert.equal(run().status, 0);
		assert.equal(await fs.readFile(path.join(source, 'target.opt'), 'utf8'), 'msimd128\nTarget Mask(SIMD128) Init(0)\n');
		assert.equal(git('diff', '--cached', '--binary'), stagedBefore);
		// A fresh build applies the complete ordered series at once, including
		// patches that modify files introduced by an earlier patch.
		const fresh = path.join(temp, 'fresh');
		git('clone', '-q', '--no-hardlinks', source, fresh);
		const freshResult = spawnSync('python3', [script, '--source', fresh, '--apply'], { encoding: 'utf8' });
		assert.equal(freshResult.status, 0, `clean checkout must accept all dependent patches: ${freshResult.stderr}`);
		assert.equal(await fs.readFile(path.join(fresh, 'target.cc'), 'utf8'), 'FIRST\nSECOND\nthird\n');
		assert.equal(await fs.readFile(path.join(fresh, 'target.opt'), 'utf8'), 'msimd128\nTarget Mask(SIMD128) Init(0)\n');
		assert.equal(execFileSync('git', ['-C', fresh, 'diff', '--cached'], { encoding: 'utf8' }), '');
		assert.equal(spawnSync('python3', [script, '--source', fresh], { encoding: 'utf8' }).status, 0);
		await fs.writeFile(path.join(source, 'target.cc'), 'unknown local work\n');
		assert.notEqual(run(true).status, 0, 'unknown source changes must never be patched over');
		assert.equal(await fs.readFile(path.join(source, 'target.cc'), 'utf8'), 'unknown local work\n');
		await fs.writeFile(path.join(source, 'target.cc'), 'FIRST\nSECOND\nthird\n');
		await fs.writeFile(path.join(source, 'unexpected.h'), 'untracked input\n');
		assert.notEqual(run().status, 0, 'untracked compilation inputs must fail verification');
		await fs.unlink(path.join(source, 'unexpected.h'));
		await fs.mkdir(path.join(source, 'gmp'));
		await fs.writeFile(path.join(source, 'gmp/configure'), '#!/bin/sh\n');
		assert.equal(git('check-ignore', 'gmp/configure').trim(), 'gmp/configure');
		assert.notEqual(run().status, 0, 'ignored in-tree dependencies must not bypass source verification');
	} finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('WABT preparation pins its combined diff and clean submodule inputs', async () => {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gcc-wasi-wabt-source-test-'));
	try {
		const source = path.join(temp, 'wabt'), dependency = path.join(temp, 'dependency');
		const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		const commit = directory => git(directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'test: pinned fixture');
		for (const directory of [source, dependency]) { await fs.mkdir(directory); git(directory, 'init', '-q'); }
		await fs.writeFile(path.join(dependency, 'header.h'), 'pinned dependency\n');
		await fs.writeFile(path.join(dependency, '.gitignore'), '*.generated\n');
		git(dependency, 'add', '.'); commit(dependency);
		git(source, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', dependency, 'third_party/picosha2');
		await fs.writeFile(path.join(source, 'writer.cc'), 'unpatched\n');
		git(source, 'add', '.'); commit(source);
		const revision = git(source, 'rev-parse', 'HEAD').trim();
		await fs.writeFile(path.join(source, 'writer.cc'), 'patched\n');
		const patch = git(source, 'diff', '--binary', '--no-ext-diff', 'HEAD');
		const hash = createHash('sha256').update(patch).digest('hex');
		await fs.writeFile(path.join(temp, 'wabt.patch'), patch);
		await fs.writeFile(path.join(source, 'writer.cc'), 'unpatched\n');
		const lock = { wabt: { commit: revision, patches: [{ path: 'wabt.patch', sha256: hash }], sourceDiffSha256: hash,
			submodules: { 'third_party/picosha2': git(dependency, 'rev-parse', 'HEAD').trim() } } };
		const saveLock = () => fs.writeFile(path.join(temp, 'sources.lock.json'), JSON.stringify(lock));
		await saveLock();
		const script = path.join(temp, 'prepare-source.py');
		await fs.copyFile(new URL('./prepare-source.py', import.meta.url), script);
		const run = (apply = false) => spawnSync('python3', [script, '--component', 'wabt', '--source', source, ...(apply ? ['--apply'] : [])], { encoding: 'utf8' });
		assert.notEqual(run().status, 0);
		const applied = run(true); assert.equal(applied.status, 0, applied.stderr);
		assert.deepEqual(JSON.parse(applied.stdout), { wabtCommit: revision, patches: lock.wabt.patches, sourceDiffSha256: hash, submodules: lock.wabt.submodules });
		assert.equal(run().status, 0);
		assert.equal(git(source, 'diff', '--cached'), '');
		lock.wabt.sourceDiffSha256 = '0'.repeat(64); await saveLock();
		assert.notEqual(run().status, 0, 'combined source identity must match the pin');
		lock.wabt.sourceDiffSha256 = hash; await saveLock();
		const child = path.join(source, 'third_party/picosha2');
		await fs.writeFile(path.join(child, 'unexpected.generated'), 'ignored source input\n');
		assert.notEqual(run().status, 0, 'ignored dependency files may change compilation');
		await fs.unlink(path.join(child, 'unexpected.generated'));
		await fs.writeFile(path.join(child, 'header.h'), 'changed dependency\n');
		assert.notEqual(run().status, 0, 'dependency content must match its gitlink');
		git(child, 'add', 'header.h'); commit(child);
		assert.notEqual(run().status, 0, 'a clean dependency at another revision must also fail');
	} finally { await fs.rm(temp, { recursive: true, force: true }); }
});
