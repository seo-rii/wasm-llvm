import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
	EMSCRIPTEN_LINK_OPTIONS,
	GENERATED_LOADER,
	GENERATED_PTHREAD_WORKER,
	GENERATED_WASM,
	PACKAGED_PTHREAD_WORKER,
	WAMR_CMAKE_OPTIONS,
	buildWamrBrowser
} from '../scripts/build.mjs';
import { packageWamrBrowser } from '../scripts/package.mjs';
import { WAMR_PATCH_PATHS, prepareWamrSource } from '../scripts/prepare.mjs';
import {
	DEFAULT_COMPRESSED_SIZE_BUDGET,
	DEFAULT_RAW_SIZE_BUDGET,
	verifyWamrBrowser
} from '../scripts/verify.mjs';
import {
	assertReproducibleWamrBuilds,
	verifyReproducibleWamrArtifactDirectories
} from '../scripts/verify-reproducibility.mjs';

const execFileAsync = promisify(execFile);
const producerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('pins WAMR, emsdk, and the classic source-debug interpreter', async () => {
	const manifest = JSON.parse(await readFile(path.join(producerRoot, 'manifest.json'), 'utf8'));
	const lock = JSON.parse(await readFile(path.join(producerRoot, 'sources.lock.json'), 'utf8'));
	assert.match(manifest.sources.wamr.commit, /^[\da-f]{40}$/u);
	assert.equal(lock.wamr.commit, manifest.sources.wamr.commit);
	assert.equal(lock.emscripten.version, '6.0.0');
	assert.match(lock.emscripten.commit, /^[\da-f]{40}$/u);
	assert.equal(manifest.configuration.interpreter, 'classic');
	assert.equal(manifest.configuration.sourceDebugger, true);
	assert.equal(manifest.configuration.aot, false);
	assert.equal(manifest.configuration.jit, false);
	assert.equal(manifest.configuration.guestThreads, false);
	assert.equal(manifest.configuration.functionPointerCastEmulation, true);
	assert.equal(manifest.configuration.maximumFunctionParameters, 21);
	assert.equal(manifest.configuration.nativeReturnAbi, 'wasm32-wasi-i32-or-void');
	assert.equal(manifest.configuration.nativeDispatchScope, 'emscripten-wasm32-wasi');
	assert.deepEqual(manifest.configuration.exportedRuntimeMethods, [
		'FS',
		'callMain',
		'HEAPU8'
	]);
	assert.deepEqual(manifest.configuration.wasiI64ArgumentSignatures, [
		'(iI*)i',
		'(i*iI*)i',
		'(iIi*)i',
		'(iII)i',
		'(iIIi)i',
		'(ii*~iIIi*)i',
		'(i*~I*)i',
		'(iI)i',
		'(ii*~IIi)i'
	]);
	assert.equal(manifest.configuration.genericNativeI64OrFloatReturns, false);
	assert.ok(WAMR_CMAKE_OPTIONS.includes('-DWAMR_BUILD_DEBUG_INTERP=1'));
	assert.ok(WAMR_CMAKE_OPTIONS.includes('-DWAMR_BUILD_INVOKE_NATIVE_GENERAL=1'));
	assert.ok(WAMR_CMAKE_OPTIONS.includes('-DWAMR_BUILD_ALLOC_WITH_USAGE=1'));
	assert.ok(WAMR_CMAKE_OPTIONS.includes('-DWAMR_BUILD_FAST_INTERP=0'));
	assert.ok(WAMR_CMAKE_OPTIONS.includes('-DWAMR_BUILD_AOT=0'));
	assert.ok(WAMR_CMAKE_OPTIONS.includes('-DWAMR_BUILD_JIT=0'));
	assert.ok(
		WAMR_CMAKE_OPTIONS.some((option) =>
			option.includes('-include wasm_debug_emscripten_compat.h')
		)
	);
	assert.ok(!WAMR_CMAKE_OPTIONS.includes('-DWAMR_BUILD_SOURCE_DEBUG=1'));
});

