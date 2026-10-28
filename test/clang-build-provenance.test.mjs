import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { downloadPinned, emsdkShellCommand, extractPinnedArchive, pinnedCommitPatch, verifyPatchedCheckout } from '../producer/clang-browser/scripts/build-provenance.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
async function temporary(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clang-provenance-test-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	return root;
}

test('SDK activation cannot redirect generated libraries into the recorded SDK tree', async (t) => {
	const root = await temporary(t);
	const environment = path.join(root, "SDK's environment.sh");
	const cache = path.join(root, "build's private cache");
	const inherited = path.join(root, 'installed-cache');
	await fs.mkdir(cache);
	await fs.mkdir(inherited);
	await fs.writeFile(environment, 'unset EM_CACHE\n');
	const result = execFileSync('bash', ['-c', emsdkShellCommand(environment, cache,
		'printf generated > "$EM_CACHE/library.a"; printf "%s" "$EM_CACHE"')],
		{ env: { ...process.env, EM_CACHE: inherited }, encoding: 'utf8' });
	assert.equal(result, cache);
	assert.equal(await fs.readFile(path.join(cache, 'library.a'), 'utf8'), 'generated');
	assert.deepEqual(await fs.readdir(inherited), []);
});
const git = (source, ...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function checkout(t) {
	const source = await temporary(t);
	git(source, 'init');
	git(source, 'config', 'user.email', 'test@example.invalid');
	git(source, 'config', 'user.name', 'Test');
	await fs.writeFile(path.join(source, 'source.c'), 'original\n');
	git(source, 'add', '.');
	git(source, 'commit', '-m', 'base');
	const commit = git(source, 'rev-parse', 'HEAD');
	await fs.writeFile(path.join(source, 'source.c'), 'patched\n');
	git(source, 'commit', '-am', 'patch');
	const patchCommit = git(source, 'rev-parse', 'HEAD');
	git(source, 'reset', '--hard', commit);
	return { source, commit, patchCommit };
}

test('download cache reuses valid bytes and repairs partial bytes only after verification', async (t) => {
	const root = await temporary(t);
	const target = path.join(root, 'archive');
	const good = Buffer.from('verified archive');
	let calls = 0;
	const fetchImpl = async () => { calls += 1; return new Response(good); };
	await fs.writeFile(target, 'partial');
	await downloadPinned('https://example.invalid/archive', target, sha256(good), { fetchImpl });
	assert.deepEqual(await fs.readFile(target), good);
	await downloadPinned('https://example.invalid/archive', target, sha256(good), { fetchImpl });
	assert.equal(calls, 1);
});

test('failed downloads never replace the previous cache or leave partial files', async (t) => {
	const root = await temporary(t);
	const target = path.join(root, 'archive');
	await fs.writeFile(target, 'previous');
	for (const fetchImpl of [async () => new Response('wrong'), async () => new Response(null, { status: 503 })]) {
		await assert.rejects(downloadPinned('https://example.invalid/archive', target, sha256('correct'), { fetchImpl }));
		assert.equal(await fs.readFile(target, 'utf8'), 'previous');
		assert.deepEqual(await fs.readdir(root), ['archive']);
	}
});

test('extraction commits only a completed digest-bound directory', async (t) => {
	const root = await temporary(t);
	const archive = path.join(root, 'archive');
	const destination = path.join(root, 'extracted');
	await fs.writeFile(archive, 'archive');
	const digest = sha256('archive');
	await assert.rejects(extractPinnedArchive(archive, destination, digest, async () => { throw new Error('tar failed'); }), /tar failed/);
	assert.deepEqual(await fs.readdir(root), ['archive']);
	let calls = 0;
	await extractPinnedArchive(archive, destination, digest, async (_, args) => {
		calls += 1;
		await fs.writeFile(path.join(args.at(-1), 'compiler'), 'compiler');
	});
	await extractPinnedArchive(archive, destination, digest, async () => { calls += 1; });
	assert.equal(calls, 1);
	await fs.writeFile(path.join(destination, '.archive-sha256'), 'obsolete');
	await assert.rejects(extractPinnedArchive(archive, destination, digest, async () => {}), /Incomplete extraction cache/);
});

test('source verification accepts only the complete expected patch tree and preserves the real index', async (t) => {
	const { source, commit, patchCommit } = await checkout(t);
	const marker = path.join(source, '.patch-marker');
	const result = await pinnedCommitPatch(source, source, patchCommit, marker);
	await fs.writeFile(marker, `${JSON.stringify(result.identity)}\n`);
	const options = { source, commit, patches: [result.patch], allowedUntracked: ['.patch-marker'] };
	const indexBefore = git(source, 'write-tree');
	const identity = await verifyPatchedCheckout(options);
	assert.match(identity.diffSha256, /^[a-f0-9]{64}$/);
	assert.equal(git(source, 'write-tree'), indexBefore);
	await fs.writeFile(path.join(source, 'source.c'), 'unrelated edit\n');
	await assert.rejects(verifyPatchedCheckout(options), /differs from the pinned commit/);
	await fs.writeFile(path.join(source, 'source.c'), 'patched\n');
	await fs.writeFile(path.join(source, 'injected.h'), 'unexpected');
	await assert.rejects(verifyPatchedCheckout(options), /Unexpected source files/);
});

test('a leftover patch marker cannot bless a reverted patch, and changed marker pins are rejected', async (t) => {
	const { source, commit, patchCommit } = await checkout(t);
	const marker = path.join(source, '.patch-marker');
	await fs.writeFile(marker, `${source}\n${patchCommit}\n`);
	const result = await pinnedCommitPatch(source, source, patchCommit, marker);
	await assert.rejects(verifyPatchedCheckout({ source, commit, patches: [result.patch], allowedUntracked: ['.patch-marker'] }), /differs from the pinned commit/);
	await fs.writeFile(marker, `other-repository\n${patchCommit}\n`);
	await assert.rejects(pinnedCommitPatch(source, source, patchCommit, marker), /marker does not match/);
});

test('clean toolchain checkout rejects tracked and untracked source changes', async (t) => {
	const { source, commit } = await checkout(t);
	await verifyPatchedCheckout({ source, commit });
	await fs.writeFile(path.join(source, 'source.c'), 'changed\n');
	await assert.rejects(verifyPatchedCheckout({ source, commit }), /differs from the pinned commit/);
});

async function receiptFixture() {
	const { makeBuildReceipt } = await import('./fixtures/clang/artifacts.mjs');
	const inputs = Object.fromEntries(['clang', 'lld', 'memfs', 'memfsReceipt', 'sysroot', 'clangdJs', 'clangdWasm'].map((name) => [name, Buffer.from(name)]));
	return { inputs, receipt: await makeBuildReceipt(inputs) };
}

test('receipt verification rejects binaries or sysroots from another build', async () => {
	const { verifyClangBuildReceipt } = await import('../producer/clang-browser/scripts/build-provenance.mjs');
	const { inputs, receipt } = await receiptFixture();
	await verifyClangBuildReceipt(receipt, inputs);
	for (const name of Object.keys(inputs)) {
		await assert.rejects(verifyClangBuildReceipt(receipt, { ...inputs, [name]: Buffer.from('another build') }), new RegExp(`${name} input identity mismatch`));
	}
});

test('receipt verification requires current recipe, manifest, source, patches and tool identities', async () => {
	const { verifyClangBuildReceipt } = await import('../producer/clang-browser/scripts/build-provenance.mjs');
	const { inputs, receipt } = await receiptFixture();
	for (const mutate of [
		(value) => { value.manifestSha256 = '0'.repeat(64); },
		(value) => { value.sources.llvm.commit = 'main'; },
		(value) => { value.sources.llvm.patches.pop(); },
		(value) => { delete value.tools.wasiClang; },
		(value) => { delete value.tools.wasiAr; },
		(value) => { delete value.installedToolchains.emsdkUpstream; },
		(value) => { value.buildMode = 'reused'; },
		(value) => { value.recipe.files[0].sha256 = '0'.repeat(64); value.recipe.sha256 = sha256(JSON.stringify(value.recipe.files)); },
		(value) => { value.inputs.clang.bytes = '5'; }
	]) {
		const altered = structuredClone(receipt);
		mutate(altered);
		await assert.rejects(verifyClangBuildReceipt(altered, inputs), /Clang build receipt:/);
	}
});

test('ignored source injections are rejected unless explicitly allowed for SDK installation outputs', async (t) => {
	const { source, commit } = await checkout(t);
	await fs.writeFile(path.join(source, '.git', 'info', 'exclude'), 'injected.h\n');
	await fs.writeFile(path.join(source, 'injected.h'), 'injected');
	await assert.rejects(verifyPatchedCheckout({ source, commit }), /Unexpected source files/);
	await verifyPatchedCheckout({ source, commit, allowIgnored: true });
});

test('receipt header mode and header bytes must agree with the actual package inputs', async () => {
	const { verifyClangBuildReceipt } = await import('../producer/clang-browser/scripts/build-provenance.mjs');
	const { inputs, receipt } = await receiptFixture();
	const headers = Buffer.from('headers');
	await assert.rejects(verifyClangBuildReceipt(receipt, { ...inputs, clangdHeaders: headers }), /separate header inputs/);
	receipt.buildOptions.clangdSeparateHeaders = 'ON';
	receipt.inputs.clangdHeaders = { bytes: headers.length, sha256: sha256(headers) };
	await assert.rejects(verifyClangBuildReceipt(receipt, inputs), /clangdHeaders input identity mismatch/);
	await verifyClangBuildReceipt(receipt, { ...inputs, clangdHeaders: headers });
});

test('verified build directories are claimed exclusively and existing outputs are preserved and rejected', async (t) => {
	const { claimFreshBuildDirectory } = await import('../producer/clang-browser/scripts/build-provenance.mjs');
	const root = await temporary(t);
	const fresh = path.join(root, 'fresh');
	const claims = await Promise.allSettled([claimFreshBuildDirectory(fresh), claimFreshBuildDirectory(fresh)]);
	assert.equal(claims.filter((result) => result.status === 'fulfilled').length, 1);
	for (const name of ['native', 'wasi-raw', 'clangd']) {
		const directory = path.join(root, name);
		await fs.mkdir(path.join(directory, name), { recursive: true });
		const output = path.join(directory, name, 'cached-output');
		await fs.writeFile(output, 'old binary from another compiler');
		await assert.rejects(claimFreshBuildDirectory(directory), /fresh empty build directory/);
		assert.equal(await fs.readFile(output, 'utf8'), 'old binary from another compiler');
	}
	const alias = path.join(root, 'alias');
	const empty = path.join(root, 'empty');
	await fs.mkdir(empty);
	await fs.symlink(empty, alias);
	await assert.rejects(claimFreshBuildDirectory(alias), /fresh empty build directory/);
});

test('installed SDK identities detect ignored helper and sysroot changes while compiler bytes stay the same', async (t) => {
	const { directoryIdentity, fileIdentity, assertDirectoryUnchanged } = await import('../producer/clang-browser/scripts/build-provenance.mjs');
	const { source, commit } = await checkout(t);
	await fs.writeFile(path.join(source, '.git/info/exclude'), 'upstream/\n');
	const upstream = path.join(source, 'upstream');
	await fs.mkdir(path.join(upstream, 'emscripten/tools'), { recursive: true });
	const compiler = path.join(upstream, 'clang');
	const helper = path.join(upstream, 'emscripten/tools/link.py');
	await fs.writeFile(compiler, 'same compiler');
	await fs.writeFile(helper, 'original helper');
	const initial = await directoryIdentity(upstream);
	const compilerBefore = await fileIdentity(compiler);
	await fs.writeFile(helper, 'modified helper');
	await verifyPatchedCheckout({ source, commit, allowIgnored: true });
	assert.deepEqual(await fileIdentity(compiler), compilerBefore);
	await assert.rejects(assertDirectoryUnchanged(upstream, initial, 'Installed Emscripten SDK'), /changed during compilation/);
	const sdk = path.join(await temporary(t), 'sdk');
	await fs.mkdir(path.join(sdk, 'share/wasi-sysroot/include'), { recursive: true });
	const header = path.join(sdk, 'share/wasi-sysroot/include/stdio.h');
	await fs.writeFile(header, 'original header');
	const sdkBefore = await directoryIdentity(sdk);
	await fs.writeFile(header, 'modified header');
	await assert.rejects(assertDirectoryUnchanged(sdk, sdkBefore, 'Installed WASI SDK'), /changed during compilation/);
	await fs.symlink(helper, path.join(sdk, 'external-helper'));
	await assert.rejects(directoryIdentity(sdk), /symlink escapes/);
});

test('manifest edits during a build are rejected against its initial exact bytes', async (t) => {
	const { fileIdentity, assertFileUnchanged } = await import('../producer/clang-browser/scripts/build-provenance.mjs');
	const root = await temporary(t);
	const manifest = path.join(root, 'manifest.json');
	await fs.writeFile(manifest, JSON.stringify({ sources: { llvm: { commit: 'a'.repeat(40) } } }));
	const initial = await fileIdentity(manifest);
	await assertFileUnchanged(manifest, initial, 'Producer manifest');
	await fs.writeFile(manifest, JSON.stringify({ sources: { llvm: { commit: 'b'.repeat(40) } } }));
	await assert.rejects(assertFileUnchanged(manifest, initial, 'Producer manifest'), /Producer manifest changed during compilation/);
});
