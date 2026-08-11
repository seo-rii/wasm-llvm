#!/usr/bin/env node

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
	isMain,
	parseArguments,
	producerRoot,
	readSourceLock,
	run,
	verifyGitRevision
} from './shared.mjs';

export const WAMR_CMAKE_OPTIONS = [
	'-DCMAKE_BUILD_TYPE=Release',
	'-DCMAKE_EXECUTABLE_SUFFIX=.js',
	'-DWAMR_BUILD_PLATFORM=linux',
	'-DWAMR_BUILD_TARGET=X86_32',
	'-DWAMR_BUILD_INVOKE_NATIVE_GENERAL=1',
	'-DWAMR_BUILD_INTERP=1',
	'-DWAMR_BUILD_FAST_INTERP=0',
	'-DWAMR_BUILD_AOT=0',
	'-DWAMR_BUILD_JIT=0',
	'-DWAMR_BUILD_FAST_JIT=0',
	'-DWAMR_BUILD_LIBC_WASI=1',
	'-DWAMR_BUILD_LIBC_BUILTIN=0',
	'-DWAMR_BUILD_DEBUG_INTERP=1',
	'-DWAMR_BUILD_THREAD_MGR=1',
	'-DWAMR_BUILD_LIB_PTHREAD=0',
	'-DWAMR_BUILD_ALLOC_WITH_USAGE=1',
	'-DWAMR_BUILD_MULTI_MODULE=0',
	'-DWAMR_BUILD_SIMD=0',
	'-DWAMR_DISABLE_HW_BOUND_CHECK=1',
	'-DWAMR_BUILD_MEMORY64=0',
	'-DWAMR_BUILD_SHARED_MEMORY=0',
	'-DCMAKE_C_FLAGS=-pthread -include wasm_debug_emscripten_compat.h -DWASM_DEBUG_BROWSER_TRANSPORT=1'
];

export const EMSCRIPTEN_LINK_OPTIONS = [
	'-pthread',
	'-sPTHREAD_POOL_SIZE=2',
	'-sPTHREAD_POOL_SIZE_STRICT=2',
	'-sMODULARIZE=1',
	'-sEXPORT_ES6=1',
	'-sEXPORT_NAME=createWamrDebugModule',
	'-sENVIRONMENT=worker',
	'-sFORCE_FILESYSTEM=1',
	'-sALLOW_MEMORY_GROWTH=1',
	'-sINITIAL_MEMORY=67108864',
	'-sMAXIMUM_MEMORY=2147483648',
	'-sEMULATE_FUNCTION_POINTER_CASTS=1',
	'-sBINARYEN_EXTRA_PASSES=--pass-arg=max-func-params@21',
	'-sEXIT_RUNTIME=1',
	"-sEXPORTED_RUNTIME_METHODS=['FS','callMain','HEAPU8']",
	"-sINCOMING_MODULE_JS_API=['noInitialRun','locateFile','stdin','stdout','stderr','onExit','onAbort','mainScriptUrlOrBlob']"
];

// WAMR's portable invokeNative_general dispatcher deliberately calls one
// function pointer through signatures containing zero through twenty i32
// arguments. WebAssembly requires exact call_indirect signatures, so the
// Emscripten cast emulation pass is mandatory. Binaryen defaults that pass to
// sixteen parameters; raise its bound to cover WAMR's largest dispatcher arm.

// With MODULARIZE + EXPORT_ES6, Emscripten 6.0.0 uses the generated main ES
// module itself as the pthread entry. We retain a dedicated, hashable copy for
// that role and point mainScriptUrlOrBlob at it at runtime. WAMR's versioned
// executable properties make the real loader and Wasm filenames different
// from the unversioned iwasm.js symlink.
export const GENERATED_LOADER = 'iwasm.js';
export const GENERATED_PTHREAD_WORKER = 'iwasm.js-2.4.5';
export const GENERATED_WASM = 'iwasm.js-2.4.wasm';
export const PACKAGED_PTHREAD_WORKER = 'wamr-debug.worker.mjs';

export async function buildWamrBrowser({ source, build, emsdk }) {
	if (!source) throw new Error('--source is required');
	if (!build) throw new Error('--build is required');
	if (!emsdk) throw new Error('--emsdk is required');
	source = path.resolve(source);
	build = path.resolve(build);
	emsdk = path.resolve(emsdk);
	const lock = await readSourceLock();
	await verifyGitRevision(source, lock.wamr.commit, 'WAMR');
	await verifyGitRevision(emsdk, lock.emscripten.commit, 'emsdk');
	const toolchainEnv = {
		...process.env,
		EM_CONFIG: path.join(emsdk, '.emscripten'),
		EM_CACHE: path.join(build, 'emscripten-cache')
	};
	const emscriptenRoot = path.join(emsdk, 'upstream', 'emscripten');
	const emccVersion = await run(path.join(emscriptenRoot, 'emcc'), ['--version'], {
		cwd: emsdk,
		capture: true,
		env: toolchainEnv
	});
	const escapedVersion = lock.emscripten.version.replaceAll('.', '\\.');
	if (!new RegExp(`(^|\\s)${escapedVersion}(?:\\s|$)`, 'u').test(emccVersion)) {
		throw new Error(`Emscripten version mismatch: expected ${lock.emscripten.version}`);
	}
	await mkdir(build, { recursive: true });
	const jsLibrary = path.join(producerRoot, 'src', 'wasm-debug-transport.js');
	const linkOptions = [...EMSCRIPTEN_LINK_OPTIONS, `--js-library=${jsLibrary}`].join(' ');
	await run(
		path.join(emscriptenRoot, 'emcmake'),
		[
			'cmake',
			'-S',
			path.join(source, 'product-mini', 'platforms', 'linux'),
			'-B',
			build,
			...WAMR_CMAKE_OPTIONS,
			`-DCMAKE_EXE_LINKER_FLAGS=${linkOptions}`
		],
		{
			cwd: source,
			env: toolchainEnv
		}
	);
	await run('cmake', ['--build', build, '--parallel'], {
		cwd: source,
		env: toolchainEnv
	});

	const output = path.join(build, 'wasm-idle-output');
	await mkdir(output, { recursive: true });
	const generatedLoader = await readFile(path.join(build, GENERATED_LOADER), 'utf8');
	const singleQuotedWorker = `'${GENERATED_PTHREAD_WORKER}'`;
	const doubleQuotedWorker = `"${GENERATED_PTHREAD_WORKER}"`;
	if (
		!generatedLoader.includes(singleQuotedWorker) &&
		!generatedLoader.includes(doubleQuotedWorker)
	) {
		throw new Error(
			`Emscripten loader does not reference its expected ${GENERATED_PTHREAD_WORKER} pthread entry`
		);
	}
	await writeFile(
		path.join(output, 'wamr-debug.js'),
		generatedLoader
			.replaceAll(singleQuotedWorker, `'${PACKAGED_PTHREAD_WORKER}'`)
			.replaceAll(doubleQuotedWorker, `"${PACKAGED_PTHREAD_WORKER}"`)
	);
	await copyFile(path.join(build, GENERATED_WASM), path.join(output, 'wamr-debug.wasm'));
	await writeFile(path.join(output, PACKAGED_PTHREAD_WORKER), generatedLoader);
	console.log(`Built WAMR browser debugger in ${output}`);
}

if (isMain(import.meta.url)) {
	await buildWamrBrowser(parseArguments(process.argv.slice(2)));
}