test('uses a strict pthread pool without proxying the WAMR main lifetime', () => {
	assert.ok(EMSCRIPTEN_LINK_OPTIONS.includes('-pthread'));
	assert.ok(EMSCRIPTEN_LINK_OPTIONS.includes('-sPTHREAD_POOL_SIZE=2'));
	assert.ok(EMSCRIPTEN_LINK_OPTIONS.includes('-sPTHREAD_POOL_SIZE_STRICT=2'));
	assert.ok(EMSCRIPTEN_LINK_OPTIONS.includes('-sENVIRONMENT=worker'));
	assert.ok(EMSCRIPTEN_LINK_OPTIONS.includes('-sALLOW_MEMORY_GROWTH=1'));
	assert.ok(EMSCRIPTEN_LINK_OPTIONS.includes('-sINITIAL_MEMORY=67108864'));
	assert.ok(EMSCRIPTEN_LINK_OPTIONS.includes('-sMAXIMUM_MEMORY=2147483648'));
	assert.ok(!EMSCRIPTEN_LINK_OPTIONS.includes('-sINITIAL_MEMORY=268435456'));
	assert.ok(
		EMSCRIPTEN_LINK_OPTIONS.includes(
			"-sEXPORTED_RUNTIME_METHODS=['FS','callMain','HEAPU8']"
		)
	);
	assert.ok(EMSCRIPTEN_LINK_OPTIONS.includes('-sEMULATE_FUNCTION_POINTER_CASTS=1'));
	assert.ok(
		EMSCRIPTEN_LINK_OPTIONS.includes(
			'-sBINARYEN_EXTRA_PASSES=--pass-arg=max-func-params@21'
		)
	);
	assert.ok(!EMSCRIPTEN_LINK_OPTIONS.includes('-sPROXY_TO_PTHREAD=1'));
	assert.ok(!EMSCRIPTEN_LINK_OPTIONS.includes('-sUSE_PTHREADS=1'));
	assert.equal(GENERATED_LOADER, 'iwasm.js');
	assert.equal(GENERATED_PTHREAD_WORKER, 'iwasm.js-2.4.5');
	assert.equal(GENERATED_WASM, 'iwasm.js-2.4.wasm');
	assert.equal(PACKAGED_PTHREAD_WORKER, 'wamr-debug.worker.mjs');
});

test('requires the explicitly pinned emsdk checkout', async () => {
	await assert.rejects(buildWamrBrowser({ source: '.', build: '.' }), /--emsdk is required/u);
});

test('pins explicit WAMR raw and compressed Wasm size budgets', () => {
	assert.equal(DEFAULT_RAW_SIZE_BUDGET, 1024 * 1024);
	assert.equal(DEFAULT_COMPRESSED_SIZE_BUDGET, 512 * 1024);
});

