import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertCleanCheckout, assertPreparedInputs, assertReceipt, producerRoot, resetSdkGeneratedFiles, run, sha256, treeHash } from '../scripts/producer.mjs';
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

test('prepare removes mutable SDK installation paths before reinstalling', async () => {
	const directory = await makeCheckout();
	try {
		await writeFile(path.join(directory, 'ignored.h'), '#define injected 1');
		await run('git', ['-C', directory, 'check-ignore', '--quiet', 'ignored.h'], { capture: true });
		await assert.rejects(assertCleanCheckout(directory), /untracked or ignored/u);
		await assert.rejects(assertCleanCheckout(directory, { sdkGeneratedFiles: true }), /untracked or ignored/u);
		await rm(path.join(directory, 'ignored.h'));
		await mkdir(path.join(directory, 'upstream'));
		await mkdir(path.join(directory, 'upstream/emscripten'));
		await writeFile(path.join(directory, 'upstream/emscripten/emcc'), 'modified SDK component');
		await assert.rejects(assertCleanCheckout(directory), /untracked or ignored/u);
		await assertCleanCheckout(directory, { sdkGeneratedFiles: true });
		await resetSdkGeneratedFiles(directory);
		await assert.rejects(readFile(path.join(directory, 'upstream/emscripten/emcc')), /ENOENT/u);
		await assertCleanCheckout(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('build rejects changes to the prepared Emscripten SDK tree', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'c3-prepared-inputs-'));
	try {
		const p = { source: path.join(directory, 'source'), llvm: path.join(directory, 'llvm'), sdk: path.join(directory, 'sdk') };
		for (const name of Object.values(p)) await mkdir(name);
		await writeFile(path.join(p.source, 'main.c'), 'int main() { return 0; }');
		await writeFile(path.join(p.llvm, 'libLLVM.a'), 'pinned LLVM');
		await mkdir(path.join(p.sdk, 'upstream'));
		await writeFile(path.join(p.sdk, 'upstream/emcc'), 'pinned emcc');
		const prepared = {
			manifestSha256: sha256(await readFile(path.join(producerRoot, 'manifest.json'))),
			sourceTreeSha256: await treeHash(p.source),
			llvmTreeSha256: await treeHash(p.llvm),
			sdkTreeSha256: await treeHash(p.sdk)
		};
		await assertPreparedInputs(p, prepared);
		await writeFile(path.join(p.sdk, 'upstream/emcc'), 'modified emcc');
		await assert.rejects(assertPreparedInputs(p, prepared), /Emscripten SDK tree changed/u);
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
		const release = path.join(directory, 'release');
		await mkdir(release);
		await writeFile(path.join(release, 'c3c.mjs'), 'not loaded');
		await writeFile(path.join(release, 'c3c.wasm'), 'not loaded');
		await writeFile(path.join(release, 'producer-receipt.json'), JSON.stringify({
			schemaVersion: 1, producerId: 'wasm-llvm/c3-browser', manifestSha256, build,
			assets: { 'c3c.mjs': {}, 'c3c.wasm': {} }, smoke: stale, browserSmoke: stale
		}));
		await assert.rejects(verify(release), /acceptance inputs changed/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('package and verify reject extra release directory entries', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'c3-release-files-'));
	try {
		const buildDirectory = path.join(directory, 'build');
		const release = path.join(directory, 'release');
		await mkdir(buildDirectory);
		await mkdir(release);
		const manifestSha256 = sha256(await readFile(path.join(producerRoot, 'manifest.json')));
		const assets = {
			'c3c.mjs': Buffer.from('export default function () {}'),
			'c3c.wasm': Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])
		};
		const assetReceipts = Object.fromEntries(Object.entries(assets).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha256(bytes) }]));
		const checks = { compileOnly: true, invalidSourceDiagnostic: true, builtinLink: true, arithmetic: true, hostByteInputOutput: true };
		const smoke = { checks, inputs: await acceptanceHashes(), assets: assetReceipts };
		const browserSmoke = { ...smoke, checks: { ...checks, browserGuest: true } };
		for (const [name, bytes] of Object.entries(assets)) await writeFile(path.join(buildDirectory, name), bytes);
		await writeFile(path.join(buildDirectory, 'build-receipt.json'), JSON.stringify({
			manifestSha256,
			builderSha256: sha256(await readFile(path.join(producerRoot, 'scripts/producer.mjs'))),
			assets: assetReceipts
		}));
		await writeFile(path.join(buildDirectory, 'smoke.json'), JSON.stringify(smoke));
		await writeFile(path.join(buildDirectory, 'browser-smoke.json'), JSON.stringify(browserSmoke));
		await writeFile(path.join(release, 'stale-runtime.js'), 'stale');
		await assert.rejects(packageCompiler({ build: buildDirectory, release }), /Unexpected C3 release entries/u);
		await rm(path.join(release, 'stale-runtime.js'));
		await packageCompiler({ build: buildDirectory, release });
		await writeFile(path.join(release, 'stale-runtime.js'), 'stale');
		await assert.rejects(verify(release), /Unexpected C3 release entries/u);
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
		await writeFile(path.join(directory, 'c3c.mjs'), 'not loaded');
		await writeFile(path.join(directory, 'c3c.wasm'), 'not loaded');
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
