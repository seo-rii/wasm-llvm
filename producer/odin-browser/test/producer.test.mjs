import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
	fileIdentity, inspectWasm, loadManifest, nativeBaseline, parseArgs,
	run, verifyBaseline, verifyNative, verifySource
} from '../scripts/producer.mjs';

async function temporary(t) {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'odin-producer-test-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

function git(directory, args) {
	const result = run('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null',
		'-c', 'user.name=Odin producer test', '-c', 'user.email=odin-test@example.invalid', ...args]);
	assert.equal(result.exitCode, 0, result.stderr);
	return result.stdout.trim();
}

async function sourceFixture(t) {
	const directory = await temporary(t);
	git(directory, ['init']);
	await writeFile(path.join(directory, 'main.cpp'), 'int main() { return 0; }\n');
	await writeFile(path.join(directory, 'helper.cpp'), 'int helper;\n');
	await writeFile(path.join(directory, '.gitignore'), 'ignored.cpp\n');
	git(directory, ['add', '.']);
	git(directory, ['commit', '-m', 'fixture']);
	const manifest = {
		source: { repository: 'https://example.invalid/source.git', commit: git(directory, ['rev-parse', 'HEAD']),
			files: [{ path: 'main.cpp', sha256: (await fileIdentity(path.join(directory, 'main.cpp'))).sha256 }] }
	};
	return { directory, manifest };
}

test('keeps native target evidence separate from browser compiler readiness', async () => {
	const manifest = await loadManifest();
	assert.equal(manifest.programTarget, 'wasi_wasm32');
	assert.equal(manifest.compilerHost, 'wasm32-unknown-emscripten');
	assert.equal(manifest.readiness.ready, false);
	assert.equal(manifest.readiness.browserCompiler, 'not-built');
	assert.equal(manifest.source.commit, 'a2fb372b76e81ef31fbbc8a2cf2b4fdf5ac6c924');
	assert.equal(manifest.nativeBootstrap.llvmVersion, '20.1.8');
	assert.equal(manifest.hostProbe.llvmHeaders.version, '22.1.8');
});

test('CLI rejects missing, duplicate, command-specific, and unknown options before work starts', () => {
	assert.throws(() => parseArgs(['probe-host', '--source', '.']), /missing option/);
	assert.throws(() => parseArgs(['prepare', '--work', 'a', '--work', 'b']), /duplicate/);
	assert.throws(() => parseArgs(['prepare', '--source', '.']), /unknown option/);
	assert.throws(() => parseArgs(['prepare', '--work', '--execute']), /missing value/);
	assert.throws(() => parseArgs(['build-browser']), /Usage/);
});

test('source identity rejects a different commit and source-byte changes', async (t) => {
	const { directory, manifest } = await sourceFixture(t);
	assert.equal((await verifySource(directory, manifest)).commit, manifest.source.commit);
	await assert.rejects(() => verifySource(directory, {
		source: { ...manifest.source, commit: '0'.repeat(40) }
	}), /commit does not match/);
	await writeFile(path.join(directory, 'main.cpp'), 'int main() { return 1; }\n');
	await assert.rejects(() => verifySource(directory, manifest), /source must be clean/);
});

test('source identity rejects injected untracked and ignored compiler sources', async (t) => {
	const { directory, manifest } = await sourceFixture(t);
	for (const name of ['injected.cpp', 'ignored.cpp']) {
		await writeFile(path.join(directory, name), 'int injected;\n');
		await assert.rejects(() => verifySource(directory, manifest), /source must be clean/);
		await rm(path.join(directory, name));
	}
	await verifySource(directory, manifest);
});

test('source identity detects tracked changes hidden from git status', async (t) => {
	const { directory, manifest } = await sourceFixture(t);
	git(directory, ['update-index', '--assume-unchanged', 'helper.cpp']);
	await writeFile(path.join(directory, 'helper.cpp'), 'int replacement;\n');
	assert.equal(git(directory, ['status', '--porcelain']), '');
	await assert.rejects(() => verifySource(directory, manifest), /source blob mismatch: helper.cpp/);
});

test('artifact hashing rejects symlinks and reports the actual bytes', async (t) => {
	const directory = await temporary(t);
	const file = path.join(directory, 'file');
	await writeFile(file, 'actual bytes');
	assert.deepEqual(await fileIdentity(file), {
		bytes: 12, sha256: createHash('sha256').update('actual bytes').digest('hex')
	});
	const link = path.join(directory, 'link');
	await symlink(file, link);
	await assert.rejects(() => fileIdentity(link), /not a regular file/);
});

test('native compiler hash is checked before executing a replacement binary', async (t) => {
	const directory = await temporary(t);
	await writeFile(path.join(directory, 'odin'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
	await assert.rejects(() => verifyNative(directory), /binary hash mismatch|Linux x64/);
});

test('a valid but empty Wasm module cannot pass the target fixture contract', async (t) => {
	const directory = await temporary(t);
	const file = path.join(directory, 'empty.wasm');
	await writeFile(file, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
	await assert.rejects(() => inspectWasm(file), /required WASI import missing/);
});

test('real upstream compiler emits and executes WASI; tampered evidence fails verification', {
	skip: !process.env.ODIN_TEST_WORK || !process.env.ODIN_TEST_WASM_LD
}, async (t) => {
	const temporaryRoot = await temporary(t);
	const manifest = await loadManifest();
	const work = path.resolve(process.env.ODIN_TEST_WORK);
	const output = path.join(temporaryRoot, 'baseline');
	const receipt = await nativeBaseline({
		source: path.join(work, 'source'), nativeRoot: path.join(work, 'native', manifest.nativeBootstrap.root),
		wasmLd: process.env.ODIN_TEST_WASM_LD, output
	});
	assert.equal(receipt.status, 'passed');
	assert.equal(receipt.cases.length, 4);
	assert.equal(receipt.cases.find((entry) => entry.name === 'invalid-input').exitCode, 2);
	await verifyBaseline(output);
	const file = path.join(output, 'stdin-sum.wasm');
	const original = await readFile(file);
	await writeFile(file, Buffer.concat([original, Buffer.from([0])]));
	await assert.rejects(() => verifyBaseline(output), /artifact hash mismatch/);
	await writeFile(file, original);
	const receiptPath = path.join(output, 'native-baseline-receipt.json');
	receipt.browserCompilerReady = true;
	await writeFile(receiptPath, JSON.stringify(receipt));
	await assert.rejects(() => verifyBaseline(output), /cannot establish browser readiness/);
	receipt.browserCompilerReady = false;
	receipt.outputs[0].path = '../outside.o';
	await writeFile(receiptPath, JSON.stringify(receipt));
	await assert.rejects(() => verifyBaseline(output), /deep-equal/);
});