test('bridges raw ring descriptors into pthread realms without blocking proxy calls', async () => {
	const patch = await readFile(
		path.join(producerRoot, 'patches', 'wamr-browser-debug-transport.patch'),
		'utf8'
	);
	const library = await readFile(
		path.join(producerRoot, 'src', 'wasm-debug-transport.js'),
		'utf8'
	);
	for (const packet of ['qWasmCallStack', 'qWasmLocal', 'qWasmGlobal', 'qWasmStackValue']) {
		// The packet handlers remain in upstream WAMR; the patch must not replace them.
		assert.doesNotMatch(patch, new RegExp(`handle_${packet}`, 'u'));
	}
	assert.match(patch, /wasm_debug_transport_read/u);
	assert.match(patch, /wasm_debug_transport_write_all/u);
	assert.doesNotMatch(library, /WebSocket|TCP|os_socket/u);
	assert.doesNotMatch(library, /__proxy\s*:/u);
	assert.match(library, /PThread\.loadWasmModuleToWorker/u);
	assert.match(library, /worker\.postMessage\(message\)/u);
	assert.match(library, /globalThis\.addEventListener\('message'/u);
	assert.match(library, /queue\.descriptor \|\| queue/u);
	assert.match(library, /Atomics\.wait/u);
});

test('transport distinguishes timeout, close, and bytes pending at close', async () => {
	const library = await readFile(
		path.join(producerRoot, 'src', 'wasm-debug-transport.js'),
		'utf8'
	);
	const context = {
		Atomics,
		Date,
		Error,
		Int32Array,
		LibraryManager: { library: {} },
		Module: {},
		Number,
		Object,
		PThread: {},
		SharedArrayBuffer,
		Uint8Array,
		ENVIRONMENT_IS_PTHREAD: false,
		HEAPU8: new Uint8Array(32),
		mergeInto(target, source) {
			Object.assign(target, source);
		}
	};
	vm.runInNewContext(library, context);
	const transport = context.LibraryManager.library.$WasmIdleDebugTransportV1;
	context.WasmIdleDebugTransportV1 = transport;

	const control = new SharedArrayBuffer(7 * Int32Array.BYTES_PER_ELEMENT);
	const data = new SharedArrayBuffer(4096);
	const header = new Int32Array(control);
	Atomics.store(header, transport.CAPACITY, 4096);
	Atomics.store(header, transport.GENERATION, 1);
	const descriptor = { control, data, generation: 1 };
	assert.equal(transport.setTransport({ rspInput: descriptor, rspOutput: descriptor }), true);
	assert.equal(transport.read(transport.rspInput, 0, 1, 0), 0);

	new Uint8Array(data)[0] = 65;
	Atomics.store(header, transport.WRITE, 1);
	Atomics.store(header, transport.STATE, 1);
	assert.equal(transport.read(transport.rspInput, 0, 1, 0), 1);
	assert.equal(context.HEAPU8[0], 65);
	assert.equal(transport.read(transport.rspInput, 0, 1, 0), -2);
	assert.equal(transport.write(transport.rspOutput, 0, 1, 0), -2);
	Atomics.store(header, transport.STATE, 2);
	assert.equal(transport.read(transport.rspInput, 0, 1, 0), -1);

	const cTransport = await readFile(
		path.join(producerRoot, 'src', 'wasm_debug_transport.c'),
		'utf8'
	);
	assert.match(
		cTransport,
		/if \(!transport \|\| transport->closed\)\s+return WASM_DEBUG_TRANSPORT_CLOSED;/u
	);
	const patch = await readFile(
		path.join(producerRoot, 'patches', 'wamr-browser-debug-transport.patch'),
		'utf8'
	);
	assert.match(patch, /n == WASM_DEBUG_TRANSPORT_CLOSED/u);
});

test('preserves wasm32-wasi i32 native returns only in Emscripten builds', async () => {
	const manifest = JSON.parse(await readFile(path.join(producerRoot, 'manifest.json'), 'utf8'));
	assert.deepEqual(
		WAMR_PATCH_PATHS,
		Object.values(manifest.patches).map((entry) => entry.path)
	);
	const patch = await readFile(
		path.join(producerRoot, manifest.patches.wasm32WasiNativeReturn.path),
		'utf8'
	);
	assert.deepEqual(
		Array.from(
			patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gmu),
			([, oldPath, newPath]) => [oldPath, newPath]
		),
		[
			[
				'core/iwasm/common/arch/invokeNative_general.c',
				'core/iwasm/common/arch/invokeNative_general.c'
			],
			[
				'core/iwasm/common/wasm_runtime_common.c',
				'core/iwasm/common/wasm_runtime_common.c'
			]
		]
	);
	assert.match(
		patch,
		/\+#if defined\(__EMSCRIPTEN__\)\n\+uint32\n\+#else\n void\n\+#endif\n invokeNative\(void \(\*native_code\)\(\)/u
	);
	assert.match(
		patch,
		/\+#if defined\(__EMSCRIPTEN__\)\n\+#define native_code\(\.\.\.\) return \(\(uint32 \(\*\)\(\)\)native_code\)\(__VA_ARGS__\)\n\+#endif/u
	);
	assert.match(
		patch,
		/\+#if defined\(__EMSCRIPTEN__\)\n\+\s+return 0;\n\+#else\n\s+return;\n\+#endif/u
	);
	assert.match(
		patch,
		/\+#if defined\(__EMSCRIPTEN__\)\n\+uint32\n\+#else\n void\n\+#endif\n invokeNative\(GenericFunctionPointer f, uint32 \*args, uint32 sz\);/u
	);
	const runtimeCommonPatch = patch.slice(
		patch.indexOf('diff --git a/core/iwasm/common/wasm_runtime_common.c')
	);
	assert.doesNotMatch(patch, /^-void$/gmu);
	assert.deepEqual(
		runtimeCommonPatch
			.split('\n')
			.filter((line) => /^[+-](?![+-]{2})/u.test(line)),
		['+#if defined(__EMSCRIPTEN__)', '+uint32', '+#else', '+#endif']
	);
	assert.doesNotMatch(patch, /^\+.*(?:Float64|float32|int64).*$/gmu);
});

