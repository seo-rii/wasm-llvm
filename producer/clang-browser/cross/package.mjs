#!/usr/bin/env node
// A separate, opt-in GNU/Linux bundle. No shipped WASI artifact is overwritten.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deterministicTar } from '../scripts/package-language-sysroots.mjs';
import { directoryIdentity } from '../scripts/build-provenance.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const identity = (bytes) => ({ bytes: bytes.length, sha256: digest(bytes) });
const MAX_BYTES = 512 * 1024 * 1024;

function inside(root, candidate) {
	const relative = path.relative(root, candidate);
	return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function relativePath(name) {
	assert(typeof name === 'string' && name && !name.startsWith('/') && !/[\\\x00-\x1f\x7f:]/.test(name) &&
		name.split('/').every((part) => part && part !== '.' && part !== '..'), `Unsafe bundle path: ${name}`);
	return name;
}

// Flatten only links whose real destination is inside this particular input tree.
// Absolute distro links must be normalized into that tree by its curator first.
export async function readNativeTree(directory) {
	const root = await fs.realpath(directory);
	assert((await fs.stat(root)).isDirectory(), 'Input must be a directory');
	const files = [];
	let total = 0;
	async function visit(relative, ancestors = new Set()) {
		const resolved = await fs.realpath(path.join(root, relative));
		assert(inside(root, resolved), `Sysroot symlink escapes its input tree: ${relative}`);
		const stat = await fs.stat(resolved);
		if (stat.isDirectory()) {
			assert(!ancestors.has(resolved), `Sysroot directory link cycle: ${relative}`);
			const next = new Set([...ancestors, resolved]);
			for (const name of (await fs.readdir(resolved)).sort()) {
				await visit(relativePath(relative ? `${relative}/${name}` : name), next);
			}
			return;
		}
		assert(stat.isFile(), `Non-regular sysroot input: ${relative}`);
		assert(files.length < 50000 && stat.size <= MAX_BYTES - total, 'Sysroot exceeds the 512 MiB / 50000 file budget');
		const bytes = await fs.readFile(resolved);
		assert(bytes.length === stat.size && bytes.length <= MAX_BYTES - total, `Sysroot changed while reading: ${relative}`);
		total += bytes.length;
		files.push({ path: relativePath(relative), bytes });
	}
	await visit('');
	return files;
}

export function assertX86Elf(bytes, label, expectedType) {
	assert(bytes.length >= 64 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), `${label}: expected ELF`);
	assert(bytes[4] === 2 && bytes[5] === 1 && bytes[6] === 1 && bytes.readUInt16LE(18) === 62,
		`${label}: expected little-endian ELF64 for x86-64`);
	if (expectedType !== undefined) assert.equal(bytes.readUInt16LE(16), expectedType, `${label}: wrong ELF type`);
}

function assertArchive(bytes, label) {
	assert.equal(bytes.subarray(0, 8).toString(), '!<arch>\n', `${label}: expected a regular static archive, not thin/LTO-only input`);
	let offset = 8;
	let objects = 0;
	while (offset < bytes.length) {
		assert(offset + 60 <= bytes.length, `${label}: truncated archive header`);
		const header = bytes.subarray(offset, offset + 60);
		assert.equal(header.subarray(58).toString(), '`\n', `${label}: bad archive header`);
		const sizeText = header.subarray(48, 58).toString().trim();
		assert(/^\d+$/.test(sizeText), `${label}: invalid member size`);
		const size = Number(sizeText);
		const name = header.subarray(0, 16).toString().trim();
		assert(Number.isSafeInteger(size) && size <= bytes.length - offset - 60, `${label}: truncated archive member`);
		let member = bytes.subarray(offset + 60, offset + 60 + size);
		if (!['/', '//', '/SYM64/'].includes(name) && !name.startsWith('__.SYMDEF')) {
			if (name.startsWith('#1/')) {
				const nameSize = Number(name.slice(3));
				assert(Number.isSafeInteger(nameSize) && nameSize >= 0 && nameSize < member.length, `${label}: bad BSD member name`);
				member = member.subarray(nameSize);
			}
			assertX86Elf(member, `${label}(${name})`, 1);
			objects += 1;
		}
		offset += 60 + size + size % 2;
	}
	assert(offset === bytes.length && objects > 0, `${label}: empty or malformed archive`);
}

