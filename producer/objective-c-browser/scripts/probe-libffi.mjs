#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WASI } from 'node:wasi';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PRODUCER_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(PRODUCER_ROOT, '..', '..');
const PRODUCER_MANIFEST = JSON.parse(
	await readFile(path.join(PRODUCER_ROOT, 'manifest.json'), 'utf8')
);
const FOUNDATION_CACHE_ROOT = process.env.WASM_LLVM_OBJECTIVE_C_FOUNDATION_CACHE_DIR ||
	path.join(os.tmpdir(), 'wasm-llvm-objective-c-foundation');
const LIBFFI_DIR = path.join(FOUNDATION_CACHE_ROOT, 'libffi');
const BUILD_DIR = path.join(FOUNDATION_CACHE_ROOT, 'libffi-probe');
const SOURCE_DIR = path.join(BUILD_DIR, 'source');
const OBJECT_DIR = path.join(BUILD_DIR, 'objects');
const WASI_SDK_PATH = process.env.WASI_SDK_PATH
	? path.resolve(process.env.WASI_SDK_PATH)
	: null;
const CLANG = process.env.WASM_LLVM_CLANG ||
	(WASI_SDK_PATH ? path.join(WASI_SDK_PATH, 'bin', 'clang') : null);
const SYSROOT = process.env.WASM_LLVM_WASI_SYSROOT ||
	(WASI_SDK_PATH ? path.join(WASI_SDK_PATH, 'share', 'wasi-sysroot') : null);

const LIBFFI_URL = PRODUCER_MANIFEST.sources.libffi.repository;
const LIBFFI_REF = PRODUCER_MANIFEST.sources.libffi.ref;
const LIBFFI_COMMIT = PRODUCER_MANIFEST.sources.libffi.commit;
const strictWasmBackend = process.argv.includes('--strict-wasm-backend');

const libffiSources = ['src/prep_cif.c', 'src/types.c'];
const wasmBackendSource = 'src/wasm/ffi.c';
const libffiRuntimeProbeSource = `#include <ffi.h>
#include <stdio.h>

static int add_ints(int left, int right)
{
  return left + right;
}

int main(void)
{
  ffi_cif cif;
  ffi_type *args[2] = { &ffi_type_sint32, &ffi_type_sint32 };
  int left = 7;
  int right = 35;
  int result = -1;
  void *values[2] = { &left, &right };

  if (ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 2, &ffi_type_sint32, args) != FFI_OK) {
    puts("ffi_prep_cif failed");
    return 1;
  }

  ffi_call(&cif, (void (*)(void))add_ints, &result, values);
  printf("ffi=%d\\n", result);
  return result == 42 ? 0 : 2;
}
`;

function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd || REPO_ROOT,
			stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
			env: process.env
		});
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on('data', (chunk) => {
			stderr += chunk;
		});
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) resolve({ stdout, stderr });
			else reject(new Error(`${command} ${args.join(' ')} failed\n${stderr}`));
		});
	});
}

async function exists(filePath) {
	return !!(await stat(filePath).catch(() => null));
}

async function ensureGitCheckout(directory, url, ref, expectedCommit) {
	if (!(await exists(path.join(directory, '.git')))) {
		await mkdir(path.dirname(directory), { recursive: true });
		await rm(directory, { recursive: true, force: true });
		await run('git', ['clone', url, directory]);
	}
	await run('git', ['fetch', '--tags', '--quiet'], { cwd: directory });
	await run('git', ['checkout', '--quiet', expectedCommit || ref], { cwd: directory });
	const actualCommit = await gitOutput(directory, ['rev-parse', 'HEAD']);
	if (expectedCommit && actualCommit !== expectedCommit) {
		throw new Error(`${url} ${ref} resolved to ${actualCommit}, expected ${expectedCommit}`);
	}
}

async function gitOutput(directory, args) {
	const { stdout } = await run('git', args, { cwd: directory, capture: true });
	return stdout.trim();
}

function generateFfiHeader(source) {
	return source
		.replaceAll('@VERSION@', '3.6.0')
		.replaceAll('@TARGET@', 'WASM')
		.replaceAll('@HAVE_LONG_DOUBLE@', '0')
		.replaceAll('@FFI_VERSION_STRING@', '3.6.0')
		.replaceAll('@FFI_VERSION_NUMBER@', '30600')
		.replaceAll('@FFI_EXEC_TRAMPOLINE_TABLE@', '0');
}

