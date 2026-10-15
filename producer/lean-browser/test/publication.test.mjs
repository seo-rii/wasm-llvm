import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishDirectory } from '../scripts/publish-directory.mjs';

test('failed staging keeps every previous release byte and cleans only its transaction', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'lean-publish-'));
	const out = path.join(directory, 'release');
	try {
		await mkdir(out);
		await writeFile(path.join(out, 'runtime'), 'version A');
		await writeFile(path.join(out, 'optional'), 'enabled');
		await assert.rejects(publishDirectory(out, async (staging) => {
			await writeFile(path.join(staging, 'runtime'), 'version B');
			throw new Error('late verification failure');
		}), /late verification failure/);
		assert.deepEqual(await readdir(out), ['optional', 'runtime']);
		assert.equal(await readFile(path.join(out, 'runtime'), 'utf8'), 'version A');
		assert.equal(await readFile(path.join(out, 'optional'), 'utf8'), 'enabled');
		assert.deepEqual(await readdir(directory), ['release']);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('concurrent publishers cannot delete staging; replacing A with B removes obsolete files', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'lean-publish-'));
	const out = path.join(directory, 'release');
	try {
		await publishDirectory(out, async (staging) => {
			await writeFile(path.join(staging, 'old-runtime'), 'version A');
			await writeFile(path.join(staging, 'optional'), 'enabled');
		});
		await publishDirectory(out, async (staging) => {
			await writeFile(path.join(staging, 'runtime'), 'version B');
			await assert.rejects(publishDirectory(out, async () => assert.fail('lock must prevent preparation')), /locked/);
			assert.equal(await readFile(path.join(staging, 'runtime'), 'utf8'), 'version B');
		});
		assert.deepEqual(await readdir(out), ['runtime']);
		assert.equal(await readFile(path.join(out, 'runtime'), 'utf8'), 'version B');
		assert.deepEqual(await readdir(directory), ['release']);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed final rename restores the previous output from its backup', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'lean-publish-'));
	const out = path.join(directory, 'release');
	try {
		await mkdir(out);
		await writeFile(path.join(out, 'runtime'), 'original bytes');
		await assert.rejects(publishDirectory(out, async (staging) => {
			// Simulate losing the prepared directory before publication.
			await rm(staging, { recursive: true });
		}), { code: 'ENOENT' });
		assert.equal(await readFile(path.join(out, 'runtime'), 'utf8'), 'original bytes');
		assert.deepEqual(await readdir(directory), ['release']);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('cleanup failure after publication reports success and a recoverable leftover path', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'lean-publish-'));
	const out = path.join(directory, 'release');
	const warnings = [];
	try {
		await mkdir(out);
		await writeFile(path.join(out, 'runtime'), 'version A');
		const result = await publishDirectory(out, async (staging) => {
			await writeFile(path.join(staging, 'runtime'), 'version B');
			return 'published';
		}, {
			remove: async (target, options) => {
				if (target.includes('.staging-')) throw new Error('simulated cleanup failure');
				return rm(target, options);
			},
			warn: (message) => warnings.push(message)
		});
		assert.equal(result, 'published');
		assert.equal(await readFile(path.join(out, 'runtime'), 'utf8'), 'version B');
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /Release published; remove leftover .*\.staging-/);
		assert.ok(!(await readdir(directory)).includes('release.lock'));
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('parent directory aliases share the same publication lock', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'lean-publish-'));
	try {
		await mkdir(path.join(directory, 'actual'));
		await symlink(path.join(directory, 'actual'), path.join(directory, 'alias'));
		await publishDirectory(path.join(directory, 'actual/release'), async (staging) => {
			await writeFile(path.join(staging, 'runtime'), 'bytes');
			await assert.rejects(publishDirectory(path.join(directory, 'alias/release'), async () => {
				assert.fail('alias must not bypass the output lock');
			}), /locked/);
		});
	} finally { await rm(directory, { recursive: true, force: true }); }
});
