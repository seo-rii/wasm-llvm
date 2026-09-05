import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertCleanCheckout, assertReceipt, producerRoot, run, sha256, treeHash } from '../scripts/producer.mjs';
import { packageCompiler, requireSmokeChecks, verify } from '../scripts/package.mjs';
import { acceptanceHashes, acceptanceInputs, assertAcceptanceInputs } from '../scripts/evidence.mjs';

async function makeCheckout() {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'c3-checkout-'));
	await run('git', ['init', '--quiet', directory], { capture: true });
	await writeFile(path.join(directory, 'main.c'), 'int main() { return 0; }');
	await writeFile(path.join(directory, '.gitignore'), 'ignored.h\n');
	await run('git', ['-C', directory, 'add', '.'], { capture: true });
	await run('git', ['-C', directory, '-c', 'user.name=C3 producer test', '-c', 'user.email=c3@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'test fixture'], { capture: true });
	return directory;
}

test('rejects a truncated or altered pinned compiler dependency', () => {
	const bytes = Buffer.from('pinned LLVM archive');
	const receipt = { bytes: bytes.length, sha256: sha256(bytes) };
	assert.doesNotThrow(() => assertReceipt(bytes, receipt, 'archive'));
	assert.throws(() => assertReceipt(bytes.subarray(1), receipt, 'archive'), /pinned size and SHA-256/u);
	assert.throws(() => assertReceipt(Buffer.from('pinned LLVM archivE'), receipt, 'archive'), /pinned size and SHA-256/u);
});

test('source fingerprint detects edits and extra build inputs', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'c3-source-'));
	try {
		await mkdir(path.join(directory, 'src'));
		await writeFile(path.join(directory, 'src/main.c'), 'int main() { return 0; }');
		const original = await treeHash(directory);
		await writeFile(path.join(directory, 'src/main.c'), 'int main() { return 1; }');
		assert.notEqual(await treeHash(directory), original);
		await writeFile(path.join(directory, 'src/main.c'), 'int main() { return 0; }');
		await writeFile(path.join(directory, 'src/injected.h'), '#define x 1');
		assert.notEqual(await treeHash(directory), original);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('prepare rejects tracked changes hidden by Git index flags', async () => {
	const directory = await makeCheckout();
	try {
		await assertCleanCheckout(directory);
		await run('git', ['-C', directory, 'update-index', '--assume-unchanged', 'main.c'], { capture: true });
		await writeFile(path.join(directory, 'main.c'), 'int main() { return 1; }');
		await assert.rejects(assertCleanCheckout(directory), /index flags/u);
		await run('git', ['-C', directory, 'update-index', '--no-assume-unchanged', 'main.c'], { capture: true });
		await run('git', ['-C', directory, 'update-index', '--skip-worktree', 'main.c'], { capture: true });
		await assert.rejects(assertCleanCheckout(directory), /index flags/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('prepare rejects ignored C3 inputs and only allows named SDK installation paths', async () => {
	const directory = await makeCheckout();
	try {
		await writeFile(path.join(directory, 'ignored.h'), '#define injected 1');
		await run('git', ['-C', directory, 'check-ignore', '--quiet', 'ignored.h'], { capture: true });
		await assert.rejects(assertCleanCheckout(directory), /untracked or ignored/u);
		await assert.rejects(assertCleanCheckout(directory, { sdkGeneratedFiles: true }), /untracked or ignored/u);
		await rm(path.join(directory, 'ignored.h'));
		await mkdir(path.join(directory, 'upstream'));
		await writeFile(path.join(directory, 'upstream/emcc'), 'installed SDK component');
		await assert.rejects(assertCleanCheckout(directory), /untracked or ignored/u);
		await assertCleanCheckout(directory, { sdkGeneratedFiles: true });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('acceptance evidence expires when source fixtures or compiler harnesses change', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'c3-acceptance-'));
	try {
		for (const name of acceptanceInputs) {
			await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
			await writeFile(path.join(directory, name), `original ${name}`);
		}
		const original = { inputs: await acceptanceHashes(directory) };
		await assertAcceptanceInputs(original, directory);
		for (const name of ['fixtures/program.c3', 'scripts/smoke-worker.mjs']) {
			await writeFile(path.join(directory, name), `changed ${name}`);
			await assert.rejects(assertAcceptanceInputs(original, directory), /acceptance inputs changed/u);
			await writeFile(path.join(directory, name), `original ${name}`);
		}
		await assertAcceptanceInputs(original, directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('package and verify reject stale acceptance before copying or loading assets', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'c3-stale-smoke-'));
	try {
		const manifestSha256 = sha256(await readFile(path.join(producerRoot, 'manifest.json')));
		const build = {
			manifestSha256,
			builderSha256: sha256(await readFile(path.join(producerRoot, 'scripts/producer.mjs')))
		};
		const stale = {
			checks: { compileOnly: true, invalidSourceDiagnostic: true, builtinLink: true, arithmetic: true, hostByteInputOutput: true, browserGuest: true },
			inputs: { ...await acceptanceHashes(), 'fixtures/program.c3': '0'.repeat(64) }
		};
		await writeFile(path.join(directory, 'build-receipt.json'), JSON.stringify(build));
		await writeFile(path.join(directory, 'smoke.json'), JSON.stringify(stale));
		await writeFile(path.join(directory, 'browser-smoke.json'), JSON.stringify(stale));
		await assert.rejects(packageCompiler({ build: directory, release: path.join(directory, 'release') }), /acceptance inputs changed/u);
		await writeFile(path.join(directory, 'producer-receipt.json'), JSON.stringify({
			schemaVersion: 1, producerId: 'wasm-llvm/c3-browser', manifestSha256, build,
			assets: { 'c3c.mjs': {}, 'c3c.wasm': {} }, smoke: stale, browserSmoke: stale
		}));
		await assert.rejects(verify(directory), /acceptance inputs changed/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('a Wasm header or compile-only result cannot qualify complete smoke evidence', () => {
	assert.throws(() => requireSmokeChecks({ checks: { compileOnly: true } }), /invalidSourceDiagnostic/u);
	assert.throws(() => requireSmokeChecks({ checks: { compileOnly: true, invalidSourceDiagnostic: true, builtinLink: false } }), /builtinLink/u);
});

test('prepared LLVM symlinks stay within their pinned tree', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'c3-llvm-'));
	try {
		await writeFile(path.join(directory, 'lld.js'), 'pinned loader');
		await symlink('lld.js', path.join(directory, 'ld.lld.js'));
		assert.equal(typeof await treeHash(directory), 'string');
		await symlink('../outside', path.join(directory, 'escaped'));
		await assert.rejects(treeHash(directory), /Symlink escapes prepared tree/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('artifact verification rejects receipts from another manifest before loading assets', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'c3-receipt-'));
	try {
		await writeFile(path.join(directory, 'producer-receipt.json'), JSON.stringify({ schemaVersion: 1, producerId: 'wasm-llvm/c3-browser', manifestSha256: '0'.repeat(64) }));
		await assert.rejects(verify(directory), /producer manifest/u);
		const manifestSha256 = sha256(await readFile(path.join(producerRoot, 'manifest.json')));
		await writeFile(path.join(directory, 'producer-receipt.json'), JSON.stringify({ schemaVersion: 1, producerId: 'wasm-llvm/c3-browser', manifestSha256, assets: { '../outside': {} } }));
		await assert.rejects(verify(directory), /exactly the compiler loader/u);
		await writeFile(path.join(directory, 'producer-receipt.json'), JSON.stringify({ schemaVersion: 1, producerId: 'wasm-llvm/c3-browser', manifestSha256, assets: { 'c3c.mjs': {}, 'c3c.wasm': {} }, build: { manifestSha256, builderSha256: '0'.repeat(64) } }));
		await assert.rejects(verify(directory), /different manifest or build script/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
