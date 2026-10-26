#!/usr/bin/env node
// Package only source-pinned, receipt-verified compiler/runtime build outputs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { identity, readNativeTree, relativePath } from '../clang-browser/cross/package.mjs';
import { deterministicTar } from '../clang-browser/scripts/package-language-sysroots.mjs';
import { cases as simdCases, disabledCases } from './simd-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const readJson = async (name) => JSON.parse(await fs.readFile(name, 'utf8'));
const inventory = (files) => files.map((f) => ({ path: f.path, ...identity(f.bytes) }));
const inside = (root, name) => {
	const rel = path.relative(root, name);
	return !rel || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

export function verifyInventory(files, expected, label) {
	const entries = Array.isArray(expected) ? expected : Object.entries(expected).map(([name, value]) => ({ path: name, ...value }));
	const canonical = entries.map((f) => ({ path: relativePath(f.path), bytes: f.bytes ?? f.size, sha256: f.sha256 }));
	assert.equal(new Set(canonical.map((f) => f.path)).size, canonical.length, `${label}: duplicate receipt path`);
	const ordered = (items) => [...items].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	assert.deepEqual(ordered(inventory(files)), ordered(canonical), `${label}: files differ from the build receipt`);
}

export function checkWasm(bytes, label, executable = false) {
	assert(bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])), `${label}: expected WebAssembly`);
	// Relocatable objects can have placeholders that do not validate until linked.
	if (!executable) return;
	assert(WebAssembly.validate(bytes), `${label}: invalid executable Wasm`);
	const module = new WebAssembly.Module(bytes);
	const exports = WebAssembly.Module.exports(module);
	// Emscripten minifies its internal export names; its generated JS maps them.
	assert(exports.some((e) => e.kind === 'memory'), `${label}: no exported memory`);
}

export function verifySimdQualification(report, expected) {
	assert.equal(report.kind, 'gcc-wasi-native-simd-qualification');
	assert.equal(report.status, 'passed', 'SIMD qualification did not pass');
	assert.equal(report.gccCommit, expected.gccCommit);
	assert.equal(report.compiler?.sha256, expected.compilerSha256, 'SIMD qualification covers another GCC binary');
	assert.deepEqual(report.fixture, expected.fixture, 'SIMD fixture changed after qualification');
	assert.deepEqual(report.testRecipe, expected.testRecipe, 'SIMD test recipe changed after qualification');
	assert.deepEqual(report.assembler, expected.assembler, 'SIMD assembler changed after qualification');
	assert.deepEqual(report.linker, expected.linker, 'SIMD linker changed after qualification');
	assert.deepEqual(report.runtime, expected.runtime, 'SIMD runtime differs from the packaged runtime');
	const fixtures = [...simdCases, ...disabledCases];
	assert.deepEqual(report.cases.map((test) => test.id).sort(), fixtures.map((test) => test.id).sort(), 'SIMD qualification is incomplete');
	for (const test of report.cases) {
		const fixture = fixtures.find((f) => f.id === test.id);
		assert.equal(test.status, 'passed', `SIMD fixture failed: ${test.id}`);
		assert.deepEqual(test.source, identity(Buffer.from(fixture.request.code)), 'SIMD source differs from its fixture');
		assert.equal(test.stdout, fixture.stdout, 'SIMD execution output differs from the fixture');
		assert(Number.isSafeInteger(test.wasm?.bytes) && test.wasm.bytes > 8 && /^[a-f0-9]{64}$/.test(test.wasm.sha256), 'Missing SIMD program identity');
		assert.equal(test.commands?.length, 5, 'Missing SIMD compile/assemble/disassemble/link/execute evidence');
		for (const command of test.commands) {
			assert.equal(command.status, 0, 'SIMD command failed');
			assert.equal(command.signal, null, 'SIMD command was interrupted');
			assert(!command.error, 'SIMD command did not execute');
		}
		assert.deepEqual(test.commands.slice(0, 4).map((command) => path.basename(command.command)), ['cc1', 'wat2wasm', 'wasm-objdump', 'wasm-ld']);
		assert(test.commands[0].argv.includes(fixture.request.simd ? '-msimd128' : '-mno-simd128'));
		assert.equal(test.commands[4].stdout, fixture.stdout);
		assert.equal(test.commands[4].stderr, '');
		assert(Array.isArray(test.imports) && test.imports.every((entry) => entry.module === 'wasi_snapshot_preview1' && entry.kind === 'function'));
		assert(test.exports?.some((entry) => entry.name === 'memory' && entry.kind === 'memory'));
		assert(test.exports.some((entry) => entry.name === '_start' && entry.kind === 'function'));
	}
	for (const field of ['disabledDiagnostic', 'defaultDiagnostic']) {
		assert.equal(report[field]?.status, 1, 'SIMD disabled-profile diagnostic was not verified');
		assert.match(report[field].stderr, /SIMD128 is disabled/);
	}
}