test('dispatches every libc-wasi I signature through an exact Emscripten trampoline', async () => {
	const manifest = JSON.parse(await readFile(path.join(producerRoot, 'manifest.json'), 'utf8'));
	const patch = await readFile(
		path.join(producerRoot, manifest.patches.wasiI64ArgumentDispatch.path),
		'utf8'
	);
	assert.equal(
		manifest.patches.wasiI64ArgumentDispatch.validatedCompositeSha256,
		'5d1a3bb4f4c2d0e0ba0256bef753bfb979416405f2ed1c516fb90824abb89046'
	);
	assert.deepEqual(
		Array.from(
			patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gmu),
			([, oldPath, newPath]) => [oldPath, newPath]
		),
		[
			[
				'core/iwasm/common/arch/invokeNative_general.c',
				'core/iwasm/common/arch/invokeNative_general.c'
			],
			[
				'core/iwasm/common/wasm_runtime_common.c',
				'core/iwasm/common/wasm_runtime_common.c'
			]
		]
	);
	const addedSource = patch
		.split('\n')
		.filter((line) => line.startsWith('+') && !line.startsWith('+++'))
		.map((line) => line.slice(1))
		.join('\n');
	const compactSource = addedSource.replace(/\s+/gu, ' ');
	assert.match(
		compactSource,
		/#if defined\(__EMSCRIPTEN__\) static uint64 read_uint64.+return \(\(uint64\)argv\[index \+ 1\] << 32\) \| argv\[index\];/u
	);

	const dispatches = [
		{
			signature: '(iI*)i',
			argc: 5,
			parameters: 'uint32, uint32, uint64, uint32',
			i64Indices: [2]
		},
		{
			signature: '(i*iI*)i',
			argc: 7,
			parameters: 'uint32, uint32, uint32, uint32, uint64, uint32',
			i64Indices: [4]
		},
		{
			signature: '(iIi*)i',
			argc: 6,
			parameters: 'uint32, uint32, uint64, uint32, uint32',
			i64Indices: [2]
		},
		{
			signature: '(iII)i',
			argc: 6,
			parameters: 'uint32, uint32, uint64, uint64',
			i64Indices: [2, 4]
		},
		{
			signature: '(iIIi)i',
			argc: 7,
			parameters: 'uint32, uint32, uint64, uint64, uint32',
			i64Indices: [2, 4]
		},
		{
			signature: '(ii*~iIIi*)i',
			argc: 12,
			parameters:
				'uint32, uint32, uint32, uint32, uint32, uint32, uint64, uint64, uint32, uint32',
			i64Indices: [6, 8]
		},
		{
			signature: '(i*~I*)i',
			argc: 7,
			parameters: 'uint32, uint32, uint32, uint32, uint64, uint32',
			i64Indices: [4]
		},
		{
			signature: '(iI)i',
			argc: 4,
			parameters: 'uint32, uint32, uint64',
			i64Indices: [2]
		},
		{
			signature: '(ii*~IIi)i',
			argc: 10,
			parameters: 'uint32, uint32, uint32, uint32, uint32, uint64, uint64, uint32',
			i64Indices: [5, 7]
		}
	];
	for (const [index, dispatch] of dispatches.entries()) {
		const marker = `strcmp(signature, "${dispatch.signature}") == 0 && argc == ${dispatch.argc}`;
		const branchStart = compactSource.indexOf(marker);
		assert.notEqual(branchStart, -1, dispatch.signature);
		const nextBranch = compactSource.indexOf('else if (strcmp(signature,', branchStart + marker.length);
		const branch = compactSource.slice(
			branchStart,
			index === dispatches.length - 1 || nextBranch === -1
				? compactSource.indexOf('else { return false;', branchStart)
				: nextBranch
		);
		assert.match(
			branch,
			new RegExp(`typedef uint32 \\(\\*NativeFunc\\)\\(${dispatch.parameters}\\);`, 'u'),
			dispatch.signature
		);
		assert.deepEqual(
			Array.from(branch.matchAll(/read_uint64\(argv, (\d+)\)/gu), ([, offset]) =>
				Number(offset)
			),
			dispatch.i64Indices,
			dispatch.signature
		);
	}
	assert.deepEqual(
		Array.from(
			compactSource.matchAll(/strcmp\(signature, "([^"]+)"\) == 0/gu),
			([, signature]) => signature
		),
		manifest.configuration.wasiI64ArgumentSignatures
	);
	assert.match(
		compactSource,
		/#if defined\(__EMSCRIPTEN__\) if \(!\(signature && invokeNative_browser_i64\(func_ptr, argv1, argc1, signature, argv_ret\)\)\) #endif \{ argv_ret\[0\] = \(uint32\)invokeNative_Int32/u
	);
	assert.doesNotMatch(compactSource, /invokeNative_browser_i64.+VALUE_TYPE_I64/u);
});

