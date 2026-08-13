import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
	buildWasiFrontend,
	createCmarkWasiCommands,
	createSwiftWasiCommands,
	parseBuildWasiFrontendArgs
} from './build-wasi-frontend.mjs';

test('parses Swift WASI frontend build arguments', () => {
	assert.deepEqual(
		parseBuildWasiFrontendArgs([
			'--source-root', 'source',
			'--swift-source-root', 'swift',
			'--swift-syntax-source-root', 'swift-syntax',
			'--cmark-source-root', 'cmark',
			'--llvm-source-root', 'llvm-source',
			'--build-dir', 'build',
			'--native-build-dir', 'native',
			'--llvm-build-dir', 'llvm',
			'--toolchain', 'toolchain.cmake',
			'--jobs', '3',
			'--receipt', 'receipt.json',
			'--execute', '--configure-only', '--swift-in-swift', '--skip-patch'
		]),
		{
			sourceRoot: path.resolve('source'),
			swiftSourceRoot: path.resolve('swift'),
			swiftSyntaxSourceRoot: path.resolve('swift-syntax'),
			cmarkSourceRoot: path.resolve('cmark'),
			llvmSourceRoot: path.resolve('llvm-source'),
			buildDir: path.resolve('build'),
			nativeBuildDir: path.resolve('native'),
			llvmBuildDir: path.resolve('llvm'),
			toolchainPath: path.resolve('toolchain.cmake'),
			jobs: 3,
			execute: true,
			configureOnly: true,
			swiftInSwift: true,
			skipPatch: true,
			receiptPath: path.resolve('receipt.json')
		}
	);
	assert.deepEqual(parseBuildWasiFrontendArgs(['--help']), { help: true });
	assert.equal(parseBuildWasiFrontendArgs(['--source-root', 'source']).swiftInSwift, true);
	assert.throws(() => parseBuildWasiFrontendArgs([]), /--source-root is required/u);
	assert.throws(
		() => parseBuildWasiFrontendArgs(['--source-root', 'source', '--jobs', '0']),
		/positive integer/u
	);
	assert.throws(
		() => parseBuildWasiFrontendArgs(['--source-root', 'source', '--unknown']),
		/Unknown option/u
	);
});

