import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { loadContract, packageD, verifyDArtifacts } from '../scripts/package.mjs';
import { describeArtifact, jsonBytes, sha256, writeArtifact } from '../../../scripts/lib/verified-artifacts.mjs';

const run = promisify(execFile);
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture({ archiveSymlink = false } = {}) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'd-producer-test-'));
	roots.push(root);
	const sourceDir = path.join(root, 'source');
	const inputs = new Map([
		['bin/ldc2.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])],
		['bin/lld.js', Buffer.from('export default function LLD() {}\n')],
		['bin/lld.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])],
		['bin/lld.data', Buffer.from('linker-data')]
	]);
	for (const [name, entries] of [
		['etc/ldc2.conf.tar.zst', { 'ldc2.conf/wasm.conf': 'target wasm32-wasi\n' }],
		['lib/imports.tar.zst', { 'std/stdio.d': 'module std.stdio;\n' }],
		['lib/runtime-libs.tar.zst', { 'lib/libphobos2-ldc.a': '!<arch>\n' }]
	]) {
		const content = path.join(root, `tree-${inputs.size}`);
		for (const [entry, text] of Object.entries(entries)) await writeArtifact(content, entry, Buffer.from(text));
		if (archiveSymlink && name.startsWith('etc/')) await symlink('/etc/passwd', path.join(content, 'escape'));
		const archive = path.join(root, `archive-${inputs.size}.tar.zst`);
		await run('tar', ['--zstd', '-cf', archive, '-C', content, '.']);
		inputs.set(name, await readFile(archive));
	}
	for (const [name, bytes] of inputs) await writeArtifact(sourceDir, name, bytes);
	const contract = structuredClone(await loadContract());
	contract.lock.assets = [...inputs].map(([name, bytes]) => describeArtifact(name, bytes));
	const sourceManifest = jsonBytes({ manifestVersion: 1, name: 'ldc-wasm', version: contract.lock.profileId, defaultTarget: 'wasm32-wasi' });
	const sourceBuild = jsonBytes({ assets: contract.lock.assets.map((entry) => ({ asset: entry.path, size: entry.bytes, sha256: entry.sha256 })) });
	await writeArtifact(sourceDir, 'runtime-manifest.v1.json', sourceManifest);
	await writeArtifact(sourceDir, 'runtime-build.json', sourceBuild);
	contract.lock.sourceManifest = describeArtifact('runtime-manifest.v1.json', sourceManifest);
	contract.lock.sourceBuild = describeArtifact('runtime-build.json', sourceBuild);
	contract.lock.outputs = contract.lock.outputs.map(({ path: name }) => {
		const raw = inputs.get(name.endsWith('.gz') ? name.slice(0, -3) : name);
		return raw ? name.endsWith('.gz') ? { path: name, uncompressedBytes: raw.length, uncompressedSha256: sha256(raw) }
			: describeArtifact(name, raw) : { path: name };
	});
	return { root, sourceDir, outputDir: path.join(root, 'output'), contract };
}

test('packages an exact deterministic receipt graph and validates compiler metadata', async () => {
	const value = await fixture();
	const first = await packageD(value);
	assert.equal(first.artifacts.length, 7);
	assert.deepEqual(await verifyDArtifacts(value.outputDir, value.contract), first);
	const second = await packageD({ ...value, outputDir: path.join(value.root, 'second') });
	assert.deepEqual(second, first);
	const manifest = JSON.parse(await readFile(path.join(value.outputDir, 'runtime-manifest.v1.json')));
	assert.equal(manifest.compiler.ldc2.integrity.uncompressedSha256, value.contract.lock.assets[0].sha256);
	assert.equal(manifest.compiler.linker.wasm.asset, 'bin/lld.wasm.gz');
});

test('normalizes toolchain modes and ignores caller tar options', async () => {
	const value = await fixture();
	const first = await packageD(value);
	const savedUmask = process.umask();
	const savedEnv = { TAR_OPTIONS: process.env.TAR_OPTIONS, POSIXLY_CORRECT: process.env.POSIXLY_CORRECT };
	try {
		for (const [index, mask] of [0o002, 0o077].entries()) {
			process.umask(mask);
			assert.deepEqual(await packageD({ ...value, outputDir: path.join(value.root, `umask-${index}`) }), first);
		}
		process.umask(savedUmask);
		Object.assign(process.env, { TAR_OPTIONS: '--format=posix', POSIXLY_CORRECT: '1' });
		assert.deepEqual(await packageD({ ...value, outputDir: path.join(value.root, 'caller-env') }), first);
	} finally {
		process.umask(savedUmask);
		for (const [key, saved] of Object.entries(savedEnv)) {
			if (saved === undefined) delete process.env[key];
			else process.env[key] = saved;
		}
	}
});

test('rejects a changed finalized compiler before publication and preserves an existing output', async () => {
	const value = await fixture();
	await mkdir(value.outputDir);
	await writeFile(path.join(value.outputDir, 'keep'), 'prior output');
	await writeFile(path.join(value.sourceDir, 'bin/ldc2.wasm'), 'changed');
	await assert.rejects(packageD(value), /pinned size and SHA-256/u);
	assert.equal(await readFile(path.join(value.outputDir, 'keep'), 'utf8'), 'prior output');
});

test('rejects symlinked source files and archive links even when a fixture lock describes the archive', async () => {
	const value = await fixture();
	await rm(path.join(value.sourceDir, 'bin/lld.js'));
	await symlink('/etc/passwd', path.join(value.sourceDir, 'bin/lld.js'));
	await assert.rejects(packageD(value), /regular file/u);
	await assert.rejects(packageD(await fixture({ archiveSymlink: true })), /only regular files/u);
});

test('rejects source/output overlap and never overwrites a published directory', async () => {
	const value = await fixture();
	await assert.rejects(packageD({ ...value, outputDir: path.join(value.sourceDir, 'nested') }), /overlap/u);
	await packageD(value);
	const receipt = await readFile(path.join(value.outputDir, 'producer-receipt.json'));
	await assert.rejects(packageD(value), /already exists/u);
	assert.deepEqual(await readFile(path.join(value.outputDir, 'producer-receipt.json')), receipt);
});

test('rejects recomputed self-receipts for altered native bytes or compiler metadata', async () => {
	const value = await fixture();
	await packageD(value);
	const receiptPath = path.join(value.outputDir, 'producer-receipt.json');
	const receipt = JSON.parse(await readFile(receiptPath));
	const altered = gzipSync(Buffer.from('different compiler'));
	await writeFile(path.join(value.outputDir, 'bin/ldc2.wasm.gz'), altered);
	receipt.artifacts[0] = describeArtifact('bin/ldc2.wasm.gz', altered, 'gzip');
	await writeFile(receiptPath, jsonBytes(receipt));
	await assert.rejects(verifyDArtifacts(value.outputDir, value.contract), /does not match its contract/u);
	const next = await fixture();
	await packageD(next);
	const nextReceiptPath = path.join(next.outputDir, 'producer-receipt.json');
	const nextReceipt = JSON.parse(await readFile(nextReceiptPath));
	const badManifest = jsonBytes({ compiler: { ldc2: { asset: 'https://unexpected.test/compiler.wasm' } } });
	await writeFile(path.join(next.outputDir, 'runtime-manifest.v1.json'), badManifest);
	nextReceipt.artifacts = nextReceipt.artifacts.map((entry) => entry.path === 'runtime-manifest.v1.json' ? describeArtifact(entry.path, badManifest) : entry);
	await writeFile(nextReceiptPath, jsonBytes(nextReceipt));
	await assert.rejects(verifyDArtifacts(next.outputDir, next.contract), /pinned size and SHA-256/u);
});

test('rejects undeclared files and forged producer identities', async () => {
	const value = await fixture();
	await packageD(value);
	await writeFile(path.join(value.outputDir, 'extra'), 'undeclared');
	await assert.rejects(verifyDArtifacts(value.outputDir, value.contract), /file set/u);
	await rm(path.join(value.outputDir, 'extra'));
	const file = path.join(value.outputDir, 'producer-receipt.json');
	const receipt = JSON.parse(await readFile(file));
	receipt.manifestSha256 = '0'.repeat(64);
	await writeFile(file, jsonBytes(receipt));
	await assert.rejects(verifyDArtifacts(value.outputDir, value.contract), /manifestSha256/u);
});
