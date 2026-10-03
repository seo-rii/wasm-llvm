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
	await fs.writeFile(path.join(resourceIncludeDir, 'unused.h'), '/* Must be removed. */\n');
	await fs.mkdir(path.join(include, 'unused'));
	await fs.writeFile(path.join(include, 'unused', 'unused.h'), '/* Must be removed. */\n');
	const cProbe = path.join(probeDir, 'probe.c');
	const cppProbe = path.join(probeDir, 'probe.cpp');
	await fs.writeFile(cProbe, '#include <entry.h>\nint main(void) { return selected; }\n');
	await fs.writeFile(cppProbe, cppSource);
	const flags = ['--target=wasm32-wasi', '-nostdinc', '-I', include, '-isystem', resourceIncludeDir];
	return {
		root,
		include,
		conditionalHeaders,
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

test('pruning retains conditional dependencies from C and every C++ standard, including pre-C++11 and C++23/26', { skip: compilerUnavailable }, async (t) => {
	const { root, include, conditionalHeaders, options } = await fixture(t);
	const retained = await pruneSysrootHeaders(options);
	for (const name of conditionalHeaders) {
		assert.ok(retained.has(`include/${name}`), name);
		assert.match(await fs.readFile(path.join(include, name), 'utf8'), /selected/);
	}
	assert.ok(retained.has('lib/clang/22/include/resource.h'));
	await assert.rejects(fs.access(path.join(include, 'unused')), { code: 'ENOENT' });
	await assert.rejects(fs.access(path.join(options.resourceIncludeDir, 'unused.h')), { code: 'ENOENT' });
	// Code generation against the already pruned fixture also succeeds.
	for (const standard of ['gnu++98', 'gnu++03', 'gnu++11', 'gnu++14', 'gnu++17', 'gnu++20', 'gnu++23', 'gnu++26']) {
		const output = path.join(root, `${standard}.o`);
		await execute(compiler, [...options.cppFlags, `-std=${standard}`, '-c', options.cppProbe, '-o', output]);
		assert.deepEqual((await fs.readFile(output)).subarray(0, 4), Buffer.from([0, 97, 115, 109]));
	}
});

test('pruning fails before removing files when a later-standard dependency cannot be collected', { skip: compilerUnavailable }, async (t) => {
	const { include, options } = await fixture(t);
	await fs.rm(path.join(include, 'cpp26.h'));
	await assert.rejects(pruneSysrootHeaders(options), /cpp26\.h.*not found/s);
	await fs.access(path.join(include, 'unused', 'unused.h'));
});

test('post-pruning verification rejects a probe that preprocesses but cannot compile', { skip: compilerUnavailable }, async (t) => {
	const { include, options } = await fixture(t, '#include <entry.h>\nint main() { return missing_symbol; }\n');
	await assert.rejects(pruneSysrootHeaders(options), /undeclared identifier 'missing_symbol'/);
	await assert.rejects(fs.access(path.join(include, 'unused')), { code: 'ENOENT' });
});

test('the real WASI SDK sysroot retains libc++ C++23/26 headers and compiles all producer probes after pruning', { skip: !process.env.WASI_SDK_PATH && 'Set WASI_SDK_PATH for the real sysroot integration test' }, async (t) => {
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
	const retained = await pruneSysrootHeaders({
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
	});
	for (const header of ['__ostream/print.h', '__algorithm/ranges_contains_subrange.h', '__type_traits/is_within_lifetime.h', '__vector/vector_bool_formatter.h']) {
		assert.ok(retained.has(`include/c++/v1/${header}`), header);
	}
	for (const standard of ['gnu++98', 'gnu++03', 'gnu++11', 'gnu++14', 'gnu++17', 'gnu++20', 'gnu++23', 'gnu++26']) {
		const output = path.join(probeDir, `${standard}.o`);
		await execute(compiler, [...cppFlags, `-std=${standard}`, '-c', cppProbe, '-o', output]);
		assert.deepEqual((await fs.readFile(output)).subarray(0, 4), Buffer.from([0, 97, 115, 109]));
	}
});