async function readLibffiHeaders() {
	return {
		ffi: generateFfiHeader(
			await readFile(path.join(LIBFFI_DIR, 'include', 'ffi.h.in'), 'utf8')
		),
		ffitarget: await readFile(path.join(LIBFFI_DIR, 'src', 'wasm', 'ffitarget.h'), 'utf8'),
		ffiCommon: await readFile(path.join(LIBFFI_DIR, 'include', 'ffi_common.h'), 'utf8'),
		ffiConfig: `#pragma once
#define HAVE_ALLOCA_H 1
#define HAVE_MEMCPY 1
#define HAVE_LONG_DOUBLE_VARIANT 0
#define HAVE_INT128 1
#define STDC_HEADERS 1
#define FFI_HIDDEN __attribute__((visibility("hidden")))
`
	};
}

async function writeSourceFile(filePath, contents) {
	const targetPath = path.join(SOURCE_DIR, filePath);
	await mkdir(path.dirname(targetPath), { recursive: true });
	await writeFile(targetPath, contents);
	return targetPath;
}

function objectPathFor(sourcePath) {
	return `${sourcePath.replace(/[^A-Za-z0-9]+/g, '_')}.o`;
}

function compileArgsFor(sourcePath, objectPath, options = {}) {
	return [
		'--target=wasm32-wasip1',
		`--sysroot=${SYSROOT}`,
		'-c',
		'-I',
		SOURCE_DIR,
		'-I',
		path.join(SOURCE_DIR, 'include'),
		'-I',
		path.join(SOURCE_DIR, 'src'),
		'-I',
		path.join(SOURCE_DIR, 'src', 'wasm'),
		'-ferror-limit=20',
		'-O0',
		'-D__wasm__=1',
		'-D__wasm32__=1',
		'-D_WASI_EMULATED_MMAN=1',
		'-DFFI_BUILDING=1',
		'-DFFI_STATIC_BUILD=1',
		...(options.emscriptenImportStubs ? ['-D__EMSCRIPTEN__=1'] : []),
		'-o',
		objectPath,
		'-x',
		'c',
		sourcePath
	];
}

async function installLibffiProbeHeaders(headers, options = {}) {
	await writeSourceFile('ffi.h', headers.ffi);
	await writeSourceFile('include/ffi.h', headers.ffi);
	await writeSourceFile('ffitarget.h', headers.ffitarget);
	await writeSourceFile('include/ffitarget.h', headers.ffitarget);
	await writeSourceFile('ffi_common.h', headers.ffiCommon);
	await writeSourceFile('include/ffi_common.h', headers.ffiCommon);
	await writeSourceFile('fficonfig.h', headers.ffiConfig);
	await writeSourceFile('include/fficonfig.h', headers.ffiConfig);
	if (options.emscriptenImportStubs) {
		await writeSourceFile(
			'emscripten/emscripten.h',
			`#pragma once
#define EM_JS(ret, name, args, ...) ret name args;
#define EM_JS_DEPS(tag, deps)
`
		);
	}
}

async function compileProvidedObject(sourcePath, source, headers, options = {}) {
	await installLibffiProbeHeaders(headers, options);
	const stagedSourcePath = await writeSourceFile(sourcePath, source);
	const objectPath = path.join(OBJECT_DIR, objectPathFor(sourcePath));
	const result = await run(CLANG, compileArgsFor(stagedSourcePath, objectPath, options), {
		cwd: SOURCE_DIR,
		capture: true
	});
	const objectBytes = await readFile(objectPath);
	if (!objectBytes.length) throw new Error(`${sourcePath} did not produce an object file`);
	return {
		bytes: objectBytes.length,
		objectBytes,
		objectPath,
		output: `${result.stdout}${result.stderr}`,
		recovered: false
	};
}

async function compileObject(sourcePath, headers, options = {}) {
	return compileProvidedObject(
		sourcePath,
		await readFile(path.join(LIBFFI_DIR, sourcePath), 'utf8'),
		headers,
		options
	);
}

async function linkRuntimeProbe(objects) {
	const wasmPath = path.join(BUILD_DIR, 'libffi-call-probe.wasm');
	await run(CLANG, [
		'--target=wasm32-wasip1',
		`--sysroot=${SYSROOT}`,
		...objects.map((object) => object.objectPath),
		'-lwasi-emulated-mman',
		'-Wl,--export-dynamic',
		'-Wl,--export-table',
		'-Wl,--allow-undefined',
		'-Wl,-z,stack-size=1048576',
		'-o',
		wasmPath
	]);
	const bytes = await readFile(wasmPath);
	if (!bytes.length) throw new Error('libffi runtime probe link produced an empty wasm artifact');
	return {
		bytes,
		wasm: await WebAssembly.compile(bytes),
		target: 'wasm32-wasi',
		format: 'wasi-core-wasm',
		fileName: path.basename(wasmPath)
	};
}

