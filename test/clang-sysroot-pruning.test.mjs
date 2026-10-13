import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { pruneSysrootHeaders, SYSROOT_C_PROBE, SYSROOT_CPP_PROBE } from '../producer/clang-browser/scripts/sysroot-pruning.mjs';
import { GCC_COMPATIBILITY_HEADERS } from '../producer/clang-browser/scripts/gcc-compat.mjs';

const execute = promisify(execFile);
const compiler = process.env.WASI_SDK_PATH
	? path.join(process.env.WASI_SDK_PATH, 'bin', 'clang')
	: process.env.CLANG || 'clang';
let compilerUnavailable;
try {
	await execute(compiler, ['-std=gnu++26', '-x', 'c++', '-fsyntax-only', os.devNull]);
} catch (error) {
	// WASI_SDK_PATH explicitly requests integration coverage; a broken SDK is
	// an error. Developers without Clang 20+ can still run the other unit tests.
	if (process.env.WASI_SDK_PATH) throw error;
	compilerUnavailable = 'Requires Clang with C++26 support (or WASI_SDK_PATH)';
}

async function snapshotHeaders({ sysroot, resourceIncludeDir }) {
	const files = new Map();
	async function walk(directory) {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const filename = path.join(directory, entry.name);
			if (entry.isDirectory()) await walk(filename);
			else files.set(path.relative(sysroot, filename), await fs.readFile(filename));
		}
	}
	await walk(path.join(sysroot, 'include'));
	await walk(resourceIncludeDir);
	return files;
}

async function fixture(t, cppSource = '#include <entry.h>\nint main() { return selected; }\n') {
	// Make dependency escaping is exercised by actual compiler output.
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sysroot probe $ # '));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const include = path.join(root, 'include');
	const resourceIncludeDir = path.join(root, 'lib', 'clang', '22', 'include');
	const probeDir = path.join(root, 'probes');
	await Promise.all([include, resourceIncludeDir, probeDir].map((dir) => fs.mkdir(dir, { recursive: true })));
	const conditionalHeaders = ['c-only.h', 'legacy-only.h', 'cpp11.h', 'cpp14.h', 'cpp17.h', 'cpp20.h', 'cpp23.h', 'cpp26.h'];
	for (const name of conditionalHeaders) {
		await fs.writeFile(path.join(include, name), 'enum { selected = 7 };\n');
	}
	await fs.writeFile(path.join(include, 'entry.h'), `
#include <resource.h>
#ifndef __cplusplus
#include <c-only.h>
#elif __cplusplus < 201103L
#include <legacy-only.h>
#elif __cplusplus < 201402L
#include <cpp11.h>
#elif __cplusplus < 201703L
#include <cpp14.h>
#elif __cplusplus < 202002L
#include <cpp17.h>
#elif __cplusplus < 202302L
#include <cpp20.h>
#elif __cplusplus == 202302L
#include <cpp23.h>
#else
#include <cpp26.h>
#endif
`);
	await fs.writeFile(path.join(resourceIncludeDir, 'resource.h'), '/* Required resource header. */\n');
	const unreachedHeaders = [
		'include/complex.h',
		'include/c++/v1/complex',
		'include/c++/v1/fstream',
		'include/c++/v1/regex',
		'include/c++/v1/valarray',
		'include/c++/v1/__bit/byteswap.h',
		'include/c++/v1/module.modulemap',
		'include/unused/unused.h',
		'lib/clang/22/include/stdatomic.h',
		'lib/clang/22/include/unused.h'
	];
	for (const header of unreachedHeaders) {
		const filename = path.join(root, header);
		await fs.mkdir(path.dirname(filename), { recursive: true });
		await fs.writeFile(filename, `/* Unreached header: ${header}. */\n`);
	}
	const cProbe = path.join(probeDir, 'probe.c');
	const cppProbe = path.join(probeDir, 'probe.cpp');
	await fs.writeFile(cProbe, '#include <entry.h>\nint main(void) { return selected; }\n');
	await fs.writeFile(cppProbe, cppSource);
	const flags = ['--target=wasm32-wasi', '-nostdinc', '-I', include, '-isystem', resourceIncludeDir];
	return {
		root,
		include,
		conditionalHeaders,
		unreachedHeaders,
		options: {
			sysroot: root,
			resourceIncludeDir,
			probeDir,
			cCompiler: compiler,
			cppCompiler: compiler,
			cFlags: flags,
			cppFlags: flags,
			cProbe,
			cppProbe,
			run: (command, args) => execute(command, args)
		}
	};
}

