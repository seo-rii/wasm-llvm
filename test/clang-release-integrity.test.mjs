import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadVerifiedClangArtifacts, verifyClangArtifacts, verifyClangProducerManifest } from '../producer/clang-browser/scripts/verify-artifacts.mjs';
import { createClangdHeaderAsset } from '../producer/clang-browser/scripts/prepare-clangd-headers.mjs';
import { replaceArtifactDirectory } from '../producer/clang-browser/scripts/artifact-directory.mjs';
import { clangdJs, clangdWasm, sha256, wasm, writeClangFixture, writeBuildReceipt, zipFiles } from './fixtures/clang/artifacts.mjs';

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = path.join(repo, 'producer/clang-browser/scripts');
async function fixture(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clang-release-integrity-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const artifacts = path.join(root, 'artifacts');
	const output = path.join(root, 'release');
	const data = await writeClangFixture(artifacts);
	const release = (env = {}) => exec(process.execPath, [path.join(scripts, 'prepare-release.mjs')], {
		cwd: repo, env: { ...process.env, WASM_LLVM_CLANG_ARTIFACT_DIR: artifacts,
			WASM_LLVM_CLANG_RELEASE_DIR: output, WASM_LLVM_LLDB_ARTIFACT_DIR: '', WASM_LLVM_WAMR_ARTIFACT_DIR: '', ...env }
	});
	return { root, artifacts, output, release, ...data };
}
async function snapshot(root) {
	const files = {};
	async function visit(dir) {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) await visit(file);
			else files[path.relative(root, file)] = sha256(await fs.readFile(file));
		}
	}
	await visit(root);
	return files;
}

test('release rejects changed input hashes and incomplete debugger configuration without changing any prior output byte', async (t) => {
	const f = await fixture(t);
	await f.release();
	const before = await snapshot(f.output);
	await fs.writeFile(path.join(f.artifacts, 'clang.zip'), 'tampered');
	await assert.rejects(f.release(), /Hash mismatch for clang.zip/);
	assert.deepEqual(await snapshot(f.output), before);
	await fs.writeFile(path.join(f.artifacts, 'clang.zip'), f.files.get('clang.zip'));
	f.metadata.version = 'fixture-b';
	const changedClang = await zipFiles([['clang', Buffer.concat([wasm, Buffer.from([0, 1, 0])])]]);
	await fs.writeFile(path.join(f.artifacts, 'clang.zip'), changedClang);
	f.metadata.assets['clang.zip'] = sha256(changedClang);
	await writeBuildReceipt(f.artifacts, f.metadata, { clang: Buffer.concat([wasm, Buffer.from([0, 1, 0])]), lld: wasm, sysroot: Buffer.alloc(1024), clangdJs, clangdWasm });
	await f.writeMetadata();
	await assert.rejects(f.release({ WASM_LLVM_LLDB_ARTIFACT_DIR: f.root }), /Both WASM_LLVM_LLDB_ARTIFACT_DIR/);
	assert.deepEqual(await snapshot(f.output), before);
	await f.release();
	assert.equal(JSON.parse(await fs.readFile(path.join(f.output, 'runtime-build.json'))).toolchain.version, 'fixture-b');
});

test('verifier rejects invalid ZIP structures, CRCs, Wasm and TAR even with matching outer hashes', async (t) => {
	const f = await fixture(t);
	const valid = f.files.get('clang.zip');
	const crc = Buffer.from(valid);
	const central = crc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
	crc[central + 16] ^= 1;
	const method = Buffer.from(valid);
	method.writeUInt16LE(99, central + 10);
	const duplicate = Buffer.from(await zipFiles([['clang', wasm], ['clank', wasm]]));
	for (let offset = duplicate.indexOf('clank'); offset !== -1; offset = duplicate.indexOf('clank', offset + 5))
		duplicate.write('clang', offset);
	const oversized = Buffer.from(valid);
	oversized.writeUInt32LE(512 * 1024 * 1024 + 1, central + 24);
	const cases = [
		['clang.zip', await zipFiles([])],
		['clang.zip', await zipFiles([['other', wasm]])],
		['clang.zip', await zipFiles([['clang', wasm], ['extra', wasm]])],
		['clang.zip', await zipFiles([['clang', Buffer.from('not wasm')]])],
		['clang.zip', crc],
		['clang.zip', duplicate],
		['clang.zip', oversized],
		['clang.zip', await zipFiles([['clang/', Buffer.alloc(0)]])],
		['clang.zip', method],
		['sysroot.tar.zip', await zipFiles([['sysroot.tar', Buffer.alloc(1024, 1)]])]
	];
	for (const [asset, bytes] of cases) {
		await fs.writeFile(path.join(f.artifacts, asset), bytes);
		f.metadata.assets[asset] = sha256(bytes);
		await f.writeMetadata();
		await assert.rejects(verifyClangArtifacts(f.artifacts));
		await fs.writeFile(path.join(f.artifacts, asset), f.files.get(asset));
		f.metadata.assets[asset] = sha256(f.files.get(asset));
	}
	await f.writeMetadata();
	assert.deepEqual(await verifyClangArtifacts(f.artifacts), { assets: 6 });
});