test('patch hunks are well formed and all source inputs match the manifest', async () => {
	const manifest = JSON.parse(await readFile(path.join(producerRoot, 'manifest.json'), 'utf8'));
	for (const entry of [...Object.values(manifest.patches), ...Object.values(manifest.overlays)]) {
		const bytes = await readFile(path.join(producerRoot, entry.path));
		assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.path);
	}
	for (const entry of Object.values(manifest.patches)) {
		const patch = await readFile(path.join(producerRoot, entry.path), 'utf8');
		const lines = patch.split('\n');
		for (let index = 0; index < lines.length; index += 1) {
			const match = lines[index].match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/u);
			if (!match) continue;
			let oldCount = 0;
			let newCount = 0;
			for (
				let line = index + 1;
				line < lines.length &&
				!lines[line].startsWith('@@') &&
				!lines[line].startsWith('diff --git');
				line += 1
			) {
				if (lines[line].startsWith(' ')) {
					oldCount += 1;
					newCount += 1;
				} else if (lines[line].startsWith('-')) {
					oldCount += 1;
				} else if (lines[line].startsWith('+')) {
					newCount += 1;
				}
			}
			assert.equal(oldCount, Number(match[1] ?? 1), `${entry.path}: ${lines[index]}`);
			assert.equal(newCount, Number(match[2] ?? 1), `${entry.path}: ${lines[index]}`);
		}
	}
});

test(
	'plain git apply accepts all patches against a supplied pinned WAMR checkout',
	{ skip: !process.env.WAMR_SOURCE },
	async () => {
		const source = path.resolve(process.env.WAMR_SOURCE);
		const lock = JSON.parse(
			await readFile(path.join(producerRoot, 'sources.lock.json'), 'utf8')
		);
		const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
			cwd: source,
			encoding: 'utf8'
		});
		assert.equal(stdout.trim(), lock.wamr.commit);
		const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'wamr-browser-patch-index-'));
		try {
			const env = {
				...process.env,
				GIT_INDEX_FILE: path.join(temporaryRoot, 'index')
			};
			await execFileAsync('git', ['read-tree', 'HEAD'], { cwd: source, env });
			for (const patchPath of WAMR_PATCH_PATHS) {
				const absolutePatch = path.join(producerRoot, patchPath);
				await execFileAsync('git', ['apply', '--cached', '--check', absolutePatch], {
					cwd: source,
					env
				});
				await execFileAsync('git', ['apply', '--cached', absolutePatch], {
					cwd: source,
					env
				});
			}
		} finally {
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	}
);

test(
	'prepare applies the dependent patch set idempotently to a pinned WAMR checkout',
	{ skip: !process.env.WAMR_SOURCE },
	async () => {
		const source = path.resolve(process.env.WAMR_SOURCE);
		const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'wamr-browser-prepare-'));
		const checkout = path.join(temporaryRoot, 'source');
		await execFileAsync('git', ['worktree', 'add', '--detach', checkout, 'HEAD'], {
			cwd: source
		});
		try {
			await prepareWamrSource({ source: checkout });
			const { stdout: firstDiff } = await execFileAsync('git', ['diff'], {
				cwd: checkout,
				encoding: 'utf8'
			});
			await prepareWamrSource({ source: checkout });
			const { stdout: secondDiff } = await execFileAsync('git', ['diff'], {
				cwd: checkout,
				encoding: 'utf8'
			});
			assert.equal(secondDiff, firstDiff);
			assert.match(secondDiff, /invokeNative_browser_i64/u);
			assert.match(secondDiff, /#if defined\(__EMSCRIPTEN__\)/u);
		} finally {
			await execFileAsync('git', ['worktree', 'remove', '--force', checkout], {
				cwd: source
			});
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	}
);