test('validates every C++ standard while preserving public and resource headers outside the probe closure', { skip: compilerUnavailable }, async (t) => {
	const { root, include, conditionalHeaders, unreachedHeaders, options } = await fixture(t);
	const before = await snapshotHeaders(options);
	const retained = await pruneSysrootHeaders(options);
	for (const name of conditionalHeaders) {
		assert.ok(retained.has(`include/${name}`), name);
		assert.match(await fs.readFile(path.join(include, name), 'utf8'), /selected/);
	}
	assert.ok(retained.has('lib/clang/22/include/resource.h'));
	for (const header of unreachedHeaders) assert.ok(!retained.has(header), header);
	assert.deepEqual(await snapshotHeaders(options), before);
	// Code generation after validation also succeeds.
	for (const standard of ['gnu++98', 'gnu++03', 'gnu++11', 'gnu++14', 'gnu++17', 'gnu++20', 'gnu++23', 'gnu++26']) {
		const output = path.join(root, `${standard}.o`);
		await execute(compiler, [...options.cppFlags, `-std=${standard}`, '-c', options.cppProbe, '-o', output]);
		assert.deepEqual((await fs.readFile(output)).subarray(0, 4), Buffer.from([0, 97, 115, 109]));
	}
});

test('missing later-standard dependencies fail without modifying any headers', { skip: compilerUnavailable }, async (t) => {
	const { include, options } = await fixture(t);
	await fs.rm(path.join(include, 'cpp26.h'));
	const before = await snapshotHeaders(options);
	await assert.rejects(pruneSysrootHeaders(options), /cpp26\.h.*not found/s);
	assert.deepEqual(await snapshotHeaders(options), before);
});

test('verification rejects a probe that preprocesses but cannot compile without modifying headers', { skip: compilerUnavailable }, async (t) => {
	const { options } = await fixture(t, '#include <entry.h>\nint main() { return missing_symbol; }\n');
	const before = await snapshotHeaders(options);
	await assert.rejects(pruneSysrootHeaders(options), /undeclared identifier 'missing_symbol'/);
	assert.deepEqual(await snapshotHeaders(options), before);
});

