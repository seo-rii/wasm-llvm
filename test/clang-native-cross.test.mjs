import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertX86Elf, digest, identity, packageCross, readNativeTree, validateGnuSysroot } from '../producer/clang-browser/cross/package.mjs';
import { assertStaticExecutable, createCrossToolRunner, qualifyCross } from '../producer/clang-browser/cross/qualify.mjs';
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

// A parent dispatches the supplied ABI packet; the child returns its WASI argc.
// This tests transport/adaptation only, never compiler or X86 qualification.
function dispatchFixture(program, argv) {
	const leb = (value, signed = false) => {
		const result = [];
		do {
			const byte = value & 0x7f; value >>= 7;
			const more = signed ? value !== (byte & 0x40 ? -1 : 0) : value !== 0;
			result.push(byte | (more ? 0x80 : 0));
			if (!more) return result;
		} while (true);
	};
	const name = (value) => [...leb(Buffer.byteLength(value)), ...Buffer.from(value)];
	const section = (id, bytes) => [id, ...leb(bytes.length), ...bytes];
	const constant = (value) => [0x41, ...leb(value, true)];
	const data = Buffer.alloc(1024);
	let cursor = 256;
	const text = (value) => { const bytes = Buffer.from(value); const offset = cursor; bytes.copy(data, cursor); cursor += bytes.length; return [offset, bytes.length]; };
	const [programPointer, programLength] = text(program);
	argv.forEach((value, index) => { const [pointer, length] = text(value); data.writeUInt32LE(pointer, 64 + index * 8); data.writeUInt32LE(length, 68 + index * 8); });
	const code = [0, ...constant(0), ...constant(4), 0x10, 1, 0x1a,
		...constant(0), 0x28, 2, 0, ...constant(1), 0x46, 0x04, 0x40,
		...constant(programPointer), ...constant(programLength), ...constant(64), ...constant(argv.length),
		...constant(0), ...constant(0), ...constant(1), 0x10, 0, 0x10, 2,
		0x05, ...constant(0), 0x28, 2, 0, 0x10, 2, 0x0b, 0x0b];
	return new WebAssembly.Module(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0,
		...section(1, [4, 0x60, 7, ...Array(7).fill(0x7f), 1, 0x7f, 0x60, 2, 0x7f, 0x7f, 1, 0x7f, 0x60, 1, 0x7f, 0, 0x60, 0, 0]),
		...section(2, [3, ...name('wasm_idle_tool_host'), ...name('exec_v1'), 0, 0,
			...name('wasi_snapshot_preview1'), ...name('args_sizes_get'), 0, 1,
			...name('wasi_snapshot_preview1'), ...name('proc_exit'), 0, 2]),
		...section(3, [1, 3]), ...section(5, [1, 0, 1]),
		...section(7, [2, ...name('memory'), 2, 0, ...name('_start'), 0, 3]),
		...section(10, [1, ...leb(code.length), ...code]),
		...section(11, [1, 0, ...constant(0), 0x0b, ...leb(cursor), ...data.subarray(0, cursor)])]));
}

test('Node cross host adapts only resolved multicall cc1 jobs and preserves the original packet', async (t) => {
	const root = await temporary(t);
	const descriptor = openSync('/dev/null', 'r+'); t.after(() => closeSync(descriptor));
	for (const [program, childArgv, expectedArgv] of [
		['/bin/clang', ['/bin/clang', 'clang', '-cc1', 'space arg'], ['/bin/clang', '-cc1', 'space arg']],
		['/bin/clang', ['/bin/clang', 'clang', '-cc1as', ''], ['/bin/clang', '-cc1as', '']],
		['', ['', 'clang', '-cc1', 'space arg'], ['', 'clang', '-cc1', 'space arg']],
		['/bin/ld.lld', ['/bin/ld.lld', 'clang', '-cc1', 'space arg'], ['/bin/ld.lld', 'clang', '-cc1', 'space arg']]
	]) {
		const module = dispatchFixture(program, childArgv), dispatches = [];
		const invoke = createCrossToolRunner({ root, modules: { clang: module, lld: module }, compilerPath: '/bin/clang', linkerPath: '/bin/ld.lld', dispatches });
		assert.equal(invoke('clang', ['/bin/clang'], {}, [descriptor, descriptor, descriptor]), expectedArgv.length);
		assert.deepEqual(dispatches[0].argv, childArgv);
		assert.deepEqual(dispatches[0].wasiArgv, expectedArgv);
		assert.equal(dispatches[0].kind, program === '/bin/ld.lld' ? 'lld' : 'clang');
	}
	for (const [program, childArgv] of [
		['/other/clang', ['/other/clang', 'clang', '-cc1']],
		['/bin/clang', ['/bin/clang', 'clang', '--help']],
		['/bin/clang', ['/bin/clang', 'clang', '-cc1extra']]
	]) {
		const module = dispatchFixture(program, childArgv);
		const invoke = createCrossToolRunner({ root, modules: { clang: module, lld: module }, compilerPath: '/bin/clang', linkerPath: '/bin/ld.lld', dispatches: [] });
		assert.throws(() => invoke('clang', ['/bin/clang'], {}, [descriptor, descriptor, descriptor]), /Unexpected child executable/);
	}
});