test('packages and verifies the pthread sidecar as a hashed artifact', async () => {
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'wamr-browser-producer-'));
	try {
		const build = path.join(temporaryRoot, 'build');
		const input = path.join(build, 'wasm-idle-output');
		const output = path.join(temporaryRoot, 'output');
		const secondOutput = path.join(temporaryRoot, 'second-output');
		await mkdir(input, { recursive: true });
		await writeFile(
			path.join(input, 'wamr-debug.js'),
			[
				'createWamrDebugModule',
				'wasm_idle_rsp_read',
				'wasm_idle_rsp_write',
				PACKAGED_PTHREAD_WORKER
			].join('\n')
		);
		await writeFile(
			path.join(input, 'wamr-debug.wasm'),
			Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)
		);
		await writeFile(
			path.join(input, PACKAGED_PTHREAD_WORKER),
			[
				'createWamrDebugModule',
				'wasmIdleDebugTransportV1',
				'globalThis.onmessage = () => undefined;'
			].join('\n')
		);

		await packageWamrBrowser({ build, output });
		await verifyWamrBrowser({ artifacts: output });
		await assert.rejects(
			verifyWamrBrowser({ artifacts: output, rawSizeBudget: 7 }),
			/wamr-debug\.wasm exceeds its 7-byte raw size budget/u
		);
		await packageWamrBrowser({ build, output: secondOutput });
		const reproducibleReceipt = await verifyReproducibleWamrArtifactDirectories(
			output,
			secondOutput
		);
		assert.equal(reproducibleReceipt.wamrRevision.length, 40);

		const receipt = JSON.parse(
			await readFile(path.join(output, 'producer-receipt.json'), 'utf8')
		);
		assert.equal(receipt.pthreadTransport, 'pthread-transport-v1');
		assert.equal(receipt.emsdkRevision.length, 40);
		const sourcesLockBytes = await readFile(path.join(producerRoot, 'sources.lock.json'));
		const manifestBytes = await readFile(path.join(producerRoot, 'manifest.json'));
		const manifest = JSON.parse(manifestBytes);
		assert.deepEqual(receipt.provenance, {
			sourcesLockSha256: createHash('sha256').update(sourcesLockBytes).digest('hex'),
			producerManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
			patchesSha256: createHash('sha256')
				.update(Object.values(manifest.patches).map((entry) => entry.sha256).join('\n'))
				.digest('hex'),
			overlaysSha256: createHash('sha256')
				.update(Object.values(manifest.overlays).map((entry) => entry.sha256).join('\n'))
				.digest('hex')
		});
		assert.ok(receipt.assets.some((asset) => asset.path === PACKAGED_PTHREAD_WORKER));
		assert.ok(manifest.outputs.includes(PACKAGED_PTHREAD_WORKER));
		for (const requiredAsset of [
			'wamr-debug.js',
			'wamr-debug.wasm',
			PACKAGED_PTHREAD_WORKER,
			'wamr-debug.wasm.gz'
		]) {
			const incompleteReceipt = structuredClone(receipt);
			incompleteReceipt.assets = incompleteReceipt.assets.filter(
				(asset) => asset.path !== requiredAsset
			);
			await writeFile(
				path.join(output, 'producer-receipt.json'),
				`${JSON.stringify(incompleteReceipt, null, 2)}\n`
			);
			await assert.rejects(
				verifyWamrBrowser({ artifacts: output }),
				{ message: `WAMR debugger receipt is missing ${requiredAsset}` }
			);
		}
		const duplicateReceipt = structuredClone(receipt);
		duplicateReceipt.assets.push(structuredClone(duplicateReceipt.assets[0]));
		await writeFile(
			path.join(output, 'producer-receipt.json'),
			`${JSON.stringify(duplicateReceipt, null, 2)}\n`
		);
		const unexpectedReceipt = structuredClone(receipt);
		unexpectedReceipt.assets.push({
			path: 'unexpected-runtime.bin',
			bytes: 0,
			sha256: createHash('sha256').update('').digest('hex')
		});
		await writeFile(
			path.join(secondOutput, 'producer-receipt.json'),
			`${JSON.stringify(unexpectedReceipt, null, 2)}\n`
		);
		await Promise.all([
			assert.rejects(verifyWamrBrowser({ artifacts: output }), {
				message: 'WAMR debugger receipt contains duplicate asset metadata'
			}),
			assert.rejects(verifyWamrBrowser({ artifacts: secondOutput }), {
				message: 'WAMR debugger receipt contains unexpected asset metadata'
			})
		]);
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
});