export function validateProvenance(value) {
	assert.equal(value.schemaVersion, 1, 'Unsupported GNU provenance schema');
	assert.equal(value.target, 'x86_64-linux-gnu', 'GNU sysroot target must be x86_64-linux-gnu');
	for (const field of ['gccVersion', 'glibcVersion']) assert(/^\d+(?:\.\d+){0,2}$/.test(value[field]), `Invalid ${field}`);
	assert(typeof value.distribution === 'string' && value.distribution.trim(), 'Distribution identity is required');
	if (value.source?.kind === 'debian-packages') {
		assert(Array.isArray(value.source.packages) && value.source.packages.length > 0, 'Installed package identities are required');
		for (const pkg of value.source.packages) for (const field of ['name', 'version', 'sourcePackage', 'sourceVersion']) {
			assert(typeof pkg[field] === 'string' && pkg[field].trim(), `Missing package ${field}`);
		}
		assert(Array.isArray(value.files) && value.files.length > 0, 'Installed package file inventory is required');
		for (const file of value.files) {
			relativePath(file.path);
			assert(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && /^[a-f0-9]{64}$/.test(file.sha256), 'Invalid imported file identity');
		}
	} else {
		assert(Array.isArray(value.sources) && value.sources.length > 0, 'Pinned GNU source/package provenance is required');
		for (const source of value.sources) {
			assert(typeof source.url === 'string' && new URL(source.url).protocol === 'https:', 'Source URL must use HTTPS');
			assert(/^[a-f0-9]{64}$/.test(source.sha256), 'Source package SHA-256 is required');
		}
	}
	assert(Array.isArray(value.licenseFiles) && value.licenseFiles.length > 0, 'GNU license files are required');
	value.licenseFiles.forEach(relativePath);
	return value;
}