export async function packageWasi({ work, runtime, output, libstdcxx, simdQualification, nativeLinker }) {
	work = await fs.realpath(work);
	runtime = await fs.realpath(runtime);
	if (libstdcxx) libstdcxx = await fs.realpath(libstdcxx);
	const out = path.resolve(output);
	const inputs = [work, runtime, libstdcxx].filter(Boolean);
	// Existing parent realpaths also catch output aliases through a symlink.
	await fs.mkdir(path.dirname(out), { recursive: true });
	const finalOut = path.join(await fs.realpath(path.dirname(out)), path.basename(out));
	assert(!inputs.some((input) => inside(input, finalOut) || inside(finalOut, input)), 'Output must not overlap any build input');
	const lockBytes = await fs.readFile(path.join(here, 'sources.lock.json'));
	const runtimeLockBytes = await fs.readFile(path.join(here, 'runtime.lock.json'));
	const lock = JSON.parse(lockBytes), runtimeLock = JSON.parse(runtimeLockBytes);
	const compilerRoot = path.join(work, 'browser-compiler');
	const compilerReceipt = await readJson(path.join(compilerRoot, 'compiler-build.json'));
	assert.equal(compilerReceipt.kind, 'gcc-wasi-browser-build');
	assert.equal(compilerReceipt.gccCommit, lock.gcc.commit);
	assert.equal(compilerReceipt.host, 'wasm32-emscripten');
	assert.equal(compilerReceipt.target, 'wasm32-wasi');
	assert.deepEqual(compilerReceipt.sourceLock, identity(lockBytes));
	assert.deepEqual(compilerReceipt.gccSource?.patches, lock.gcc.patches || []);
	assert.deepEqual(compilerReceipt.recipe, identity(await fs.readFile(path.join(here, 'build-browser.sh'))));
	const compilerFiles = (await readNativeTree(compilerRoot)).filter((f) => f.path !== 'compiler-build.json');
	verifyInventory(compilerFiles, compilerReceipt.files, 'GCC compiler');
	for (const [name, expected] of Object.entries(compilerReceipt.hostDependencies))
		assert.deepEqual(identity(await fs.readFile(path.join(work, 'host-libraries/lib', `lib${name}.a`))), expected, 'Compiler host arithmetic libraries changed');
	const nativeGate = await fs.readFile(path.join(work, 'native-qualification.json'));
	assert.deepEqual(compilerReceipt.nativeQualification, identity(nativeGate));
	assert.equal(JSON.parse(nativeGate).status, 'passed');
	assert.equal(JSON.parse(nativeGate).gccCommit, lock.gcc.commit);
	assert.deepEqual(JSON.parse(nativeGate).gccSource, compilerReceipt.gccSource);
	const nativeReceiptBytes = await fs.readFile(path.join(work, 'native-build.json'));
	const nativeReceipt = JSON.parse(nativeReceiptBytes);
	assert.equal(nativeReceipt.gccCommit, lock.gcc.commit);
	assert.deepEqual(nativeReceipt.gccSource, compilerReceipt.gccSource);
	assert.equal(JSON.parse(nativeGate).buildReceiptSha256, identity(nativeReceiptBytes).sha256);
	assert.equal(JSON.parse(nativeGate).sourceLockSha256, identity(lockBytes).sha256);
	assert.equal(nativeReceipt.sourceLockSha256, identity(lockBytes).sha256);
	let simdProof;
	if (simdQualification) {
		assert(nativeLinker, '--simd-qualification requires --native-linker');
		simdProof = await fs.readFile(simdQualification);
	}

	const asRoot = path.join(work, 'wabt-browser');
	const asReceipt = await readJson(path.join(asRoot, 'provenance.json'));
	assert.equal(asReceipt.commit, lock.wabt.commit);
	assert.equal(asReceipt.host, 'wasm32-emscripten');
	assert.deepEqual(asReceipt.assemblerArguments, ['-r', '--enable-annotations']);
	const asFiles = await Promise.all(['as.mjs', 'as.wasm'].map(async (name) => ({ path: name, bytes: await fs.readFile(path.join(asRoot, name)) })));
	verifyInventory(asFiles, asReceipt.files, 'WABT assembler');
	const runtimeReceipt = await readJson(path.join(runtime, 'runtime-build.json'));
	assert.equal(runtimeReceipt.kind, 'gcc-wasi-runtime-import');
	assert.equal(runtimeReceipt.target, 'wasm32-wasi');
	assert.deepEqual(runtimeReceipt.runtimeLock, identity(runtimeLockBytes));
	assert.equal(runtimeReceipt.sdkArchiveSha256, lock.wasiSdk.sha256);
	assert.deepEqual(runtimeReceipt.patches, runtimeLock.wasiLibc.patches || []);
	const sysroot = await readNativeTree(path.join(runtime, 'sysroot'));
	verifyInventory(sysroot, runtimeReceipt.files, 'WASI sysroot');
	if (simdProof) {
		const report = JSON.parse(simdProof);
		verifySimdQualification(report, {
			gccCommit: lock.gcc.commit,
			compilerSha256: nativeReceipt.tools.cc1.sha256,
			fixture: identity(await fs.readFile(path.join(here, 'simd-fixtures.mjs'))),
			testRecipe: identity(await fs.readFile(path.join(here, 'test-simd.mjs'))),
			assembler: identity(await fs.readFile(path.join(work, 'wabt-native/wat2wasm'))),
			linker: identity(await fs.readFile(nativeLinker)),
			runtime: Object.fromEntries(['crt1-command.o', 'libc.a', 'libm.a', 'libclang_rt.builtins-wasm32.a'].map((name) => [name, identity(sysroot.find((f) => f.path === `lib/wasm32-wasi/${name}`).bytes)]))
		});
		for (const test of report.cases) {
			const bytes = await fs.readFile(path.join(path.dirname(simdQualification), test.id, 'main.wasm'));
			assert.deepEqual(identity(bytes), test.wasm, 'SIMD program differs from its qualification');
			checkWasm(bytes, `SIMD ${test.id}`, true);
			const module = new WebAssembly.Module(bytes);
			assert.deepEqual(WebAssembly.Module.imports(module), test.imports);
			assert.deepEqual(WebAssembly.Module.exports(module), test.exports);
		}
	}
	const linker = await fs.readFile(path.join(runtime, 'ld.wasm'));
	assert.deepEqual(identity(linker), { bytes: runtimeReceipt.linker.bytes, sha256: runtimeReceipt.linker.sha256 });
	assert.equal(runtimeReceipt.linker.commit, runtimeLock.browserLinker.commit);
	assert.equal(runtimeReceipt.linker.archiveSha256, runtimeLock.browserLinker.archiveSha256);
	const llvmProofs = new Map();
	for (const [name, pin] of [['llvm-producer.json', 'producerManifestSha256'], ['llvm-toolchain.json', 'toolchainReceiptSha256']]) {
		const bytes = await fs.readFile(path.join(runtime, name));
		assert.deepEqual(identity(bytes), runtimeReceipt.provenance?.[name], `LLVM provenance changed after import: ${name}`);
		assert.equal(identity(bytes).sha256, runtimeLock.browserLinker[pin], `LLVM provenance differs from the locked original: ${name}`);
		llvmProofs.set(name, bytes);
	}
	checkWasm(linker, 'WASI wasm-ld', true);
	const linkerModule = new WebAssembly.Module(linker);
	assert(WebAssembly.Module.imports(linkerModule).every((i) => i.module === 'wasi_snapshot_preview1'), 'Linker must use only WASI Preview 1 imports');
	assert(WebAssembly.Module.exports(linkerModule).some((e) => e.name === 'memory' && e.kind === 'memory'), 'WASI linker has no exported memory');
	assert(WebAssembly.Module.exports(linkerModule).some((e) => e.name === '_start'), 'Linker has no WASI entry point');

	const gccDirectory = `lib/gcc/wasm32-wasi/${lock.gcc.version}`;
	for (const f of compilerFiles.filter((f) => f.path.startsWith('resource-include/'))) {
		sysroot.push({ path: `${gccDirectory}/include/${f.path.slice('resource-include/'.length)}`, bytes: f.bytes });
	}
	let stdReceipt;
	const runtimeProofs = new Map();
	if (libstdcxx) {
		stdReceipt = await readJson(path.join(libstdcxx, 'libstdcxx-build.json'));
		assert.equal(stdReceipt.status, 'passed', 'libstdc++ must pass native GCC qualification before packaging');
		assert.equal(stdReceipt.gccCommit, lock.gcc.commit);
		assert.equal(stdReceipt.target, 'wasm32-wasi');
		for (const field of ['buildReceipt', 'qualification']) {
			const proof = stdReceipt[field];
			const bytes = await fs.readFile(path.join(libstdcxx, relativePath(proof.path)));
			assert.deepEqual(identity(bytes), { bytes: proof.bytes, sha256: proof.sha256 }, `libstdc++ ${field} differs from qualification`);
			runtimeProofs.set(`libstdcxx-${field}.json`, bytes);
		}
		const build = JSON.parse(runtimeProofs.get('libstdcxx-buildReceipt.json'));
		const qualification = JSON.parse(runtimeProofs.get('libstdcxx-qualification.json'));
		assert.equal(build.status, 'built-unverified');
		assert.equal(build.gccCommit, lock.gcc.commit);
		assert.equal(build.target, 'wasm32-wasi');
		assert.equal(qualification.status, 'passed');
		assert.equal(qualification.gccCommit, lock.gcc.commit);
		assert.equal(qualification.target, 'wasm32-wasi');
		assert.deepEqual(qualification.buildReceipt, identity(runtimeProofs.get('libstdcxx-buildReceipt.json')), 'libstdc++ qualification covers a different build');
		assert.deepEqual(build.gccSource, compilerReceipt.gccSource, 'libstdc++ was built with different GCC patches');
		assert.deepEqual(build.nativeCompiler, Object.fromEntries(Object.entries(nativeReceipt.tools).map(([name, tool]) => [name, tool.sha256])), 'libstdc++ was built with a different native GCC');
		for (const [field, name] of [['recipe', 'build-libstdcxx.sh'], ['patch', 'patches/libstdcxx-wasi-config.patch']]) {
			const bytes = await fs.readFile(path.join(here, name));
			assert.deepEqual(build[field], identity(bytes), `libstdc++ ${field} changed after building`);
			assert.deepEqual(stdReceipt[field], build[field]);
			runtimeProofs.set(path.basename(name), bytes);
		}
		for (const feature of ['exceptions', 'rtti', 'threads', 'timezoneDatabase', 'debugger', 'stdModules']) {
			assert.equal(build[feature], false, `Unsupported libstdc++ feature: ${feature}`);
			assert.equal(stdReceipt[feature], false, `Qualified runtime feature differs: ${feature}`);
		}
		const errnoPatch = identity(await fs.readFile(path.join(here, 'patches/wasi-libc-errno.patch')));
		const errnoHeader = identity(sysroot.find((f) => f.path === 'include/wasm32-wasi/__errno.h').bytes);
		for (const receipt of [build, stdReceipt]) {
			assert.deepEqual(receipt.errnoPatch, errnoPatch, 'libstdc++ errno port differs from the packaged runtime');
			assert.deepEqual(receipt.errnoHeader, errnoHeader, 'libstdc++ errno ABI differs from the packaged sysroot');
		}
		const files = await readNativeTree(path.join(libstdcxx, 'sysroot'));
		verifyInventory(files, stdReceipt.files, 'GNU libstdc++');
		for (const name of ['libstdc++.a', 'libsupc++.a']) {
			const archive = files.find((f) => f.path === `lib/wasm32-wasi/${name}`);
			assert(archive, `GNU runtime archive missing: ${name}`);
			assert.deepEqual(identity(archive.bytes), build.libraries[name], `GNU runtime archive differs from the build: ${name}`);
		}
		for (const required of ['lib/wasm32-wasi/libstdc++.a', `include/c++/${lock.gcc.version}/vector`, `include/c++/${lock.gcc.version}/wasm32-wasi/bits/c++config.h`])
			assert(files.some((f) => f.path === required), `GNU libstdc++ missing ${required}`);
		sysroot.push(...files);
	}
	assert.equal(new Set(sysroot.map((f) => f.path)).size, sysroot.length, 'Duplicate merged sysroot path');
	for (const name of ['include/wasm32-wasi/stdio.h', `${gccDirectory}/include/stddef.h`, 'lib/wasm32-wasi/crt1-command.o', 'lib/wasm32-wasi/libc.a', 'lib/wasm32-wasi/libm.a', 'lib/wasm32-wasi/libclang_rt.builtins-wasm32.a'])
		assert(sysroot.some((f) => f.path === name), `Required sysroot file missing: ${name}`);
	assert(!sysroot.some((f) => /(?:^|\/)libc\+\+/.test(f.path)), 'GCC profile must not silently substitute libc++');
	for (const f of sysroot.filter((f) => f.path.endsWith('.o'))) checkWasm(f.bytes, f.path);
	for (const f of sysroot.filter((f) => f.path.endsWith('.a')))
		assert.equal(f.bytes.subarray(0, 8).toString(), '!<arch>\n', `${f.path}: expected static archive`);
	const payloads = new Map();
	for (const name of ['cc1.mjs', 'cc1.wasm', 'cc1plus.mjs', 'cc1plus.wasm']) {
		const file = compilerFiles.find((f) => f.path === name);
		assert(file, `Missing GCC compiler: ${name}`);
		payloads.set(name, file.bytes);
	}
	for (const f of asFiles) payloads.set(f.path, f.bytes);
	payloads.set('ld.wasm', linker);
	payloads.set('sysroot.tar', deterministicTar(sysroot));
	for (const [name, bytes] of payloads) if (name.endsWith('.wasm')) checkWasm(bytes, name, true);
	const assetPaths = { cc1Js: 'cc1.mjs', cc1Wasm: 'cc1.wasm', cc1plusJs: 'cc1plus.mjs', cc1plusWasm: 'cc1plus.wasm', asJs: 'as.mjs', asWasm: 'as.wasm', ldWasm: 'ld.wasm', sysroot: 'sysroot.tar' };
	const revision = (family, item) => ({ family, repository: item.repository, version: item.version, commit: item.commit });
	const manifest = {
		schemaVersion: 2, kind: 'gcc-wasm32-wasi', host: 'wasm32-emscripten', target: 'wasm32-wasi',
		compiler: revision('gcc', lock.gcc), assembler: revision('wabt', lock.wabt),
		linker: { ...revision('lld', runtimeLock.browserLinker), host: 'wasm32-wasi' },
		sysroot: revision('wasi-libc', runtimeLock.wasiLibc), abi: 'wasm32-wasi-preview1', linkMode: 'static',
		sysrootPath: '/sysroot', gccInstallation: `/sysroot/${gccDirectory}`, resourceDir: `/sysroot/${gccDirectory}/include`,
		assets: Object.fromEntries(Object.entries(assetPaths).map(([key, name]) => [key, { path: name, ...identity(payloads.get(name)) }])),
		runtimeLibraries: ['/sysroot/lib/wasm32-wasi/libclang_rt.builtins-wasm32.a'],
		capabilities: { c: true, cpp: true, libc: true, libm: true, libstdcxx: Boolean(libstdcxx), staticInitialization: true, exceptions: false, rtti: false, threads: false, dynamicLinking: false, simd: Boolean(simdProof) },
		limitations: [
			'Experimental, unmerged GCC 17 backend; not a released GCC target.',
			'long double is binary64 in this GCC port but binary128 in WASI libc; long-double library interfaces are unsupported.',
			'Arbitrary external objects are outside the SDK input contract; direct LLVM v128 and vector aggregate ABI interoperability are not supported.',
			'C++ uses -fno-exceptions -fno-rtti -fuse-cxa-atexit -fno-threadsafe-statics; single-threaded static linking only.',
			'GNU libstdc++ timezone database, C++26 debugger functions and prebuilt std modules are unavailable; no fallback implementations are provided.',
			...(simdProof ? ['SIMD128 is explicit opt-in for GNU 128-bit vector types; automatic vectorization, wasm_simd128.h intrinsics and cross-toolchain vector ABI are not qualified.'] : []),
			'x86 AVX2/FMA intrinsics and target pragmas do not provide Wasm SIMD.'
		],
		qualification: { status: 'unverified' }
	};
	const provenanceFiles = new Map([
		['sources.lock.json', lockBytes], ['runtime.lock.json', runtimeLockBytes],
		['compiler-build.json', json(compilerReceipt)], ['native-build.json', json(nativeReceipt)],
		['native-qualification.json', nativeGate], ['assembler-build.json', json(asReceipt)],
		['runtime-build.json', json(runtimeReceipt)], ['sysroot-inventory.json', json(inventory(sysroot))],
		...llvmProofs
	]);
	if (stdReceipt) provenanceFiles.set('libstdcxx-build.json', json(stdReceipt));
	if (simdProof) provenanceFiles.set('native-simd-qualification.json', simdProof);
	for (const [name, bytes] of runtimeProofs) provenanceFiles.set(name, bytes);
	provenanceFiles.set('host-dependencies.lock.json', await fs.readFile(path.join(here, '../gcc-browser/sources.lock.json')));
	for (const patch of lock.gcc.patches || []) {
		const bytes = await fs.readFile(path.join(here, relativePath(patch.path)));
		assert.equal(identity(bytes).sha256, patch.sha256, 'GCC patch differs from the source lock');
		provenanceFiles.set(path.basename(patch.path), bytes);
	}
	for (const patch of runtimeLock.wasiLibc.patches || []) {
		const bytes = await fs.readFile(path.join(here, relativePath(patch.path)));
		assert.equal(identity(bytes).sha256, patch.sha256, 'WASI patch differs from the runtime lock');
		provenanceFiles.set(path.basename(patch.path), bytes);
	}
	manifest.provenance = {
		gccSource: compilerReceipt.gccSource,
		files: Object.fromEntries([...provenanceFiles].map(([name, bytes]) => [name, { path: `provenance/${name}`, ...identity(bytes) }]))
	};
	const licenseFiles = [...compilerFiles.filter((f) => f.path.startsWith('licenses/'))];
	for (const f of await readNativeTree(path.join(here, 'licenses'))) licenseFiles.push({ path: `licenses/runtime/${f.path}`, bytes: f.bytes });
	for (const name of (await fs.readdir(asRoot)).filter((name) => name.startsWith('LICENSE')))
		licenseFiles.push({ path: `licenses/wabt/${name}`, bytes: await fs.readFile(path.join(asRoot, name)) });
	const licenseSources = await readJson(path.join(here, 'licenses/sources.json'));
	verifyInventory(licenseFiles.filter((f) => f.path.startsWith('licenses/runtime/') && f.path !== 'licenses/runtime/sources.json').map((f) => ({ path: f.path.slice('licenses/runtime/'.length), bytes: f.bytes })), licenseSources, 'Runtime license notices');
	// Reserve a new directory; a failed attempt never becomes a completed bundle.
	await fs.mkdir(finalOut);
	for (const [name, bytes] of payloads) await fs.writeFile(path.join(finalOut, name), bytes, { flag: 'wx' });
	for (const f of licenseFiles) {
		await fs.mkdir(path.dirname(path.join(finalOut, f.path)), { recursive: true });
		await fs.writeFile(path.join(finalOut, f.path), f.bytes, { flag: 'wx' });
	}
	await fs.mkdir(path.join(finalOut, 'provenance'));
	for (const [name, bytes] of provenanceFiles) await fs.writeFile(path.join(finalOut, 'provenance', name), bytes, { flag: 'wx' });
	const loading = [...payloads].map(([name, bytes]) => ({ path: name, ...identity(bytes), gzipBytes: gzipSync(bytes, { level: 9 }).length, brotliBytes: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }).length }));
	const metadata = json(manifest);
	loading.push({ path: 'gcc-toolchain.v2.json', ...identity(metadata), gzipBytes: gzipSync(metadata, { level: 9 }).length, brotliBytes: brotliCompressSync(metadata, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }).length });
	await fs.writeFile(path.join(finalOut, 'loading-sizes.json'), json({ scope: 'All initial manifest and tool/sysroot payloads; SDK Worker modules measured separately by browser qualification', gzipLevel: 9, brotliQuality: 6, assets: loading, totalBytes: loading.reduce((n, a) => n + a.bytes, 0), totalGzipBytes: loading.reduce((n, a) => n + a.gzipBytes, 0), totalBrotliBytes: loading.reduce((n, a) => n + a.brotliBytes, 0) }), { flag: 'wx' });
	await fs.writeFile(path.join(finalOut, 'gcc-toolchain.v2.json'), metadata, { flag: 'wx' });
	return { output: finalOut, manifest: identity(metadata), libstdcxx: Boolean(libstdcxx), status: 'packaged-unverified' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const opts = {};
		for (let i = 2; i < process.argv.length; i += 2) {
			const key = process.argv[i].replace(/^--/, '');
			assert(['work', 'runtime', 'output', 'libstdcxx', 'simd-qualification', 'native-linker'].includes(key) && process.argv[i + 1], 'Usage: package.mjs --work DIR --runtime DIR --output NEW_DIR [--libstdcxx DIR] [--simd-qualification FILE --native-linker FILE]');
			const field = { 'simd-qualification': 'simdQualification', 'native-linker': 'nativeLinker' }[key] || key;
			assert(!opts[field], `Duplicate option: ${key}`);
			opts[field] = process.argv[i + 1];
		}
		assert(opts.work && opts.runtime && opts.output, 'Required: --work DIR --runtime DIR --output NEW_DIR');
		console.log(JSON.stringify(await packageWasi(opts)));
	} catch (error) { console.error(error.message); process.exitCode = 1; }
}