function createLibffiRuntimeProbeImports(instanceRef) {
	const dataView = () => {
		const memory = instanceRef.current?.exports.memory;
		if (!(memory instanceof WebAssembly.Memory)) {
			throw new Error('libffi probe missing exported memory');
		}
		return new DataView(memory.buffer);
	};
	const functionTable = () => {
		const table = instanceRef.current?.exports.__indirect_function_table;
		if (!(table instanceof WebAssembly.Table)) {
			throw new Error('libffi probe missing exported __indirect_function_table');
		}
		return table;
	};
	const readU32 = (view, pointer) => view.getUint32(pointer, true);
	const readI32 = (view, pointer) => view.getInt32(pointer, true);

	return {
		env: {
			ffi_call_js: (_cif, fn, rvalue, avalue) => {
				const view = dataView();
				const leftPointer = readU32(view, avalue);
				const rightPointer = readU32(view, avalue + 4);
				const left = readI32(view, leftPointer);
				const right = readI32(view, rightPointer);
				const callable = functionTable().get(fn);
				if (typeof callable !== 'function') {
					throw new Error(`libffi probe missing function table entry ${fn}`);
				}
				const result = callable(left, right);
				view.setInt32(rvalue, result, true);
			},
			ffi_closure_alloc_js: () => 0,
			ffi_closure_free_js: () => {},
			ffi_prep_closure_loc_js: () => 1
		}
	};
}

async function runLibffiRuntimeProbe(headers) {
	const sources = [
		...libffiSources.map((sourcePath) => ({
			sourcePath,
			source: readFile(path.join(LIBFFI_DIR, sourcePath), 'utf8')
		})),
		{
			sourcePath: wasmBackendSource,
			source: readFile(path.join(LIBFFI_DIR, wasmBackendSource), 'utf8')
		},
		{
			sourcePath: 'ffi_call_probe.c',
			source: Promise.resolve(libffiRuntimeProbeSource)
		}
	];
	const objects = [];
	for (const source of sources) {
		objects.push(
			await compileProvidedObject(source.sourcePath, await source.source, headers, {
				emscriptenImportStubs: true
			})
		);
	}
	const artifact = await linkRuntimeProbe(objects);
	const wasi = new WASI({
		version: 'preview1',
		args: [artifact.fileName],
		env: {},
		preopens: {},
		returnOnExit: true
	});
	const instanceRef = { current: null };
	const imports = createLibffiRuntimeProbeImports(instanceRef);
	imports.wasi_snapshot_preview1 = wasi.wasiImport;
	const instance = await WebAssembly.instantiate(artifact.wasm, imports);
	instanceRef.current = instance;
	const exitCode = wasi.start(instance);
	const result = { exitCode: typeof exitCode === 'number' ? exitCode : 0 };
	if (result.exitCode !== 0) {
		throw new Error(`libffi runtime probe exited with ${result.exitCode}`);
	}
	return result;
}

async function main() {
	if (!CLANG || !SYSROOT) {
		throw new Error(
			'Set WASI_SDK_PATH, or set both WASM_LLVM_CLANG and WASM_LLVM_WASI_SYSROOT'
		);
	}
	if (!(await exists(CLANG))) throw new Error(`WASI Clang was not found: ${CLANG}`);
	if (!(await exists(SYSROOT))) throw new Error(`WASI sysroot was not found: ${SYSROOT}`);
	await rm(BUILD_DIR, { recursive: true, force: true });
	await mkdir(SOURCE_DIR, { recursive: true });
	await mkdir(OBJECT_DIR, { recursive: true });
	await ensureGitCheckout(LIBFFI_DIR, LIBFFI_URL, LIBFFI_REF, LIBFFI_COMMIT);
	const commit = await gitOutput(LIBFFI_DIR, ['rev-parse', 'HEAD']);
	const headers = await readLibffiHeaders();
	console.log(`[libffi-probe] libffi ${LIBFFI_REF} ${commit}`);

	for (const sourcePath of libffiSources) {
		const result = await compileObject(sourcePath, headers);
		console.log(
			`[libffi-probe] ${sourcePath} object bytes: ${result.bytes}` +
				`${result.recovered ? ' (recovered after clang output stream exit)' : ''}`
		);
	}

	const wasmBackend = await compileObject(wasmBackendSource, headers, {
		emscriptenImportStubs: true
	});
	console.log(
		`[libffi-probe] ${wasmBackendSource} object bytes with upstream EM_JS imports: ${wasmBackend.bytes}`
	);

	const runtimeProbe = await runLibffiRuntimeProbe(headers);
	console.log(`[libffi-probe] ffi_call import bridge exited with ${runtimeProbe.exitCode}`);
	if (strictWasmBackend && runtimeProbe.exitCode !== 0) {
		throw new Error(`strict libffi Wasm backend probe exited with ${runtimeProbe.exitCode}`);
	}
}

main().catch((error) => {
	console.error('\n[libffi-probe] failed:');
	console.error(error?.stack || error?.message || error);
	process.exitCode = 1;
});
