#!/usr/bin/env node
// Acceptance for the V browser producer. It runs the packaged V compiler (WASI) inside the
// packaged V root, compiles the generated C against the packaged C sysroot with the pinned
// wasi-sdk, links with the consumer's flags, and executes the program with real stdin.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WASI } from 'node:wasi';
import { readSingleEntry } from './verify-artifacts.mjs';

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const producerRoot = path.resolve(scriptDir, '..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const V_COMPILER_ENV = Object.freeze({
	VEXE: '/v/v',
	VMODULES: '/tmp/vmodules',
	VTMP: '/tmp',
	TMPDIR: '/tmp',
	HOME: '/tmp'
});
export const V_TRANSLATE_ARGS = Object.freeze(['-os', 'wasm32_wasi', '-gc', 'none', '-no-parallel']);
export const V_C_FLAGS = Object.freeze([
	'-I',
	'include/v-wasi',
	'-include',
	'v_wasi_compat.h',
	'-D_WASI_EMULATED_MMAN',
	'-D_WASI_EMULATED_SIGNAL',
	'-D_WASI_EMULATED_PROCESS_CLOCKS',
	'-D_WASI_EMULATED_GETPID',
	'-fwrapv',
	'-fno-strict-aliasing',
	'-Wno-everything'
]);
// V's builtin memory helpers treat addresses at or below 0xFFFF as invalid, so data and stack must
// start above the first 64 KiB of linear memory.
export const V_LINK_FLAGS = Object.freeze([
	'-z',
	'stack-size=1048576',
	'--no-stack-first',
	'--global-base=65536'
]);
export const V_LINK_LIBRARIES = Object.freeze([
	'-lvwasi',
	'-lwasi-emulated-mman',
	'-lwasi-emulated-signal',
	'-lwasi-emulated-process-clocks',
	'-lwasi-emulated-getpid',
	'-lc',
	'-lm'
]);

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument ${key}`);
		options[key.slice(2)] = value;
	}
	for (const key of ['work', 'wasi-sdk', 'artifacts', 'receipt']) {
		if (!options[key]) throw new Error(`--${key} is required`);
	}
	return options;
}

async function runWasi(module, { args, env = {}, preopens = {}, stdin = '', work, label }) {
	const stdinPath = path.join(work, `${label}.stdin`);
	const stdoutPath = path.join(work, `${label}.stdout`);
	const stderrPath = path.join(work, `${label}.stderr`);
	writeFileSync(stdinPath, stdin);
	const fds = [openSync(stdinPath, 'r'), openSync(stdoutPath, 'w'), openSync(stderrPath, 'w')];
	let exitCode;
	try {
		const wasi = new WASI({
			version: 'preview1',
			args,
			env,
			preopens,
			returnOnExit: true,
			stdin: fds[0],
			stdout: fds[1],
			stderr: fds[2]
		});
		const imports = WebAssembly.Module.imports(module).filter(
			(entry) => entry.module !== 'wasi_snapshot_preview1'
		);
		assert.deepEqual(imports, [], `${label} imports only WASI Preview 1`);
		exitCode = wasi.start(await WebAssembly.instantiate(module, wasi.getImportObject()));
	} finally {
		for (const fd of fds) closeSync(fd);
	}
	return {
		exitCode,
		stdout: readFileSync(stdoutPath, 'utf8'),
		stderr: readFileSync(stderrPath, 'utf8')
	};
}

async function untar(bytes, directory) {
	await mkdir(directory, { recursive: true });
	const archive = `${directory}.tar`;
	await writeFile(archive, bytes);
	await execFileAsync('tar', ['-xf', archive, '-C', directory]);
	await rm(archive);
}

export async function smoke({ work, wasiSdk, artifacts }) {
	await rm(work, { recursive: true, force: true });
	await mkdir(work, { recursive: true });
	const compilerBytes = await readSingleEntry(artifacts, 'v.zip', 'v');
	const compiler = await WebAssembly.compile(compilerBytes);
	const root = path.join(work, 'root');
	const sysroot = path.join(work, 'c-sysroot');
	await untar(await readSingleEntry(artifacts, 'vroot.tar.zip', 'vroot.tar'), root);
	await untar(await readSingleEntry(artifacts, 'c-sysroot.tar.zip', 'c-sysroot.tar'), sysroot);
	await mkdir(path.join(root, 'work'), { recursive: true });
	await mkdir(path.join(root, 'tmp'), { recursive: true });

	const translate = async (fixture, label) => {
		await writeFile(
			path.join(root, 'work/main.v'),
			await readFile(path.join(producerRoot, 'fixtures', fixture))
		);
		await rm(path.join(root, 'work/main.c'), { force: true });
		return runWasi(compiler, {
			args: ['v', ...V_TRANSLATE_ARGS, '-o', '/work/main.c', '/work/main.v'],
			env: V_COMPILER_ENV,
			preopens: { '/': root },
			work,
			label
		});
	};

	const invalid = await translate('invalid.v', 'invalid');
	assert.equal(invalid.exitCode, 1, 'invalid source is rejected');
	assert.match(invalid.stderr + invalid.stdout, /\/work\/main\.v:3:1: error: invalid expression/);

	const translated = await translate('program.v', 'translate');
	assert.equal(translated.exitCode, 0, translated.stderr || translated.stdout);
	const generatedC = await readFile(path.join(root, 'work/main.c'));
	assert(generatedC.includes('main__main'), 'V emitted C for the program');

	const object = path.join(work, 'main.o');
	const program = path.join(work, 'main.wasm');
	const flags = V_C_FLAGS.map((flag) => (flag === 'include/v-wasi' ? path.join(sysroot, flag) : flag));
	await execFileAsync(path.join(wasiSdk, 'bin/clang'), [
		'--target=wasm32-wasi',
		`--sysroot=${sysroot}`,
		'-O1',
		...flags,
		'-c',
		path.join(root, 'work/main.c'),
		'-o',
		object
	]);
	await execFileAsync(path.join(wasiSdk, 'bin/wasm-ld'), [
		...V_LINK_FLAGS,
		`-L${path.join(sysroot, 'lib/wasm32-wasi')}`,
		path.join(sysroot, 'lib/wasm32-wasi/crt1.o'),
		object,
		...V_LINK_LIBRARIES,
		path.join(sysroot, 'lib/clang/22/lib/wasi/libclang_rt.builtins-wasm32.a'),
		'-o',
		program
	]);
	const programBytes = await readFile(program);
	const run = await runWasi(await WebAssembly.compile(programBytes), {
		args: ['main'],
		stdin: 'World\n안녕\n40 2\n',
		work,
		label: 'program'
	});
	const expected =
		'Hello, World!\nV stdin: 안녕\nsum=42 squares=[1, 4, 9, 16, 25] map={\'k\': 1.5}\neof=true\n';
	assert.equal(run.exitCode, 0, run.stderr);
	assert.equal(run.stdout, expected);

	const fixtures = {};
	for (const name of ['program.v', 'invalid.v']) {
		fixtures[`fixtures/${name}`] = sha256(await readFile(path.join(producerRoot, 'fixtures', name)));
	}
	const scripts = {};
	for (const name of ['smoke.mjs', 'verify-artifacts.mjs', 'build.sh']) {
		scripts[`scripts/${name}`] = sha256(await readFile(path.join(scriptDir, name)));
	}
	return {
		engine: `node ${process.version}`,
		compiler: { bytes: compilerBytes.length, sha256: sha256(compilerBytes) },
		fixtures,
		scripts,
		results: {
			rejectedInvalidSource: true,
			translatedSource: true,
			generatedC: { bytes: generatedC.length, sha256: sha256(generatedC) },
			program: { bytes: programBytes.length, sha256: sha256(programBytes) },
			stdinStdout: run.stdout === expected
		}
	};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const options = parseArgs(process.argv.slice(2));
	const receipt = await smoke({
		work: path.resolve(options.work),
		wasiSdk: path.resolve(options['wasi-sdk']),
		artifacts: path.resolve(options.artifacts)
	});
	await writeFile(path.resolve(options.receipt), `${JSON.stringify(receipt, null, 2)}\n`);
	console.log(`V producer acceptance passed (${receipt.results.program.bytes}-byte program).`);
}