test('the real WASI SDK preserves all selected headers and compiles public families beyond producer probes', { skip: !process.env.WASI_SDK_PATH && 'Set WASI_SDK_PATH for the real sysroot integration test' }, async (t) => {
	const sdk = path.resolve(process.env.WASI_SDK_PATH);
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wasm-llvm-sysroot-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const sourceInclude = path.join(sdk, 'share', 'wasi-sysroot', 'include');
	const targetInclude = path.join(root, 'include', 'wasm32-wasi');
	await fs.cp(path.join(sourceInclude, 'wasm32-wasi'), targetInclude, {
		recursive: true,
		dereference: true,
		filter: (source) => !['noeh', 'eh'].includes(path.basename(source))
	});
	const cppInclude = path.join(root, 'include', 'c++', 'v1');
	await fs.cp(path.join(sourceInclude, 'wasm32-wasi', 'noeh', 'c++', 'v1'), cppInclude, { recursive: true, dereference: true });
	const { stdout: sdkResourceDir } = await execute(compiler, ['-print-resource-dir']);
	const resourceDir = path.join(root, 'lib', 'clang', path.basename(sdkResourceDir.trim()));
	const resourceIncludeDir = path.join(resourceDir, 'include');
	await fs.cp(path.join(sdkResourceDir.trim(), 'include'), resourceIncludeDir, { recursive: true, dereference: true });
	for (const header of GCC_COMPATIBILITY_HEADERS) {
		const target = path.join(root, header.path);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, header.contents);
	}
	const probeDir = path.join(root, 'probes');
	await fs.mkdir(probeDir);
	const cProbe = path.join(probeDir, 'probe.c');
	const cppProbe = path.join(probeDir, 'probe.cpp');
	await fs.writeFile(cProbe, SYSROOT_C_PROBE);
	await fs.writeFile(cppProbe, SYSROOT_CPP_PROBE);
	const flags = ['--target=wasm32-wasi', `--sysroot=${root}`, '-resource-dir', resourceDir, '-I', path.join(root, 'include')];
	const cppFlags = [...flags, '-isystem', cppInclude, '-isystem', targetInclude];
	const options = {
		sysroot: root,
		resourceIncludeDir,
		probeDir,
		cCompiler: compiler,
		cppCompiler: path.join(sdk, 'bin', 'clang++'),
		cFlags: [...flags, '-isystem', targetInclude],
		cppFlags,
		cProbe,
		cppProbe,
		run: (command, args) => execute(command, args)
	};
	const before = await snapshotHeaders(options);
	const retained = await pruneSysrootHeaders(options);
	assert.deepEqual(await snapshotHeaders(options), before);
	for (const header of ['__ostream/print.h', '__algorithm/ranges_contains_subrange.h', '__type_traits/is_within_lifetime.h', '__vector/vector_bool_formatter.h']) {
		assert.ok(retained.has(`include/c++/v1/${header}`), header);
	}
	for (const standard of ['gnu++98', 'gnu++03', 'gnu++11', 'gnu++14', 'gnu++17', 'gnu++20', 'gnu++23', 'gnu++26']) {
		const output = path.join(probeDir, `${standard}.o`);
		await execute(compiler, [...cppFlags, `-std=${standard}`, '-c', cppProbe, '-o', output]);
		assert.deepEqual((await fs.readFile(output)).subarray(0, 4), Buffer.from([0, 97, 115, 109]));
	}
	const publicCppProbe = path.join(probeDir, 'public-headers.cpp');
	await fs.writeFile(publicCppProbe, `
#include <any>
#include <bit>
#include <charconv>
#include <chrono>
#include <complex>
#include <filesystem>
#include <forward_list>
#include <fstream>
#include <memory_resource>
#include <random>
#include <ranges>
#include <regex>
#include <span>
#include <valarray>
#if __cplusplus >= 202302L
static_assert(std::byteswap(0x12345678u) == 0x78563412u);
#endif
int main() {
  std::complex<double> value(3, 4);
  std::valarray<int> values{1, 2, 3};
  std::forward_list<int> list{1, 2, 3};
  char buffer[16];
  auto result = std::to_chars(buffer, buffer + sizeof(buffer), 123);
  return int(std::norm(value)) + values.sum() + list.front() + int(result.ptr - buffer);
}
`);
	for (const standard of ['gnu++20', 'gnu++23', 'gnu++26']) {
		const output = path.join(probeDir, `public-${standard}.o`);
		await execute(compiler, [...cppFlags, `-std=${standard}`, '-c', publicCppProbe, '-o', output]);
		assert.deepEqual((await fs.readFile(output)).subarray(0, 4), Buffer.from([0, 97, 115, 109]));
	}
	const publicCProbe = path.join(probeDir, 'public-headers.c');
	await fs.writeFile(publicCProbe, `
#include <complex.h>
#include <fenv.h>
#include <inttypes.h>
#include <tgmath.h>
#include <threads.h>
#include <uchar.h>
int main(void) {
  double complex value = 3.0 + 4.0 * I;
  return (int)creal(value);
}
`);
	const cOutput = path.join(probeDir, 'public-c.o');
	await execute(compiler, [...options.cFlags, '-std=gnu11', '-c', publicCProbe, '-o', cOutput]);
	assert.deepEqual((await fs.readFile(cOutput)).subarray(0, 4), Buffer.from([0, 97, 115, 109]));
});