test('generates size-optimized cmark and Swift WASI commands', () => {
	const cmark = createCmarkWasiCommands({
		cmarkSourceRoot: '/source/cmark',
		llvmSourceRoot: '/source/llvm-project',
		cmarkBuildDir: '/build/cmark-wasi',
		toolchainPath: '/build/toolchain.cmake',
		jobs: 2
	});
	assert.ok(cmark.configure.includes('-DCMAKE_BUILD_TYPE=MinSizeRel'));
	assert.ok(cmark.configure.includes('-DBUILD_SHARED_LIBS=OFF'));
	assert.deepEqual(cmark.build.slice(-2), ['libcmark-gfm', 'libcmark-gfm-extensions']);

	const swift = createSwiftWasiCommands({
		swiftSourceRoot: '/source/swift',
		swiftSyntaxSourceRoot: '/source/swift-syntax',
		stringProcessingSourceRoot: '/source/swift-experimental-string-processing',
		cmarkSourceRoot: '/source/cmark',
		llvmSourceRoot: '/source/llvm-project',
		cmarkBuildDir: '/build/cmark-wasi',
		swiftBuildDir: '/build/swift-wasi',
		llvmBuildDir: '/build/llvm-wasi',
		toolchainPath: '/build/toolchain.cmake',
		nativeBuildDir: '/native',
		jobs: 2,
		swiftInSwift: false
	});
	assert.ok(swift.configure.includes('-DCMAKE_Swift_COMPILER_TARGET=wasm32-unknown-wasip1'));
	assert.ok(swift.configure.includes('-DSWIFT_HOST_VARIANT_SDK=WASI'));
	assert.ok(swift.configure.includes('-DSWIFT_USE_LINKER=lld'));
	assert.ok(swift.configure.includes('-DLLVM_TABLEGEN=/native/llvm-linux-x86_64/bin/llvm-tblgen'));
	assert.ok(swift.configure.includes('-DSWIFT_BUILD_DYNAMIC_STDLIB=OFF'));
	assert.ok(swift.configure.includes('-DSWIFT_ENABLE_SWIFT_IN_SWIFT=OFF'));
	assert.ok(swift.configure.some((argument) => argument.includes('wasmstdlib-linux-x86_64/lib/swift_static')));
	assert.ok(swift.configure.some((argument) => argument.startsWith('-DSWIFT_COMPILER_SOURCES_SDK_FLAGS=-sdk;')));
	assert.ok(swift.configure.some((argument) => argument.includes('-fno-implicit-module-maps')));
	assert.ok(swift.configure.some((argument) => argument.includes('/patches')));
	assert.match(swift.threadShimPath, /llvm-wasi-thread-shim\.h$/u);
	assert.ok(swift.configure.some((argument) => argument.includes('/include/c++/v1/module.modulemap')));
	assert.deepEqual(swift.compilerModuleMaps, [
		'/native/wasi-sysroot/wasm32-wasip1/sysroot/include/c++/v1/module.modulemap',
		'/native/wasmstdlib-linux-x86_64/lib/swift_static/shims/module.modulemap',
		'/source/swift-syntax/Sources/_SwiftSyntaxCShims/include/module.modulemap',
		'/source/swift-syntax/Sources/_SwiftLibraryPluginProviderCShims/include/module.modulemap',
		'/build/llvm-wasi/include/module.modulemap',
		'/source/swift/include/module.modulemap'
	]);
	assert.ok(swift.configure.some((argument) => argument.includes('/swift/include/swift/Basic/WASIThreadShim.h')));
	assert.ok(swift.configure.some((argument) => argument.includes('-D_WASI_EMULATED_SIGNAL')));
	const globalSwiftFlags = swift.configure.find((argument) => argument.startsWith('-DCMAKE_Swift_FLAGS='));
	assert.match(globalSwiftFlags, /-fno-implicit-module-maps/u);
	assert.match(globalSwiftFlags, /\/include\/c\+\+\/v1\/module\.modulemap/u);
	assert.match(globalSwiftFlags, /\/swift\/include\/swift\/Basic\/WASIThreadShim\.h/u);
	assert.ok(swift.configure.some((argument) => argument.includes('SWIFT_WASI_HOST_LIBRARIES_PATH=')));
	assert.ok(swift.configure.some((argument) => argument.endsWith('/wasi/wasm32/swiftrt.o')));
	assert.deepEqual(swift.build.slice(-2), ['-j2', 'swift-frontend']);

	const swiftInSwift = createSwiftWasiCommands({
		swiftSourceRoot: '/source/swift',
		swiftSyntaxSourceRoot: '/source/swift-syntax',
		stringProcessingSourceRoot: '/source/swift-experimental-string-processing',
		cmarkSourceRoot: '/source/cmark',
		llvmSourceRoot: '/source/llvm-project',
		cmarkBuildDir: '/build/cmark-wasi',
		swiftBuildDir: '/build/swift-wasi-full',
		llvmBuildDir: '/build/llvm-wasi',
		toolchainPath: '/build/toolchain.cmake',
		nativeBuildDir: '/native',
		jobs: 2,
		swiftInSwift: true
	});
	assert.ok(swiftInSwift.configure.includes('-DSWIFT_ENABLE_SWIFT_IN_SWIFT=ON'));
	assert.ok(swiftInSwift.configure.includes('-DBRIDGING_MODE=PURE'));
	assert.ok(swiftInSwift.configure.includes('-DBOOTSTRAPPING_MODE=HOSTTOOLS'));
	assert.ok(swiftInSwift.configure.includes('-DSWIFT_PATH_TO_SWIFT_SYNTAX_SOURCE=/source/swift-syntax'));
	assert.ok(swiftInSwift.configure.includes(
		'-DSWIFT_PATH_TO_STRING_PROCESSING_SOURCE=/source/swift-experimental-string-processing'
	));
});

