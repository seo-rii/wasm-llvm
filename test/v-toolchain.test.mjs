import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verify } from '../producer/v-browser/scripts/verify-artifacts.mjs';
import { V_LINK_FLAGS } from '../producer/v-browser/scripts/smoke.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
	await readFile(path.join(REPO_ROOT, 'producer/v-browser/manifest.json'), 'utf8')
);

test('pins the V release source and its upstream vc bootstrap translation', () => {
	assert.equal(manifest.sources.v.version, '0.5.2');
	assert.match(manifest.sources.v.commit, /^[0-9a-f]{40}$/);
	assert.match(manifest.sources.vc.commit, /^[0-9a-f]{40}$/);
	assert.match(manifest.sources.vc.sha256, /^[0-9a-f]{64}$/);
	assert.ok(manifest.sources.vc.url.includes(manifest.sources.vc.commit));
});

test('builds the compiler at -Os and keeps linear-memory data above 64 KiB', () => {
	// Clang -O2 miscompiles the V checker for wasm32; V treats addresses <= 0xFFFF as invalid.
	assert.ok(manifest.compiler.cflags.includes('-Os'));
	assert.ok(!manifest.compiler.cflags.some((flag) => /^-O[23]$/.test(flag)));
	assert.ok(manifest.compiler.ldflags.includes('-Wl,--no-stack-first'));
	assert.ok(manifest.compiler.ldflags.includes('-Wl,--global-base=65536'));
	assert.ok(V_LINK_FLAGS.includes('--no-stack-first'));
	assert.ok(V_LINK_FLAGS.includes('--global-base=65536'));
});

test('keeps build temporaries inside the producer cache and removes large build trees', async () => {
	const source = await readFile(path.join(REPO_ROOT, 'producer/v-browser/scripts/build.sh'), 'utf8');
	assert.match(source, /TMPDIR=\$\{TMPDIR:-\$CACHE_ROOT\/tmp\}\nexport TMPDIR/);
	assert.match(source, /fetch -q --depth 1/);
	assert.match(source, /rm -rf "\$BUILD_DIR" "\$VROOT_ROOT" "\$C_SYSROOT_ROOT"/);
});

test('verifies the checked-in V artifacts and their compile/run acceptance', async () => {
	const receipt = await verify(path.join(REPO_ROOT, 'artifacts/v-browser'));
	assert.equal(receipt.vVersion, '0.5.2');
	assert.equal(receipt.acceptance.results.stdinStdout, true);
	assert.equal(receipt.acceptance.results.rejectedInvalidSource, true);
});

test('rejects truthy acceptance flags, malformed identities and different fixtures', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'v-receipt-'));
	try {
		await cp(path.join(REPO_ROOT, 'artifacts/v-browser'), directory, { recursive: true });
		const original = JSON.parse(await readFile(path.join(directory, 'toolchain.json'), 'utf8'));
		const mutations = [
			(receipt) => { receipt.acceptance.results.rejectedInvalidSource = 'false'; },
			(receipt) => { receipt.acceptance.results.translatedSource = 1; },
			(receipt) => { receipt.acceptance.results.stdinStdout = 'true'; },
			(receipt) => { receipt.acceptance.results.program.sha256 = 'invalid'; },
			(receipt) => { receipt.acceptance.results.program.bytes = -1; },
			(receipt) => { receipt.acceptance.compiler.bytes++; },
			(receipt) => { receipt.acceptance.fixtures['fixtures/program.v'] = '0'.repeat(64); }
		];
		for (const mutate of mutations) {
			const receipt = structuredClone(original);
			mutate(receipt);
			await writeFile(path.join(directory, 'toolchain.json'), JSON.stringify(receipt));
			await assert.rejects(verify(directory), /acceptance|compiler size|fixture/);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