test('manifest compatibility accepts only the recorded optional-header-only historical change', async (t) => {
	const f = await fixture(t);
	const currentBytes = await fs.readFile(path.join(repo, 'producer/clang-browser/manifest.json'));
	const historical = await fs.readFile(path.join(repo, 'producer/clang-browser/compatibility/manifest-before-optional-headers.json'));
	// Exercise that historical transition against its actual inputs, independently
	// of source patches subsequently added to the current compiler producer.
	const bytes = Buffer.from(JSON.stringify({
		...JSON.parse(historical), optionalOutputs: ['clangd/clangd.headers.json.gz']
	}));
	f.metadata.producer.manifestSha256 = sha256(historical);
	assert.equal(await verifyClangProducerManifest(f.metadata, bytes), 'historical-compatible');
	await assert.rejects(verifyClangProducerManifest(f.metadata, currentBytes), /manifest mismatch/);
	for (const mutate of [
		(value) => { value.sources.llvm.commit = '0'.repeat(40); },
		(value) => { value.outputs.pop(); },
		(value) => { value.optionalOutputs.push('unknown'); },
		(value) => { value.sources.wasmFunctionEndPatch = JSON.parse(currentBytes).sources.wasmFunctionEndPatch; }
	]) {
		const manifest = JSON.parse(bytes);
		mutate(manifest);
		await assert.rejects(verifyClangProducerManifest(f.metadata, Buffer.from(JSON.stringify(manifest))), /manifest mismatch/);
	}
	f.metadata.clangd.headers = {};
	await assert.rejects(verifyClangProducerManifest(f.metadata, bytes), /manifest mismatch/);
	delete f.metadata.clangd.headers;
	f.metadata.producer.manifestSha256 = 'cc92f3c057a177288e7e11c06092aed47a7484e9ca6551f5c5413bb11b820d78';
	delete f.metadata.memfs;
	await assert.rejects(verifyClangProducerManifest(f.metadata, bytes), /manifest mismatch/);
	f.metadata.producer.manifestSha256 = '0'.repeat(64);
	await f.writeMetadata();
	await assert.rejects(f.release(), /manifest mismatch/);
});

test('verified Clang snapshots retain original bytes after an input is changed', async (t) => {
	const f = await fixture(t);
	const verified = await loadVerifiedClangArtifacts(f.artifacts);
	await fs.writeFile(path.join(f.artifacts, 'clang.zip'), 'changed after validation');
	assert.deepEqual(verified.files.get('clang.zip'), f.files.get('clang.zip'));
});