export function validateGnuSysroot(files, provenance) {
	validateProvenance(provenance);
	const entries = new Map(files.map((file) => [relativePath(file.path), file.bytes]));
	assert.equal(entries.size, files.length, 'Duplicate sysroot file');
	if (provenance.source?.kind === 'debian-packages') {
		const actual = files.map((file) => ({ path: file.path, ...identity(file.bytes) })).sort((a, b) => a.path.localeCompare(b.path, 'en'));
		const expected = provenance.files.map(({ path: name, bytes, sha256 }) => ({ path: name, bytes, sha256 })).sort((a, b) => a.path.localeCompare(b.path, 'en'));
		assert.deepEqual(actual, expected, 'Sysroot differs from imported package file inventory');
	}
	const required = (name) => {
		const bytes = entries.get(name);
		assert(bytes?.length, `GNU sysroot is missing ${name}`);
		return bytes;
	};
	const gcc = `usr/lib/gcc/x86_64-linux-gnu/${provenance.gccVersion}`;
	const cpp = `usr/include/c++/${provenance.gccVersion}`;
	const cppTarget = `usr/include/x86_64-linux-gnu/c++/${provenance.gccVersion}`;
	for (const name of ['usr/include/stdio.h', 'usr/include/stdlib.h', 'usr/include/features.h',
		`${cpp}/vector`, `${cpp}/ext/pb_ds/assoc_container.hpp`, `${cpp}/ext/pb_ds/detail/rb_tree_map_/rb_tree_.hpp`,
		`${cpp}/ext/pb_ds/detail/tree_policy/order_statistics_imp.hpp`, `${cppTarget}/bits/c++config.h`, ...provenance.licenseFiles]) required(name);
	assert(entries.has(`${cpp}/bits/stdc++.h`) || entries.has(`${cppTarget}/bits/stdc++.h`), 'GNU bits/stdc++.h is missing');
	for (const [name, bytes] of entries) {
		assert(!name.startsWith('lib/clang/'), 'Native sysroot must not override compiler resource headers');
		if (name.endsWith('.h') || name.endsWith('.hpp')) {
			assert(!bytes.includes(Buffer.from('WASM_CLANG_EXT_PB_DS')) && !bytes.includes(Buffer.from('WASM_CLANG_BITS_STDCPP')),
				`WASI compatibility shim is not a GNU sysroot: ${name}`);
		}
		if (name.endsWith('.o')) assertX86Elf(bytes, name, 1);
	}
	const checked = new Set();
	function checkLibrary(name, active = new Set()) {
		if (checked.has(name)) return;
		assert(!active.has(name), `Recursive library script: ${name}`);
		const bytes = required(name);
		if (bytes.subarray(0, 8).toString() === '!<arch>\n') assertArchive(bytes, name);
		else {
			// glibc's libm.a can be a GROUP script referring to libm-*.a and libmvec.a.
			const text = bytes.toString('utf8').replace(/\/\*[\s\S]*?\*\//g, '');
			assert(/\b(?:GROUP|INPUT)\s*\(/.test(text), `${name}: not a static archive or supported GNU linker script`);
			const tokens = text.match(/[^\s(),;]+/g) || [];
			let references = 0;
			for (const token of tokens) {
				if (['GROUP', 'INPUT', 'AS_NEEDED', 'OUTPUT_FORMAT', 'elf64-x86-64'].includes(token)) continue;
				assert(token.endsWith('.a'), `${name}: unsupported linker-script token ${token}`);
				const referenced = token.startsWith('/') ? token.slice(1) : path.posix.join(path.posix.dirname(name), token);
				checkLibrary(relativePath(referenced), new Set([...active, name]));
				references += 1;
			}
			assert(references > 0, `${name}: empty library script`);
		}
		checked.add(name);
	}
	for (const name of [`${gcc}/crtbeginT.o`, `${gcc}/crtend.o`,
		'usr/lib/x86_64-linux-gnu/crt1.o', 'usr/lib/x86_64-linux-gnu/crti.o', 'usr/lib/x86_64-linux-gnu/crtn.o']) assertX86Elf(required(name), name, 1);
	for (const name of [`${gcc}/libstdc++.a`, `${gcc}/libgcc.a`, `${gcc}/libgcc_eh.a`,
		'usr/lib/x86_64-linux-gnu/libc.a', 'usr/lib/x86_64-linux-gnu/libm.a']) checkLibrary(name);
	return { gccInstallation: `/sysroot/${gcc}`, fileCount: files.length };
}

export async function packageCross({ compiler, sysroot, provenance: provenanceFile, output }) {
	compiler = await fs.realpath(compiler);
	sysroot = await fs.realpath(sysroot);
	const out = path.resolve(output);
	const missing = [];
	let ancestor = out;
	for (;;) {
		try { ancestor = await fs.realpath(ancestor); break; }
		catch (error) {
			if (error.code !== 'ENOENT') throw error;
			missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
		}
	}
	const canonicalOut = path.join(ancestor, ...missing);
	assert(![compiler, sysroot].some((input) => inside(input, canonicalOut) || inside(canonicalOut, input)), 'Output must not overlap input trees');
	const receiptBytes = await fs.readFile(path.join(compiler, 'compiler-build.json'));
	const receipt = JSON.parse(receiptBytes);
	const profile = JSON.parse(await fs.readFile(path.join(here, 'profile.json')));
	const producer = JSON.parse(await fs.readFile(path.join(here, '../manifest.json')));
	const toolHost = JSON.parse(await fs.readFile(path.join(here, '../tool-host/profile.json')));
	assert.deepEqual(receipt.cross?.profile, profile, 'Compiler was not built with this native target profile');
	assert.equal(receipt.llvmCommit, producer.sources.llvm.commit, 'Compiler LLVM revision differs from the producer pin');
	assert.equal(receipt.llvmVersion, producer.sources.llvm.version, 'Compiler LLVM version differs from the producer pin');
	assert.deepEqual(receipt.toolHostProfile, toolHost, 'Real driver tool-host profile is required');
	const compiledProfile = await fs.readFile(path.join(compiler, 'cross-profile.json'));
	assert.deepEqual(JSON.parse(compiledProfile), profile, 'Compiled cross profile differs from this producer');
	assert.deepEqual(identity(compiledProfile), receipt.cross.profileIdentity, 'Cross profile changed after compilation');
	assert.deepEqual(await directoryIdentity(path.join(compiler, 'resource-include')), receipt.cross.resourceHeaders, 'Resource headers changed after compilation');
	const provenanceBytes = await fs.readFile(provenanceFile);
	const gnu = validateProvenance(JSON.parse(provenanceBytes));
	const files = await readNativeTree(sysroot);
	const layout = validateGnuSysroot(files, gnu);
	const resourceVersion = receipt.cross.resourceVersion;
	assert(/^\d+$/.test(resourceVersion), 'Invalid Clang resource version');
	const resources = await readNativeTree(path.join(compiler, 'resource-include'));
	for (const required of ['immintrin.h', 'avxintrin.h', 'avx2intrin.h', 'xmmintrin.h', 'emmintrin.h']) {
		assert(resources.some((file) => file.path === required && file.bytes.length), `Resource headers lack ${required}`);
	}
	files.push(...resources.map((file) => ({ ...file, path: `lib/clang/${resourceVersion}/include/${file.path}` })));
	const assets = {};
	const moduleBytes = {};
	const verifyDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'clang-cross-verify-'));
	try {
		for (const name of ['clang', 'lld']) {
			const file = path.join(compiler, name);
			const bytes = await fs.readFile(file);
			assert.deepEqual(identity(bytes), receipt.modules?.[name], `${name} differs from compiler receipt`);
			await execFileAsync(process.execPath, [path.join(here, '../tool-host/verify.mjs'), file,
				path.join(verifyDirectory, `${name}.json`), '--initial-cwd', `--kind=${name}`]);
			assets[name] = { path: `${name}.wasm`, ...identity(bytes) };
			moduleBytes[name] = bytes;
		}
	} finally { await fs.rm(verifyDirectory, { recursive: true, force: true }); }
	const tar = deterministicTar(files);
	assets.sysroot = { path: 'sysroot.tar', ...identity(tar) };
	const manifest = {
		schemaVersion: 1, kind: profile.id, host: profile.host, target: profile.target,
		sysrootPath: '/sysroot', resourceDir: `/sysroot/lib/clang/${resourceVersion}`,
		gccToolchain: '/sysroot/usr', compilerPath: '/bin/clang', linkerPath: '/bin/ld.lld',
		cpuProfiles: profile.cpuProfiles, linkMode: 'static', assets,
		gnu: { gccVersion: gnu.gccVersion, glibcVersion: gnu.glibcVersion,
			distribution: gnu.distribution, source: 'gnu-provenance.json', licenses: gnu.licenseFiles }, ...layout,
		compiler: { family: 'clang', version: receipt.llvmVersion, commit: receipt.llvmCommit },
		provenance: { compilerReceipt: identity(receiptBytes), gnuReceipt: identity(provenanceBytes),
			inventorySha256: digest(JSON.stringify(files.map((file) => ({ path: file.path, ...identity(file.bytes) })))) },
		qualification: { status: 'unverified', note: 'Requires producer Node WASI and consumer Chromium qualification against these exact asset hashes.' }
	};
	// Reserve a new output. A manifest appears only after every payload and notice.
	await fs.mkdir(path.dirname(canonicalOut), { recursive: true });
	await fs.mkdir(canonicalOut);
	for (const name of ['clang', 'lld']) await fs.writeFile(path.join(canonicalOut, assets[name].path), moduleBytes[name], { flag: 'wx' });
	await fs.writeFile(path.join(canonicalOut, 'sysroot.tar'), tar, { flag: 'wx' });
	await fs.writeFile(path.join(canonicalOut, 'compiler-build.json'), receiptBytes, { flag: 'wx' });
	await fs.writeFile(path.join(canonicalOut, 'gnu-provenance.json'), provenanceBytes, { flag: 'wx' });
	await fs.copyFile(path.join(compiler, 'tool-host/LICENSE.LLVM.txt'), path.join(canonicalOut, 'LICENSE.LLVM.txt'), fs.constants.COPYFILE_EXCL);
	const metadata = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
	await fs.writeFile(path.join(canonicalOut, 'cross-toolchain.v1.json'), metadata, { flag: 'wx' });
	return { manifestSha256: digest(metadata), assets };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	if (args.length !== 8 || args[0] !== '--compiler' || args[2] !== '--sysroot' || args[4] !== '--provenance' || args[6] !== '--output') {
		console.error('Usage: node cross/package.mjs --compiler DIR --sysroot DIR --provenance JSON --output NEW_DIR');
		process.exitCode = 1;
	} else {
		try { console.log(JSON.stringify(await packageCross({ compiler: args[1], sysroot: args[3], provenance: args[5], output: args[7] }), null, 2)); }
		catch (error) { console.error(error.message); process.exitCode = 1; }
	}
}
