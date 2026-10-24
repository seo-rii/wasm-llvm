#!/usr/bin/env node
// Real compiler/linker qualification in Node WASI. Generated ELF is never run.
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WASI } from 'node:wasi';
import { readTarEntries } from '../../../scripts/lib/tar.mjs';
import { assertX86Elf, digest, identity, relativePath } from './package.mjs';

export function assertStaticExecutable(bytes) {
	assertX86Elf(bytes, 'linked output', 2);
	const offset = Number(bytes.readBigUInt64LE(32));
	const count = bytes.readUInt16LE(56);
	assert(bytes.readUInt16LE(54) === 56 && count > 0 && Number.isSafeInteger(offset) &&
		offset >= 64 && count * 56 <= bytes.length - offset, 'Invalid ELF program headers');
	for (let index = 0; index < count; index += 1) {
		assert.notEqual(bytes.readUInt32LE(offset + index * 56), 3, 'Static output must not have PT_INTERP');
	}
	assert.notEqual(bytes.readBigUInt64LE(24), 0n, 'Executable has no entry point');
}

export async function qualifyCross(bundleArgument, outputArgument) {
	const bundle = realpathSync(bundleArgument);
	const output = path.resolve(outputArgument);
	const canonicalOutput = path.join(realpathSync(path.dirname(output)), path.basename(output));
	assert(canonicalOutput !== bundle && !canonicalOutput.startsWith(bundle + path.sep) &&
		!bundle.startsWith(canonicalOutput + path.sep), 'Qualification output must not overlap the bundle');
	const manifestBytes = readFileSync(path.join(bundle, 'cross-toolchain.v1.json'));
	const manifest = JSON.parse(manifestBytes);
	assert.equal(manifest.schemaVersion, 1);
	assert.equal(manifest.kind, 'clang-x86_64-linux-gnu');
	assert.equal(manifest.target, 'x86_64-unknown-linux-gnu');
	assert.equal(manifest.host, 'wasm32-wasip1');
	assert.equal(manifest.sysrootPath, '/sysroot');
	assert.equal(manifest.compilerPath, '/bin/clang');
	assert.equal(manifest.linkerPath, '/bin/ld.lld');
	assert.equal(manifest.gccToolchain, '/sysroot/usr');
	assert(/^\/sysroot\/lib\/clang\/\d+$/.test(manifest.resourceDir));
	const bytes = {};
	for (const name of ['clang', 'lld', 'sysroot']) {
		const asset = manifest.assets[name];
		const file = realpathSync(path.join(bundle, relativePath(asset.path)));
		assert(file.startsWith(bundle + path.sep), 'Asset escapes bundle');
		bytes[name] = readFileSync(file);
		assert.deepEqual(identity(bytes[name]), { bytes: asset.bytes, sha256: asset.sha256 }, `${name} identity mismatch`);
	}
	const entries = readTarEntries(bytes.sysroot);
	const modules = { clang: new WebAssembly.Module(bytes.clang), lld: new WebAssembly.Module(bytes.lld) };
	mkdirSync(output, { mode: 0o700 }); // An existing path, including a symlink, fails.
	const root = path.join(output, 'root');
	for (const directory of ['bin', 'work', 'tmp', 'sysroot']) mkdirSync(path.join(root, directory), { recursive: true });
	for (const [name, entry] of entries) {
		if (!name) continue;
		const destination = path.join(root, 'sysroot', relativePath(name));
		if (entry.directory) mkdirSync(destination, { recursive: true });
		else {
			mkdirSync(path.dirname(destination), { recursive: true });
			writeFileSync(destination, bytes.sysroot.subarray(entry.offset, entry.offset + entry.size), { flag: 'wx' });
		}
	}
	for (const [name, destination] of [['clang', manifest.compilerPath], ['lld', manifest.linkerPath]]) {
		writeFileSync(path.join(root, destination), bytes[name], { flag: 'wx' });
		chmodSync(path.join(root, destination), 0o700);
	}
	const sources = {
		'main.c': '#include <stdio.h>\n_Static_assert(sizeof(long)==8,"LP64");\nint main(void){ puts("native cross"); return 0; }\n',
		'ps.cpp': '#include <bits/stdc++.h>\n#include <ext/pb_ds/assoc_container.hpp>\n#include <ext/pb_ds/tree_policy.hpp>\nusing namespace __gnu_pbds;\nstatic_assert(sizeof(void*)==8 && __LDBL_MANT_DIG__==64);\nint main(){ tree<int,null_type,std::less<int>,rb_tree_tag,tree_order_statistics_node_update> s; s.insert(42); try { throw 7; } catch(int n){ std::cout << *s.find_by_order(0)+n; } }\n',
		'avx.cpp': '#include <immintrin.h>\n__attribute__((noinline,used)) __m256i sum(__m256i a,__m256i b){ return _mm256_add_epi32(a,b); }\nint main(){return 0;}\n',
		'broken.cpp': 'int main( {\n'
	};
	for (const [name, source] of Object.entries(sources)) writeFileSync(path.join(root, 'work', name), source);
	const commands = [];
	const dispatches = [];
	const decoder = new TextDecoder('utf-8', { fatal: true });
	function invoke(kind, argv, env, descriptors, depth = 0) {
		assert(depth <= 1, 'Nested tool dispatch is not allowed');
		const wasi = new WASI({ version: 'preview1', args: argv, env, preopens: { '/': root }, returnOnExit: true,
			stdin: descriptors[0], stdout: descriptors[1], stderr: descriptors[2] });
		let instance;
		const string = (pointer, length) => {
			pointer >>>= 0; length >>>= 0;
			const memory = new Uint8Array(instance.exports.memory.buffer);
			assert(length <= 1048576 && pointer <= memory.length && length <= memory.length - pointer, 'Invalid guest string');
			const value = decoder.decode(memory.subarray(pointer, pointer + length));
			assert(!value.includes('\0'), 'NUL in guest string');
			return value;
		};
		const table = (pointer, count) => {
			pointer >>>= 0; count >>>= 0;
			const memory = instance.exports.memory.buffer;
			assert(count <= 4096 && pointer <= memory.byteLength && count * 8 <= memory.byteLength - pointer, 'Invalid guest table');
			const view = new DataView(memory);
			const values = [];
			let total = 0;
			for (let index = 0; index < count; index += 1) {
				const offset = pointer + index * 8;
				const length = view.getUint32(offset + 4, true);
				total += length;
				assert(total <= 1048576, 'Guest table exceeds byte budget');
				values.push(string(view.getUint32(offset, true), length));
			}
			return values;
		};
		const imports = {
			...wasi.getImportObject(),
			wasm_idle_process_v1: { initial_cwd(pointer, capacity) {
				pointer >>>= 0; capacity >>>= 0;
				const memory = new Uint8Array(instance.exports.memory.buffer);
				const encoded = new TextEncoder().encode('/work\0');
				assert(pointer <= memory.length && capacity <= memory.length - pointer, 'Invalid cwd buffer');
				if (capacity < encoded.length) return -1;
				memory.set(encoded, pointer);
				return encoded.length;
			} },
			wasm_idle_tool_host: { exec_v1(programPointer, programLength, argvPointer, argc, envPointer, envc, flags) {
				if (kind !== 'clang' || depth !== 0) return -1;
				assert(flags === 0 || flags === 1, 'Unsupported tool-host flags');
				if (flags === 1) assert.equal(envc, 0, 'Inherited environment must not carry a table');
				const program = string(programPointer, programLength);
				const childArgv = table(argvPointer, argc);
				const self = ['', manifest.compilerPath].includes(program) && childArgv[0] === program &&
					childArgv[1] === 'clang' && ['-cc1', '-cc1as'].includes(childArgv[2]);
				assert(self || program === manifest.linkerPath, `Unexpected child executable: ${program}`);
				const childEnv = flags === 1 ? env : Object.create(null);
				if (flags === 0) for (const item of table(envPointer, envc)) {
					const at = item.indexOf('='); assert(at > 0, 'Invalid environment entry');
					childEnv[item.slice(0, at)] = item.slice(at + 1);
				}
				const childKind = self ? 'clang' : 'lld';
				const code = invoke(childKind, childArgv, childEnv, descriptors, depth + 1);
				dispatches.push({ kind: childKind, program, argv: childArgv, code });
				return code;
			} }
		};
		instance = new WebAssembly.Instance(modules[kind], imports);
		return wasi.start(instance);
	}
	function command(label, args, success = true) {
		const stdout = path.join(output, `${label}.stdout`);
		const stderr = path.join(output, `${label}.stderr`);
		const descriptors = [openSync('/dev/null', 'r'), openSync(stdout, 'wx', 0o600), openSync(stderr, 'wx', 0o600)];
		const started = performance.now();
		let code;
		try { code = invoke('clang', [manifest.compilerPath, ...args], { LANG: 'C' }, descriptors); }
		finally { descriptors.forEach(closeSync); }
		const result = { label, args, code, durationMs: performance.now() - started, stdout: readFileSync(stdout, 'utf8'), stderr: readFileSync(stderr, 'utf8') };
		commands.push(result);
		assert(success ? code === 0 : code !== 0, `${label}: unexpected exit ${code}: ${result.stderr}`);
		return result;
	}
	const common = ['--target=' + manifest.target, '--sysroot=/sysroot', '--gcc-toolchain=/sysroot/usr',
		'-resource-dir=' + manifest.resourceDir, '-fuse-ld=lld', '--ld-path=/bin/ld.lld', '--rtlib=libgcc', '--unwindlib=libgcc', '-static', '-fno-pie'];
	let passed = false;
	try {
		assert.match(command('targets', ['--print-targets']).stdout, /\bx86-64\b/);
		command('c', [...common, '-march=x86-64', '-O2', 'main.c', '-o', 'main.elf']);
		assertStaticExecutable(readFileSync(path.join(root, 'work/main.elf')));
		command('cpp', [...common, '--driver-mode=g++', '-march=x86-64', '-std=gnu++20', '-stdlib=libstdc++', '-O2', 'ps.cpp', '-o', 'ps.elf']);
		assertStaticExecutable(readFileSync(path.join(root, 'work/ps.elf')));
		command('avx-assembly', [...common, '-march=x86-64-v3', '-O2', '-S', 'avx.cpp', '-o', 'avx.s']);
		const assembly = readFileSync(path.join(root, 'work/avx.s'), 'utf8');
		assert.match(assembly, /vpaddd/);
		assert.match(assembly, /%ymm/);
		command('avx-link', [...common, '-march=x86-64-v3', '-O2', 'avx.cpp', '-o', 'avx.elf']);
		assertStaticExecutable(readFileSync(path.join(root, 'work/avx.elf')));
		command('diagnostic', [...common, '-fsyntax-only', 'broken.cpp'], false);
		assert(dispatches.some((dispatch) => dispatch.kind === 'lld' && dispatch.code === 0), 'No real ELF linker dispatch was observed');
		passed = true;
	} finally {
		writeFileSync(path.join(output, 'qualification.json'), JSON.stringify({ schemaVersion: 1, kind: 'clang-x86_64-linux-gnu-qualification',
			passed, manifestSha256: digest(manifestBytes), assets: manifest.assets, commands, dispatches,
			execution: 'Generated native ELF files were inspected, never executed.',
			limitations: 'Node WASI only. Chromium, resource limits and native execution are separate gates.' }, null, 2) + '\n');
	}
	return { passed, manifestSha256: digest(manifestBytes), evidence: path.join(output, 'qualification.json') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	if (args.length !== 4 || args[0] !== '--bundle' || args[2] !== '--output') {
		console.error('Usage: node cross/qualify.mjs --bundle DIR --output NEW_DIR'); process.exitCode = 1;
	} else {
		try { console.log(JSON.stringify(await qualifyCross(args[1], args[3]), null, 2)); }
		catch (error) { console.error(error.message); process.exitCode = 1; }
	}
}