test('real pinned Clang dispatches resolved cc1 jobs and links through the Node cross host', {
	skip: process.env.WASM_LLVM_CLANG_HOST_FIXTURE_DIR ? false : 'set WASM_LLVM_CLANG_HOST_FIXTURE_DIR to the pinned Wasm-only Clang 22 fixture'
}, async (t) => {
	// This checks the actual LLVM multicall entry point and host ABI, not X86 codegen.
	const fixture = process.env.WASM_LLVM_CLANG_HOST_FIXTURE_DIR;
	const bytes = { clang: await fs.readFile(path.join(fixture, 'clang.wasm')), lld: await fs.readFile(path.join(fixture, 'lld.wasm')) };
	assert.equal(digest(bytes.clang), 'e0b548b70e13ad9620c1f47a1ef3f552b74cea586866ef1d8dcc0558c87f50e3');
	assert.equal(digest(bytes.lld), '3da2fc3d37702d3d56bce834672912334e36d245efaf97fbdda7e4b5e810134a');
	const root = await temporary(t);
	for (const directory of ['bin', 'tmp', 'work']) await fs.mkdir(path.join(root, directory));
	for (const [name, file] of [['clang', 'clang'], ['lld', 'wasm-ld']]) await fs.writeFile(path.join(root, 'bin', file), bytes[name], { mode: 0o700 });
	await fs.writeFile(path.join(root, 'work/main.c'), 'int answer(void) { return 42; }\n');
	const dispatches = [], results = [];
	const invoke = createCrossToolRunner({ root, modules: { clang: new WebAssembly.Module(bytes.clang), lld: new WebAssembly.Module(bytes.lld) }, compilerPath: '/bin/clang', linkerPath: '/bin/wasm-ld', dispatches });
	async function run(label, args) {
		const stdout = path.join(root, label + '.stdout'), stderr = path.join(root, label + '.stderr');
		const descriptors = [openSync('/dev/null', 'r'), openSync(stdout, 'wx', 0o600), openSync(stderr, 'wx', 0o600)];
		let code;
		try { code = invoke('clang', ['/bin/clang', ...args], { LANG: 'C' }, descriptors); }
		finally { descriptors.forEach(closeSync); }
		const result = { label, code, stdout: await fs.readFile(stdout, 'utf8'), stderr: await fs.readFile(stderr, 'utf8') };
		results.push(result); return result;
	}
	// Demonstrate that the fixture really exercises the CI failure, rather than
	// silently accepting the duplicated subcommand like an ABI-only stub might.
	const unadapted = await run('unadapted', ['clang', '-cc1', '-version']);
	assert.notEqual(unadapted.code, 0);
	assert.match(unadapted.stderr, /unknown argument.*-cc1/);
	const compiled = await run('object', ['--target=wasm32-wasip1', '-fno-integrated-cc1', '-ffreestanding', '-nostdinc', '-O2', '-c', 'main.c', '-o', 'main.o']);
	assert.equal(compiled.code, 0, compiled.stderr);
	const object = await fs.readFile(path.join(root, 'work/main.o'));
	assert.deepEqual([...object.subarray(0, 4)], [0, 97, 115, 109]);
	const linked = await run('link', ['--target=wasm32-wasip1', '-fno-integrated-cc1', '-ffreestanding', '-nostdlib', '-O2', '-fuse-ld=lld', '--ld-path=/bin/wasm-ld', '-Wl,--no-entry', '-Wl,--export=answer', 'main.c', '-o', 'main.wasm']);
	assert.equal(linked.code, 0, linked.stderr);
	const executable = await fs.readFile(path.join(root, 'work/main.wasm'));
	assert.equal(new WebAssembly.Instance(new WebAssembly.Module(executable)).exports.answer(), 42);
	const compilerChildren = dispatches.filter((entry) => entry.kind === 'clang');
	assert.equal(compilerChildren.length, 2);
	for (const child of compilerChildren) {
		assert.equal(child.program, '/bin/clang'); assert.equal(child.code, 0);
		assert.deepEqual(child.argv.slice(0, 3), ['/bin/clang', 'clang', '-cc1']);
		assert.deepEqual(child.wasiArgv, [child.argv[0], ...child.argv.slice(2)]);
	}
	assert(dispatches.some((entry) => entry.kind === 'lld' && entry.program === '/bin/wasm-ld' && entry.code === 0));
	t.diagnostic(JSON.stringify({ scope: 'real Wasm-only Clang 22 host; not X86 qualification', compilerSha256: digest(bytes.clang), linkerSha256: digest(bytes.lld), object: identity(object), executable: identity(executable), cases: results.map(({ label, code }) => ({ label, code })), dispatches: dispatches.map(({ kind, program, argv, wasiArgv, code }) => ({ kind, program, argvPrefix: argv.slice(0, 4), wasiArgvPrefix: wasiArgv.slice(0, 4), code })) }));
});

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