test('packaging validates named ZIP inputs, preserves failure output, and removes optional headers when disabled', async (t) => {
	const f = await fixture(t);
	const raw = path.join(f.root, 'raw');
	await fs.mkdir(raw);
	for (const [name, bytes] of [['clang.wasm', wasm], ['lld.wasm', wasm], ['memfs.wasm', wasm],
		['clangd.js', clangdJs], ['clangd.wasm', clangdWasm], ['sysroot.tar', Buffer.alloc(1024)]])
		await fs.writeFile(path.join(raw, name), bytes);
	for (const name of ['include/wasm32-wasi/stdio.h', 'include/wasm32-wasi/noeh/c++/v1/__config_site',
		'include/c++/v1/vector', 'resource/stddef.h']) {
		await fs.mkdir(path.dirname(path.join(raw, name)), { recursive: true });
		await fs.writeFile(path.join(raw, name), '// fixture');
	}
	const output = path.join(f.root, 'packaged');
	const receiptPath = path.join(raw, 'clang-build-receipt.json');
	await writeBuildReceipt(raw, {}, { clang: wasm, lld: wasm, memfs: wasm, sysroot: Buffer.alloc(1024), clangdJs, clangdWasm });
	const packageArgs = ['--build-receipt', receiptPath, '--memfs-receipt', path.join(raw, 'memfs-build-receipt.json'), '--clang-wasm', path.join(raw, 'clang.wasm'), '--lld-wasm', path.join(raw, 'lld.wasm'),
		'--memfs-wasm', path.join(raw, 'memfs.wasm'), '--sysroot', path.join(raw, 'sysroot.tar'),
		'--clangd-js', path.join(raw, 'clangd.js'), '--clangd-wasm', path.join(raw, 'clangd.wasm'),
		'--target-dir', output, '--resource-dir', '/lib/clang/22'];
	const pack = async (extra = []) => {
		const receipt = await writeBuildReceipt(raw, {}, { clang: wasm, lld: wasm, memfs: wasm, sysroot: Buffer.alloc(1024), clangdJs, clangdWasm });
		if (extra.includes('--clangd-include')) {
			const headers = await createClangdHeaderAsset({ includeDir: path.join(raw, 'include'), resourceIncludeDir: path.join(raw, 'resource'),
				resourceDir: '/lib/clang/22', targetTriple: 'wasm32-wasi', version: `${extra[extra.indexOf('--version') + 1]}:${receipt.buildOptions.llvmCommit}` });
			receipt.inputs.clangdHeaders = { bytes: headers.length, sha256: sha256(headers) };
			receipt.buildOptions.clangdSeparateHeaders = 'ON';
		}
		await fs.writeFile(receiptPath, JSON.stringify(receipt));
		return exec(process.execPath, [path.join(scripts, 'package-toolchain.mjs'), ...packageArgs, ...extra], { cwd: repo });
	};
	await pack(['--clangd-include', path.join(raw, 'include'), '--clangd-resource-include', path.join(raw, 'resource'), '--version', 'a']);
	await f.release({ WASM_LLVM_CLANG_ARTIFACT_DIR: output });
	assert.ok(await fs.readFile(path.join(f.output, 'clangd/clangd.headers.json.gz')));
	const before = await snapshot(output);
	const invalidZip = path.join(raw, 'invalid.zip');
	await fs.writeFile(invalidZip, await zipFiles([['clang', wasm], ['extra', wasm]]));
	await assert.rejects(pack(['--clang-wasm', invalidZip]), /expected exactly one named regular file/);
	assert.deepEqual(await snapshot(output), before);
	await pack(['--version', 'b']);
	await assert.rejects(fs.readFile(path.join(output, 'clangd/clangd.headers.json.gz')), { code: 'ENOENT' });
	const metadata = JSON.parse(await fs.readFile(path.join(output, 'toolchain.json')));
	assert.equal(metadata.version, 'b');
	assert.equal(Object.keys(metadata.assets).length, 6);
	await f.release({ WASM_LLVM_CLANG_ARTIFACT_DIR: output });
	await assert.rejects(fs.readFile(path.join(f.output, 'clangd/clangd.headers.json.gz')), { code: 'ENOENT' });
});

test('staging failure and failed publication roll back byte-for-byte, and concurrent writers cannot remove staging', async (t) => {
	const f = await fixture(t);
	await f.release();
	const before = await snapshot(f.output);
	await assert.rejects(replaceArtifactDirectory(f.output, async (staged) => {
		await fs.writeFile(path.join(staged, 'partial'), 'new');
		throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
	}), /disk full/);
	assert.deepEqual(await snapshot(f.output), before);
	const rename = fs.rename;
	fs.rename = async (source, destination) => {
		if (source.endsWith('/next')) throw Object.assign(new Error('simulated publication failure'), { code: 'EIO' });
		return rename(source, destination);
	};
	try {
		await assert.rejects(replaceArtifactDirectory(f.output, async (staged) => {
			await fs.writeFile(path.join(staged, 'next'), 'next');
		}), /publication failure/);
	} finally {
		fs.rename = rename;
	}
	assert.deepEqual(await snapshot(f.output), before);
	let entered;
	let resume;
	const enteredPromise = new Promise((resolve) => { entered = resolve; });
	const resumed = new Promise((resolve) => { resume = resolve; });
	const first = replaceArtifactDirectory(f.output, async (staged) => {
		await fs.writeFile(path.join(staged, 'only'), 'next');
		entered();
		await resumed;
	});
	await enteredPromise;
	await assert.rejects(replaceArtifactDirectory(f.output, async () => {}), /output is locked/);
	resume();
	await first;
	assert.deepEqual(Object.keys(await snapshot(f.output)), ['only']);
	assert.equal((await fs.readdir(f.root)).some((name) => name.includes('.staging-') || name.endsWith('.lock')), false);
});

