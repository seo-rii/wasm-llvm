import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertX86Elf, digest, identity, packageCross, readNativeTree, validateGnuSysroot } from '../producer/clang-browser/cross/package.mjs';
import { assertStaticExecutable, qualifyCross } from '../producer/clang-browser/cross/qualify.mjs';
import { directoryIdentity } from '../producer/clang-browser/scripts/build-provenance.mjs';
import { readTarEntries } from '../scripts/lib/tar.mjs';

const producer = fileURLToPath(new URL('../producer/clang-browser/', import.meta.url));
async function temporary(t) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-cross-test-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	return directory;
}
function elf(type = 1, machine = 62) {
	const bytes = Buffer.alloc(type === 2 ? 120 : 64);
	Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(bytes);
	bytes.writeUInt16LE(type, 16); bytes.writeUInt16LE(machine, 18);
	if (type === 2) {
		bytes.writeBigUInt64LE(0x401000n, 24); bytes.writeBigUInt64LE(64n, 32);
		bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(1, 56); bytes.writeUInt32LE(1, 64);
	}
	return bytes;
}
function archive(bytes = elf()) {
	const header = Buffer.alloc(60, 32);
	header.write('member.o/'); header.write(String(bytes.length), 48); header.write('`\n', 58);
	return Buffer.concat([Buffer.from('!<arch>\n'), header, bytes, Buffer.alloc(bytes.length % 2)]);
}
function gnuFixture() {
	const gcc = 'usr/lib/gcc/x86_64-linux-gnu/14';
	const cpp = 'usr/include/c++/14';
	const files = [
		'usr/include/stdio.h', 'usr/include/stdlib.h', 'usr/include/features.h', `${cpp}/vector`,
		`${cpp}/ext/pb_ds/assoc_container.hpp`, `${cpp}/ext/pb_ds/detail/rb_tree_map_/rb_tree_.hpp`,
		`${cpp}/ext/pb_ds/detail/tree_policy/order_statistics_imp.hpp`,
		'usr/include/x86_64-linux-gnu/c++/14/bits/c++config.h', 'usr/include/x86_64-linux-gnu/c++/14/bits/stdc++.h',
		'usr/share/doc/libstdc++/copyright'
	].map((name) => ({ path: name, bytes: Buffer.from('synthetic packaging fixture; not a production GNU header\n') }));
	for (const name of [`${gcc}/crtbeginT.o`, `${gcc}/crtend.o`, 'usr/lib/x86_64-linux-gnu/crt1.o',
		'usr/lib/x86_64-linux-gnu/crti.o', 'usr/lib/x86_64-linux-gnu/crtn.o']) files.push({ path: name, bytes: elf() });
	for (const name of [`${gcc}/libstdc++.a`, `${gcc}/libgcc.a`, `${gcc}/libgcc_eh.a`,
		'usr/lib/x86_64-linux-gnu/libc.a', 'usr/lib/x86_64-linux-gnu/libm.a']) files.push({ path: name, bytes: archive() });
	const provenance = { schemaVersion: 1, target: 'x86_64-linux-gnu', gccVersion: '14', glibcVersion: '2.39', distribution: 'fixture',
		sources: [{ url: 'https://example.invalid/gnu-fixture.tar', sha256: digest('fixture source archive') }],
		licenseFiles: ['usr/share/doc/libstdc++/copyright'] };
	return { files, provenance };
}
async function writeFiles(root, files) {
	for (const file of files) { await fs.mkdir(path.dirname(path.join(root, file.path)), { recursive: true }); await fs.writeFile(path.join(root, file.path), file.bytes); }
}
// Actual Wasm ABI fixture, intentionally no compiler implementation. Packaging
// must not turn its structural acceptance into execution qualification.
function abiModule() {
	const name = (value) => [value.length, ...Buffer.from(value)];
	const section = (id, bytes) => [id, bytes.length, ...bytes];
	return Buffer.from([0, 97, 115, 109, 1, 0, 0, 0,
		...section(1, [3, 0x60, 7, ...Array(7).fill(0x7f), 1, 0x7f, 0x60, 2, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 0]),
		...section(2, [2, ...name('wasm_idle_tool_host'), ...name('exec_v1'), 0, 0,
			...name('wasm_idle_process_v1'), ...name('initial_cwd'), 0, 1]),
		...section(3, [1, 2]), ...section(5, [1, 0, 1]),
		...section(7, [2, ...name('memory'), 2, 0, ...name('_start'), 0, 2]),
		...section(10, [1, 2, 0, 0x0b])]);
}

