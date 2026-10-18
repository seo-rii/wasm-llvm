import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertWasm, readClangZip } from '../producer/clang-browser/scripts/archive-contract.mjs';
import { loadVerifiedClangArtifacts } from '../producer/clang-browser/scripts/verify-artifacts.mjs';
import { clangdJs, clangdWasm, sha256, wasm, writeBuildReceipt, writeClangFixture, zipFiles } from './fixtures/clang/artifacts.mjs';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));

const u32 = (value) => {
	const result = [];
	do { const part = value & 127; value >>>= 7; result.push(part | (value ? 128 : 0)); } while (value);
	return result;
};
const name = (value) => { const bytes = [...Buffer.from(value)]; return [...u32(bytes.length), ...bytes]; };
const section = (id, bytes) => [id, ...u32(bytes.length), ...bytes];

// Valid tiny core modules isolate ABI errors from binary validation errors.
function command({ imports = [], memory = true, shared = false, importedMemory = false,
	exportedMemory = true, exportedStart = true, startType = 0, startup = false } = {}) {
	const importedFunctions = imports.length;
	const descriptors = imports.map(([module, field, type = 0]) => [...name(module), ...name(field), 0, type]);
	if (importedMemory) descriptors.push([...name('wasi_snapshot_preview1'), ...name('memory'), 2, 0, 1]);
	const exports = [];
	if (exportedMemory && (memory || importedMemory)) exports.push([...name('memory'), 2, 0]);
	if (exportedStart) exports.push([...name('_start'), 0, importedFunctions]);
	const body = startType === 4 ? [0, 0x41, 0, 0x0b] : [0, 0x0b];
	return Buffer.from([0, 97, 115, 109, 1, 0, 0, 0,
		...section(1, [5, 0x60, 0, 0, 0x60, 7, ...Array(7).fill(0x7f), 1, 0x7f,
			0x60, 2, 0x7f, 0x7f, 1, 0x7f, 0x60, 1, 0x7f, 0, 0x60, 0, 1, 0x7f]),
		...(descriptors.length ? section(2, [descriptors.length, ...descriptors.flat()]) : []),
		...section(3, [1, startType]),
		...(memory ? section(5, shared ? [1, 3, 1, 2] : [1, 0, 1]) : []),
		...section(7, [exports.length, ...exports.flat()]),
		...(startup ? section(8, [importedFunctions]) : []),
		...section(10, [1, body.length, ...body])]);
}

for (const role of ['clang', 'lld']) {
	test(`${role} accepts a Preview 1 command with defined unshared memory`, async () => {
		await assertWasm(role, command({ imports: [['wasi_snapshot_preview1', 'proc_exit', 3]] }));
	});
	test(`${role} rejects experimental host and unrelated imports`, async () => {
		for (const imports of [
			[['wasm_idle_tool_host', 'exec_v1', 1]],
			[['wasm_idle_process_v1', 'initial_cwd', 2]],
			[['env', 'abort']], [['wasi', 'thread-spawn']], [['wasi_snapshot_preview1', 'unsupported_extension']]
		]) {
			const bytes = command({ imports });
			assert(WebAssembly.validate(bytes));
			await assert.rejects(assertWasm(role, bytes), /default WASI command ABI: unsupported import/);
		}
	});
	test(`${role} rejects incompatible startup, exports and memory models`, async () => {
		for (const [options, reason] of [
			[{ exportedMemory: false }, /missing memory export/],
			[{ exportedStart: false }, /missing function export/],
			[{ memory: false }, /missing memory export/],
			[{ memory: false, importedMemory: true }, /unsupported import/],
			[{ shared: true }, /unshared wasm32 memory/],
			[{ startType: 3 }, /no parameters or results/],
			[{ startType: 4 }, /no parameters or results/],
			[{ startup: true }, /startup must be invoked/]
		]) {
			const bytes = command(options);
			assert(WebAssembly.validate(bytes), JSON.stringify(options));
			await assert.rejects(assertWasm(role, bytes), reason);
		}
	});
}

test('committed Clang and LLD satisfy the default command ABI', async () => {
	for (const role of ['clang', 'lld']) {
		const archive = await fs.readFile(new URL(`../artifacts/clang-browser/${role}.zip`, import.meta.url));
		await assertWasm(role, await readClangZip(archive, role));
	}
});

test('matching integrity receipts cannot promote a tool-host module through default packaging or release', async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clang-profile-release-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const artifacts = path.join(root, 'artifacts');
	const output = path.join(root, 'release');
	const fixture = await writeClangFixture(artifacts);
	const scripts = path.join(repo, 'producer/clang-browser/scripts');
	const env = { ...process.env, WASM_LLVM_CLANG_ARTIFACT_DIR: artifacts,
		WASM_LLVM_CLANG_RELEASE_DIR: output, WASM_LLVM_LLDB_ARTIFACT_DIR: '', WASM_LLVM_WAMR_ARTIFACT_DIR: '' };
	await exec(process.execPath, [path.join(scripts, 'prepare-release.mjs')], { cwd: repo, env });
	async function snapshot(directory) {
		const files = new Map();
		for (const name of await fs.readdir(directory, { recursive: true })) {
			const file = path.join(directory, name);
			if ((await fs.stat(file)).isFile()) files.set(name, sha256(await fs.readFile(file)));
		}
		return files;
	}
	const original = await snapshot(output);
	for (const role of ['clang', 'lld']) {
		const experimental = command({ imports: [['wasm_idle_tool_host', 'exec_v1', 1], ['wasm_idle_process_v1', 'initial_cwd', 2]] });
		const zip = await zipFiles([[role, experimental]]);
		await fs.writeFile(path.join(artifacts, `${role}.zip`), zip);
		fixture.metadata.assets[`${role}.zip`] = sha256(zip);
		await writeBuildReceipt(artifacts, fixture.metadata, { clang: wasm, lld: wasm,
			[role]: experimental, sysroot: Buffer.alloc(1024), clangdJs, clangdWasm });
		await fixture.writeMetadata();
		await assert.rejects(loadVerifiedClangArtifacts(artifacts, { requireBuildReceipt: true }), /unsupported import/);
		await assert.rejects(exec(process.execPath, [path.join(scripts, 'prepare-release.mjs')], { cwd: repo, env }), /unsupported import/);
		await assert.rejects(exec(process.execPath, [path.join(scripts, 'package-toolchain.mjs'),
			'--clang-wasm', path.join(artifacts, 'clang.zip'), '--lld-wasm', path.join(artifacts, 'lld.zip'),
			'--memfs-zip', path.join(artifacts, 'memfs.zip'), '--sysroot', path.join(artifacts, 'sysroot.tar.zip'),
			'--clangd-js', path.join(artifacts, 'clangd/clangd.js'), '--clangd-wasm', path.join(artifacts, 'clangd/clangd.wasm.gz'),
			'--build-receipt', path.join(artifacts, 'clang-build-receipt.json'), '--memfs-receipt', path.join(artifacts, 'memfs-build-receipt.json'),
			'--target-dir', output], { cwd: repo }), /unsupported import/);
		assert.deepEqual(await snapshot(output), original);
		await fs.writeFile(path.join(artifacts, `${role}.zip`), fixture.files.get(`${role}.zip`));
		fixture.metadata.assets[`${role}.zip`] = sha256(fixture.files.get(`${role}.zip`));
	}
});