test('clean build comparison rejects WAMR provenance and asset differences', () => {
	const receipt = {
		format: 'wasm-idle-wamr-debug-v1',
		wamrRevision: 'wamr-revision',
		emsdkRevision: 'emsdk-revision',
		provenance: {
			sourcesLockSha256: 'sources',
			producerManifestSha256: 'manifest',
			patchesSha256: 'patches',
			overlaysSha256: 'overlays'
		},
		assets: [
			{ path: 'wamr-debug.js', bytes: 11, sha256: 'js' },
			{ path: 'wamr-debug.wasm', bytes: 22, sha256: 'wasm' },
			{ path: PACKAGED_PTHREAD_WORKER, bytes: 33, sha256: 'worker' },
			{
				path: 'wamr-debug.wasm.gz',
				bytes: 12,
				sha256: 'gzip',
				uncompressedBytes: 22,
				uncompressedSha256: 'wasm'
			}
		]
	};

	assert.doesNotThrow(() =>
		assertReproducibleWamrBuilds(receipt, structuredClone(receipt))
	);
	const changedProvenance = structuredClone(receipt);
	changedProvenance.provenance.patchesSha256 = 'changed';
	assert.throws(
		() => assertReproducibleWamrBuilds(receipt, changedProvenance),
		/WAMR browser build receipt provenance differs/u
	);
	const changedAsset = structuredClone(receipt);
	changedAsset.assets[1].sha256 = 'changed';
	assert.throws(
		() => assertReproducibleWamrBuilds(receipt, changedAsset),
		/wamr-debug\.wasm metadata differs/u
	);
	const replacedAssetSet = structuredClone(receipt);
	replacedAssetSet.assets[1] = {
		path: 'unexpected-runtime.bin',
		bytes: 22,
		sha256: 'wasm'
	};
	assert.throws(
		() =>
			assertReproducibleWamrBuilds(
				replacedAssetSet,
				structuredClone(replacedAssetSet)
			),
		/WAMR browser build asset set differs/u
	);
});

test('clean WAMR build comparison requires two artifact directories', async () => {
	await assert.rejects(
		() =>
			verifyReproducibleWamrArtifactDirectories(
				'/tmp/wasm-wamr-same-build',
				'/tmp/wasm-wamr-same-build'
			),
		/requires two directories/u
	);
});

test('documents separated output and the pinned host-platform caveat', async () => {
	const readme = await readFile(path.join(producerRoot, 'README.md'), 'utf8');
	assert.match(readme, /stdout\/stderr remain separate from the RSP byte stream/u);
	assert.match(readme, /cross-origin isolated/u);
	assert.match(readme, /--emsdk \/path\/to\/emsdk/u);
	assert.match(readme, /Linux\/POSIX product-mini/u);
	assert.match(readme, /temporary Git index/u);
	assert.match(readme, /idempotent/u);
	assert.match(readme, /wasm32-wasi/u);
	assert.match(readme, /i32 and void/u);
	assert.match(readme, /i64 or\s+floating-point native returns/u);
	assert.match(readme, /native WAMR builds retain the upstream `void` dispatcher/u);
	assert.match(readme, /clock_time_get/u);
	assert.match(readme, /path_filestat_set_times/u);
	assert.match(readme, /flattened argc/u);
	assert.match(readme, /byte=w/u);
	assert.match(readme, /123 bytes/u);
	assert.match(readme, /RSP `\$W00`/u);
	assert.match(readme, /provenance.*sources\.lock\.json.*patch.*overlay/su);
});