test('opt-in native profile preserves the WASI host and fails before build for unsafe overrides', () => {
	const script = path.join(producer, 'scripts/build-toolchain.mjs');
	const env = { ...process.env, CLANG_TARGET_PROFILE: '', TARGET_TRIPLE: '', HOST_TRIPLE: '', CLANG_TOOL_HOST: '' };
	const help = spawnSync(process.execPath, [script, '--help'], { env, encoding: 'utf8' });
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /TARGET_TRIPLE=wasm32-wasi/);
	assert.match(help.stdout, /CLANG_TOOL_HOST=OFF/);
	const native = spawnSync(process.execPath, [script, '--help'], { env: { ...env, CLANG_TARGET_PROFILE: 'x86_64-linux-gnu' }, encoding: 'utf8' });
	assert.equal(native.status, 0, native.stderr);
	assert.match(native.stdout, /TARGET_TRIPLE=x86_64-unknown-linux-gnu/);
	assert.match(native.stdout, /HOST_TRIPLE=wasm32-wasip1/);
	assert.match(native.stdout, /CLANG_TOOL_HOST=ON/);
	for (const override of [{ CLANG_TOOL_HOST: 'OFF' }, { HOST_TRIPLE: 'x86_64-linux-gnu' }, { TARGET_TRIPLE: 'wasm32-wasi' }]) {
		const result = spawnSync(process.execPath, [script, '--compiler-only'], { env: { ...env, CLANG_TARGET_PROFILE: 'x86_64-linux-gnu', ...override }, encoding: 'utf8' });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /profile requires/);
		assert(!result.stdout.includes('+ '), 'No build command may run before configuration rejection');
	}
});

test('native tree materializes contained links and rejects escapes/cycles', async (t) => {
	const root = await temporary(t);
	const input = path.join(root, 'input'); await fs.mkdir(input);
	await fs.writeFile(path.join(input, 'header.h'), 'header');
	await fs.symlink('header.h', path.join(input, 'alias.h'));
	assert.deepEqual((await readNativeTree(input)).map((file) => file.path), ['alias.h', 'header.h']);
	await fs.writeFile(path.join(root, 'outside'), 'outside');
	await fs.symlink('../outside', path.join(input, 'escape'));
	await assert.rejects(readNativeTree(input), /escapes/);
	await fs.unlink(path.join(input, 'escape'));
	await fs.symlink('.', path.join(input, 'cycle'));
	await assert.rejects(readNativeTree(input), /cycle/);
});

test('GNU sysroot validation rejects WASI runtime objects, compatibility shims and incomplete PBDS', () => {
	const fixture = gnuFixture();
	assert.equal(validateGnuSysroot(fixture.files, fixture.provenance).gccInstallation, '/sysroot/usr/lib/gcc/x86_64-linux-gnu/14');
	const withFile = (name, bytes) => fixture.files.map((file) => file.path === name ? { ...file, bytes } : file);
	assert.throws(() => validateGnuSysroot(withFile('usr/lib/x86_64-linux-gnu/crt1.o', Buffer.from('\0asm')), fixture.provenance), /expected ELF/);
	assert.throws(() => validateGnuSysroot(withFile('usr/lib/gcc/x86_64-linux-gnu/14/libstdc++.a', archive(elf(1, 183))), fixture.provenance), /x86-64/);
	assert.throws(() => validateGnuSysroot(withFile('usr/include/c++/14/ext/pb_ds/assoc_container.hpp', Buffer.from('WASM_CLANG_EXT_PB_DS')), fixture.provenance), /compatibility shim/);
	assert.throws(() => validateGnuSysroot(fixture.files.filter((file) => !file.path.endsWith('rb_tree_.hpp')), fixture.provenance), /missing/);
});

test('GNU libm GROUP scripts resolve only present x86 static archives', () => {
	const fixture = gnuFixture();
	const library = fixture.files.find((file) => file.path.endsWith('/libm.a'));
	library.bytes = Buffer.from('/* GNU ld script */ OUTPUT_FORMAT(elf64-x86-64) GROUP (/usr/lib/x86_64-linux-gnu/libm-real.a)');
	assert.throws(() => validateGnuSysroot(fixture.files, fixture.provenance), /missing.*libm-real/);
	fixture.files.push({ path: 'usr/lib/x86_64-linux-gnu/libm-real.a', bytes: archive() });
	validateGnuSysroot(fixture.files, fixture.provenance);
	library.bytes = Buffer.from('INPUT(../../../../outside.a)');
	assert.throws(() => validateGnuSysroot(fixture.files, fixture.provenance), /Unsafe/);
});

test('installed-package provenance binds every normalized file byte', () => {
	const fixture = gnuFixture();
	delete fixture.provenance.sources;
	fixture.provenance.source = { kind: 'debian-packages', packages: [{ name: 'libc6-dev', version: '2.39-1', sourcePackage: 'glibc', sourceVersion: '2.39-1' }] };
	fixture.provenance.files = fixture.files.map((file) => ({ path: file.path, ...identity(file.bytes) }));
	validateGnuSysroot(fixture.files, fixture.provenance);
	fixture.files[0].bytes = Buffer.from('tampered header');
	assert.throws(() => validateGnuSysroot(fixture.files, fixture.provenance), /file inventory/);
});