test('packager requires build evidence and explicit unverified packaging cannot be promoted', async (t) => {
	const f = await fixture(t);
	const output = path.join(f.root, 'unverified-package');
	const args = ['--memfs-receipt', path.join(f.artifacts, 'memfs-build-receipt.json'), '--clang-wasm', path.join(f.artifacts, 'clang.zip'), '--lld-wasm', path.join(f.artifacts, 'lld.zip'),
		'--memfs-zip', path.join(f.artifacts, 'memfs.zip'), '--sysroot', path.join(f.artifacts, 'sysroot.tar.zip'),
		'--clangd-js', path.join(f.artifacts, 'clangd/clangd.js'), '--clangd-wasm', path.join(f.artifacts, 'clangd/clangd.wasm.gz'),
		'--llvm-version', f.metadata.llvmVersion, '--target-dir', output];
	const pack = (extra = []) => exec(process.execPath, [path.join(scripts, 'package-toolchain.mjs'), ...args, ...extra], { cwd: repo });
	await assert.rejects(pack(), /Missing --build-receipt/);
	await assert.rejects(fs.stat(output), { code: 'ENOENT' });
	await pack(['--allow-unverified-build', 'true']);
	const metadata = JSON.parse(await fs.readFile(path.join(output, 'toolchain.json')));
	assert.equal(metadata.buildProvenance.status, 'unverified');
	assert.equal(metadata.llvmCommit, undefined, 'version strings must never imply a verified source commit');
	await assert.rejects(f.release({ WASM_LLVM_CLANG_ARTIFACT_DIR: output }), /requires a verified source-to-output build receipt/);
	await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
	await pack(['--build-receipt', path.join(f.artifacts, 'clang-build-receipt.json')]);
	await f.release({ WASM_LLVM_CLANG_ARTIFACT_DIR: output });
	const before = await snapshot(output);
	const changed = await zipFiles([['clang', Buffer.concat([wasm, Buffer.from([0, 1, 0])])]]);
	await fs.writeFile(path.join(f.artifacts, 'clang.zip'), changed);
	await assert.rejects(pack(['--build-receipt', path.join(f.artifacts, 'clang-build-receipt.json')]), /clang input identity mismatch/);
	assert.deepEqual(await snapshot(output), before);
});

test('legacy artifacts matching the current manifest still require a fresh build receipt', async (t) => {
	const f = await fixture(t);
	delete f.metadata.buildProvenance;
	await f.writeMetadata();
	await assert.rejects(loadVerifiedClangArtifacts(f.artifacts, { requireBuildReceipt: true }),
		/requires a verified source-to-output build receipt/);
});

test('artifacts with an obsolete compiler manifest require a rebuild', async (t) => {
	const f = await fixture(t);
	await f.release();
	const before = await snapshot(f.output);
	f.metadata.producer.manifestSha256 = '0'.repeat(64);
	await f.writeMetadata();
	await assert.rejects(loadVerifiedClangArtifacts(f.artifacts, { requireBuildReceipt: true }),
		/Clang producer manifest mismatch/);
	await assert.rejects(f.release(), /Clang producer manifest mismatch/);
	assert.deepEqual(await snapshot(f.output), before);
});

test('committed artifacts carry current source-to-output build evidence', async () => {
	const verified = await loadVerifiedClangArtifacts(path.join(repo, 'artifacts/clang-browser'), { requireBuildReceipt: true });
	assert.equal(verified.manifestCompatibility, 'current');
	assert.equal(verified.metadata.buildProvenance.status, 'verified');
	assert.equal(sha256(verified.sidecars.get('clang-build-receipt.json')),
		'19c9acd044aaa6881cd2c2583d068a06d02299e38a7e3a9827fc2a09afe169ee');
});

test('release requires independent MemFS proof and binds it and the module to the complete Clang build', async (t) => {
	const f = await fixture(t);
	await f.release();
	const before = await snapshot(f.output);
	const originalMemfs = structuredClone(f.metadata.memfs);
	delete f.metadata.memfs;
	await f.writeMetadata();
	await assert.rejects(f.release(), /requires MemFS build provenance/);
	assert.deepEqual(await snapshot(f.output), before);
	f.metadata.memfs = originalMemfs;
	const replacement = Buffer.concat([wasm, Buffer.from([0, 1, 0])]);
	const zip = await zipFiles([['memfs', replacement]]);
	await fs.writeFile(path.join(f.artifacts, 'memfs.zip'), zip);
	f.metadata.assets['memfs.zip'] = sha256(zip);
	f.metadata.memfs.buildReceipt.outputs['memfs.wasm'] = { bytes: replacement.length, sha256: sha256(replacement) };
	const receipt = Buffer.from(`${JSON.stringify(f.metadata.memfs.buildReceipt)}\n`);
	await fs.writeFile(path.join(f.artifacts, 'memfs-build-receipt.json'), receipt);
	f.metadata.memfs.files['memfs-build-receipt.json'] = { bytes: receipt.length, sha256: sha256(receipt) };
	await f.writeMetadata();
	await assert.rejects(f.release(), /memfs input identity mismatch/);
	assert.deepEqual(await snapshot(f.output), before);
});