test('tracks the Swift and SwiftSyntax WASI platform patches', async () => {
	const patch = await readFile(new URL('../patches/swift-wasi-platform.patch', import.meta.url), 'utf8');
	const swiftSyntaxPatch = await readFile(
		new URL('../patches/swift-syntax-wasi-platform.patch', import.meta.url),
		'utf8'
	);
	assert.match(patch, /CMAKE_SYSTEM_NAME STREQUAL "WASI"/u);
	assert.match(patch, /llvm::getRandomBytes/u);
	assert.match(patch, /defined\(__wasi__\)/u);
	assert.match(patch, /memcmp\(Value, y\.Value, Size\)/u);
	assert.match(patch, /set\(BUILD_SHARED_LIBS OFF\)/u);
	assert.match(patch, /set\(library_type STATIC\)/u);
	assert.match(patch, /module WASIThreadShim/u);
	assert.match(patch, /defined\(__wasi__\) && defined\(__cplusplus\)/u);
	assert.match(patch, /#if arch\(wasm32\)/u);
	assert.match(patch, /int swift::ExecuteInPlace[\s\S]*#if defined\(__wasi__\)[\s\S]*errno = ENOTSUP/u);
	assert.match(patch, /#if HAVE_UNISTD_H && !defined\(__wasi__\)[\s\S]*swift::ExecuteWithPipe/u);
	assert.match(patch, /HAVE_GETRUSAGE && !defined\(__HAIKU__\) && !defined\(__wasi__\)/u);
	assert.match(patch, /LLVM_ON_UNIX && !defined\(__CYGWIN__\)[\s\S]*!defined\(__wasi__\)/u);
	assert.match(patch, /std::make_unique<Task>/u);
	assert.match(patch, /Wait\(T->PI, 0, &ErrMsg\)/u);
	assert.match(patch, /WASI has no child processes; executable plugin creation always fails/u);
	assert.match(patch, /SWIFT_BUILD_SWIFT_SYNTAX AND NOT SWIFT_HOST_VARIANT_SDK STREQUAL "WASI"/u);
	assert.match(patch, /if\(NOT SWIFT_HOST_VARIANT_SDK STREQUAL "WASI"\)[\s\S]*SwiftInProcPluginServer/u);
	assert.match(patch, /defined\(__APPLE__\) \|\| defined\(__unix__\) \|\| defined\(__wasi__\)/u);
	assert.match(patch, /#if !defined\(__wasi__\)[\s\S]*-in-process-plugin-server-path/u);
	assert.match(patch, /struct BridgedSwiftObject[\s\S]*uintptr_t refCounts/u);
	assert.match(patch, /this->refCounts = ~\(uintptr_t\)0/u);
	assert.match(patch, /class alignas\(1 << TypeAlignInBits\) AbstractConformance/u);
	assert.match(patch, /struct alignas\(Identifier::RequiredAlignment\) CompoundDeclName/u);
	assert.match(swiftSyntaxPatch, /defined\(__unix__\) \|\| defined\(__APPLE__\) \|\| defined\(__wasi__\)/u);
});

test('writes a dry-run Swift WASI frontend receipt', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-frontend-dry-'));
	try {
		const options = parseBuildWasiFrontendArgs([
			'--source-root', path.join(dir, 'source'),
			'--build-dir', path.join(dir, 'build'),
			'--cxx-bootstrap'
		]);
		const receipt = await buildWasiFrontend(options, {
			run: async () => { throw new Error('should not run'); }
		});
		assert.equal(receipt.status, 'dry-run');
		assert.equal(receipt.compilerCompleteness, 'cxx-frontend-bootstrap');
		assert.equal(receipt.swiftInSwift, false);
		assert.equal(receipt.macroPluginLoading, 'not-built');
		assert.equal(receipt.output, null);
		assert.deepEqual(JSON.parse(await readFile(options.receiptPath, 'utf8')), receipt);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('records a built Swift WASI frontend module', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-frontend-run-'));
	try {
		const options = parseBuildWasiFrontendArgs([
			'--source-root', path.join(dir, 'source'),
			'--build-dir', path.join(dir, 'build'),
			'--jobs', '2',
			'--execute'
		]);
		await mkdir(path.dirname(options.toolchainPath), { recursive: true });
		await writeFile(options.toolchainPath, 'toolchain');
		const calls = [];
		const receipt = await buildWasiFrontend(options, {
			checkAccess: async () => {},
			run: async (command, args, runOptions = {}) => {
				calls.push({ command, args, options: runOptions });
				if (command === '/usr/bin/ninja' && args.at(-1) === 'swift-frontend') {
					await mkdir(path.dirname(path.join(options.buildDir, 'swift-wasi/bin/swift-frontend')), {
						recursive: true
					});
					await writeFile(
						path.join(options.buildDir, 'swift-wasi/bin/swift-frontend'),
						Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)
					);
				}
				return { exitCode: 0, signal: null, stdout: '', stderr: '' };
			}
		});
		assert.equal(receipt.status, 'passed');
		assert.equal(receipt.patchStatus, 'already-applied');
		assert.equal(receipt.swiftSyntaxPatchStatus, 'already-applied');
		assert.equal(receipt.output?.bytes, 8);
		assert.equal(calls[0].command, 'git');
		assert.equal(calls.filter((call) => call.command === '/usr/bin/cmake').length, 2);
		assert.equal(calls.filter((call) => call.command === '/usr/bin/ninja').length, 2);
		assert.ok(calls.at(-1).args.includes('swift-frontend'));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