test('output inspection distinguishes x86 ELF objects, static executables and dynamic/foreign outputs', () => {
	assertX86Elf(elf(), 'object', 1);
	assertStaticExecutable(elf(2));
	assert.throws(() => assertStaticExecutable(elf()), /wrong ELF type/);
	assert.throws(() => assertStaticExecutable(elf(2, 183)), /x86-64/);
	const dynamic = elf(2); dynamic.writeUInt32LE(3, 64);
	assert.throws(() => assertStaticExecutable(dynamic), /PT_INTERP/);
	const truncated = elf(2); truncated.writeBigUInt64LE(1000n, 32);
	assert.throws(() => assertStaticExecutable(truncated), /program headers/);
});

test('native package is deterministic, preserves actual target files and stays unqualified', async (t) => {
	const root = await temporary(t);
	const compiler = path.join(root, 'compiler'); const sysroot = path.join(root, 'sysroot');
	const fixture = gnuFixture(); await writeFiles(sysroot, fixture.files);
	const profileBytes = await fs.readFile(path.join(producer, 'cross/profile.json'));
	const toolHostProfile = JSON.parse(await fs.readFile(path.join(producer, 'tool-host/profile.json')));
	const resources = ['immintrin.h', 'avxintrin.h', 'avx2intrin.h', 'xmmintrin.h', 'emmintrin.h'].map((name) => ({ path: `resource-include/${name}`, bytes: Buffer.from('resource fixture') }));
	await writeFiles(compiler, [...resources, { path: 'cross-profile.json', bytes: profileBytes },
		{ path: 'clang', bytes: abiModule() }, { path: 'lld', bytes: abiModule() }, { path: 'tool-host/LICENSE.LLVM.txt', bytes: Buffer.from('fixture notice') }]);
	const receipt = { llvmVersion: '22.1.8', llvmCommit: toolHostProfile.llvmCommit, toolHostProfile,
		cross: { profile: JSON.parse(profileBytes), profileIdentity: identity(profileBytes), resourceVersion: '22',
			resourceHeaders: await directoryIdentity(path.join(compiler, 'resource-include')) },
		modules: { clang: identity(abiModule()), lld: identity(abiModule()) } };
	await fs.writeFile(path.join(compiler, 'compiler-build.json'), JSON.stringify(receipt));
	const provenance = path.join(root, 'gnu.json'); await fs.writeFile(provenance, JSON.stringify(fixture.provenance));
	const output = path.join(root, 'bundle');
	const result = await packageCross({ compiler, sysroot, provenance, output });
	const manifestBytes = await fs.readFile(path.join(output, 'cross-toolchain.v1.json'));
	assert.equal(digest(manifestBytes), result.manifestSha256);
	const manifest = JSON.parse(manifestBytes);
	assert.equal(manifest.qualification.status, 'unverified');
	assert.equal(manifest.target, 'x86_64-unknown-linux-gnu');
	assert.deepEqual(manifest.gnu, { gccVersion: '14', glibcVersion: fixture.provenance.glibcVersion,
		distribution: fixture.provenance.distribution, source: 'gnu-provenance.json', licenses: fixture.provenance.licenseFiles });
	assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, manifest.gnu.source))), fixture.provenance);
	const tar = await fs.readFile(path.join(output, manifest.assets.sysroot.path));
	const entries = readTarEntries(tar);
	assert(entries.has('lib/clang/22/include/immintrin.h'));
	assert(entries.has('usr/include/c++/14/ext/pb_ds/detail/rb_tree_map_/rb_tree_.hpp'));
	assert(![...entries.keys()].some((name) => name.includes('wasm32')));
	const second = await packageCross({ compiler, sysroot, provenance, output: path.join(root, 'bundle2') });
	assert.equal(second.manifestSha256, result.manifestSha256);
	// Packaging tests use an ABI-only stub. It must never pass real codegen qualification.
	const qualification = path.join(root, 'qualification');
	await assert.rejects(qualifyCross(output, qualification), /x86-64/);
	const evidence = JSON.parse(await fs.readFile(path.join(qualification, 'qualification.json')));
	assert.equal(evidence.passed, false);
	assert.equal(evidence.manifestSha256, result.manifestSha256);
	assert.equal(evidence.commands[0].label, 'targets');
	await assert.rejects(qualifyCross(output, path.join(output, 'nested-check')), /must not overlap/);
	await assert.rejects(packageCross({ compiler, sysroot, provenance, output }), /EEXIST/);
	await fs.appendFile(path.join(compiler, 'resource-include/immintrin.h'), 'changed');
	await assert.rejects(packageCross({ compiler, sysroot, provenance, output: path.join(root, 'rejected') }), /Resource headers changed/);
	await assert.rejects(fs.stat(path.join(root, 'rejected')), { code: 'ENOENT' });
});
