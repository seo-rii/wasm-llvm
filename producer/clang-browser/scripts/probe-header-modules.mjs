#!/usr/bin/env node

// Experiment: compares textual includes, a precompiled <bits/stdc++.h>, and implicit libc++ header
// modules when the WASI clang module compiles typical single-file programs in Node's V8. The
// shipped sysroot is dependency-pruned, so the probe overlays the complete libc++ and WASI libc
// headers, including libc++'s module.modulemap, from the pinned WASI SDK sysroot archive.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WASI } from 'node:wasi';
import { gzipSync } from 'node:zlib';

const RESOURCE_DIR = '/lib/clang/22';
const PCH_PATH = '/work/stdc++.pch';
const MODULE_CACHE = '/work/module-cache';

/**
 * libc++'s module map lists every header in one `std` module, so each must build on WASI:
 * - wasi-libc does not declare the const-correct wcschr/wcsstr overloads that glibc provides, so
 *   libc++'s textual <wchar.h> defines them in more than one submodule. This macro selects the
 *   C signatures instead, as on platforms that already declare the overloads.
 * - <csignal> and the POSIX clock/mman/getpid declarations are gated behind emulation macros.
 */
export const MODULE_COMPAT_DEFINES = [
	'-D_WCHAR_H_CPLUSPLUS_98_CONFORMANCE_',
	'-D_WASI_EMULATED_SIGNAL',
	'-D_WASI_EMULATED_PROCESS_CLOCKS',
	'-D_WASI_EMULATED_MMAN',
	'-D_WASI_EMULATED_GETPID'
];
export const MODULE_FLAGS = [
	'-fmodules',
	'-fimplicit-module-maps',
	`-fmodules-cache-path=${MODULE_CACHE}`,
	...MODULE_COMPAT_DEFINES
];

const PROGRAMS = {
	'stdcpp.cpp': {
		source: `#include <bits/stdc++.h>
using namespace std;
int main() {
	vector<long long> v;
	for (int i = 0; i < 1000; i++) v.push_back((i * 7919LL) % 1009);
	sort(v.begin(), v.end());
	map<long long, int> freq;
	for (auto x : v) freq[x]++;
	priority_queue<long long> pq(v.begin(), v.end());
	cout << freq.size() << ' ' << pq.top() << ' ' << accumulate(v.begin(), v.end(), 0LL) << '\\n';
}
`,
		output: '1000 1008 504678\n'
	},
	'selected.cpp': {
		source: `#include <algorithm>
#include <iostream>
#include <map>
#include <string>
#include <vector>
int main() {
	std::vector<std::string> words{"pear", "apple", "fig", "apple"};
	std::sort(words.begin(), words.end());
	std::map<std::string, int> counts;
	for (const auto &word : words) counts[word]++;
	std::cout << counts.size() << ' ' << words.front() << ' ' << counts["apple"] << '\\n';
}
`,
		output: '3 apple 2\n'
	}
};

function usage() {
	return `Usage: node probe-header-modules.mjs --compiler <dir> --sysroot <sysroot.tar.zip|dir> \\
  --wasi-sysroot <wasi-sysroot-33.0+m.tar.gz> [--runs 3] [--json out.json]

<dir> contains raw clang and lld modules or clang.zip and lld.zip release archives.`;
}

export function parseArgs(argv) {
	const options = { runs: 3 };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const value = () => {
			const next = argv[++index];
			if (next === undefined) throw new Error(`${arg} requires a value`);
			return next;
		};
		if (arg === '--') continue;
		else if (arg === '--help' || arg === '-h') options.help = true;
		else if (arg === '--compiler') options.compiler = value();
		else if (arg === '--sysroot') options.sysroot = value();
		else if (arg === '--wasi-sysroot') options.wasiSysroot = value();
		else if (arg === '--runs') options.runs = Number(value());
		else if (arg === '--json') options.json = value();
		else throw new Error(`Unknown argument ${arg}`);
	}
	if (options.help) return options;
	if (!options.compiler || !options.sysroot || !options.wasiSysroot) {
		throw new Error('--compiler, --sysroot and --wasi-sysroot are required');
	}
	if (!Number.isInteger(options.runs) || options.runs < 2) {
		throw new Error('--runs must be an integer of at least 2');
	}
	return options;
}

/** cc1 arguments matching the browser host, with the mode-specific flags appended. */
export function compileArgs(source, output, extra = []) {
	return [
		'clang',
		'-cc1',
		'-triple',
		'wasm32-wasi',
		'-emit-obj',
		'-disable-free',
		'-isysroot',
		'/',
		'-resource-dir',
		RESOURCE_DIR,
		...[
			'/include/c++/v1',
			`${RESOURCE_DIR}/include`,
			'/include/wasm32-wasi',
			'/include'
		].flatMap((dir) => ['-internal-isystem', dir]),
		'-ferror-limit',
		'19',
		'-O2',
		'-std=gnu++20',
		'-x',
		'c++',
		...extra,
		'-o',
		output,
		source
	];
}

function run(command, args, input) {
	const result = spawnSync(command, args, { input, maxBuffer: 1 << 30 });
	if (result.status !== 0)
		throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`);
	return result.stdout;
}

async function readModule(dir, name) {
	const raw = path.join(dir, name);
	const bytes = (await fs.stat(raw).catch(() => null))
		? await fs.readFile(raw)
		: run('unzip', ['-p', path.join(dir, `${name}.zip`)]);
	return WebAssembly.compile(bytes);
}

async function runWasi(module, args, preopens, stdout) {
	const wasi = new WASI({
		version: 'preview1',
		args,
		env: {},
		preopens,
		returnOnExit: true,
		...(stdout ? { stdout: stdout.fd } : {})
	});
	const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
	const start = performance.now();
	const code = wasi.start(instance);
	return { code, ms: performance.now() - start };
}

/** Shipped sysroot plus complete noeh libc++ and WASI libc headers from the SDK archive. */
async function prepareSysroot(options, scratch) {
	const root = path.join(scratch, 'root');
	await fs.mkdir(root, { recursive: true });
	if ((await fs.stat(options.sysroot)).isDirectory()) {
		await fs.cp(options.sysroot, root, { recursive: true });
	} else {
		run('tar', ['-x', '-C', root], run('unzip', ['-p', options.sysroot]));
	}
	const sdk = path.join(scratch, 'wasi-sysroot');
	await fs.mkdir(sdk, { recursive: true });
	run('tar', ['-xzf', options.wasiSysroot, '-C', sdk, '--strip-components=1']);
	const sdkTarget = path.join(sdk, 'include', 'wasm32-wasi');
	await fs.rm(path.join(root, 'include', 'c++'), { recursive: true, force: true });
	await fs.mkdir(path.join(root, 'include', 'c++'), { recursive: true });
	await fs.cp(
		path.join(sdkTarget, 'noeh', 'c++', 'v1'),
		path.join(root, 'include', 'c++', 'v1'),
		{
			recursive: true
		}
	);
	for (const entry of await fs.readdir(sdkTarget)) {
		if (['c++', 'eh', 'noeh'].includes(entry)) continue;
		await fs.cp(path.join(sdkTarget, entry), path.join(root, 'include', 'wasm32-wasi', entry), {
			recursive: true,
			force: true
		});
	}
	return root;
}

async function directoryBytes(dir) {
	let total = 0;
	for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
		if (entry.isFile()) total += (await fs.stat(path.join(entry.parentPath, entry.name))).size;
	}
	return total;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(usage());
		return;
	}
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'clang-header-modules-'));
	try {
		const root = await prepareSysroot(options, scratch);
		const work = path.join(scratch, 'work');
		await fs.mkdir(work, { recursive: true });
		for (const [name, program] of Object.entries(PROGRAMS)) {
			await fs.writeFile(path.join(work, name), program.source);
		}
		const clang = await readModule(options.compiler, 'clang');
		const lld = await readModule(options.compiler, 'lld');
		const preopens = { '/': root, '/work': work };
		const compile = async (extra, source, output) => {
			const result = await runWasi(
				clang,
				compileArgs(`/work/${source}`, output, extra),
				preopens
			);
			if (result.code !== 0)
				throw new Error(`clang exited with ${result.code} for ${source}`);
			return result.ms;
		};

		const pchStart = performance.now();
		const pchArgs = compileArgs('/include/bits/stdc++.h', PCH_PATH);
		pchArgs[pchArgs.indexOf('-emit-obj')] = '-emit-pch';
		pchArgs[pchArgs.indexOf('c++')] = 'c++-header';
		const pch = await runWasi(clang, pchArgs, preopens);
		if (pch.code !== 0) throw new Error(`PCH build exited with ${pch.code}`);
		const pchBuildMs = performance.now() - pchStart;

		const modes = {
			textual: () => [],
			pch: (source) => (source === 'stdcpp.cpp' ? ['-include-pch', PCH_PATH] : null),
			modules: () => MODULE_FLAGS
		};
		const report = { runs: options.runs, node: process.version, programs: {} };
		for (const source of Object.keys(PROGRAMS)) {
			const results = {};
			for (const [mode, flags] of Object.entries(modes)) {
				const extra = flags(source);
				if (!extra) continue;
				if (mode === 'modules') {
					await fs.rm(path.join(work, 'module-cache'), { recursive: true, force: true });
				}
				const times = [];
				for (let index = 0; index < options.runs; index++) {
					times.push(await compile(extra, source, `/work/${source}.${mode}.o`));
				}
				const warm = times.slice(1).sort((a, b) => a - b);
				results[mode] = {
					firstMs: Math.round(times[0]),
					warmMedianMs: Math.round(warm[Math.floor(warm.length / 2)])
				};

				const program = path.join(work, `${source}.${mode}.wasm`);
				const linked = await runWasi(
					lld,
					[
						'wasm-ld',
						'-L/lib/wasm32-wasi/noeh',
						'-L/lib/wasm32-wasi',
						'/lib/wasm32-wasi/crt1.o',
						`/work/${source}.${mode}.o`,
						'-lc',
						'-lc++',
						'-lc++abi',
						'-lm',
						`-L${RESOURCE_DIR}/lib/wasi`,
						'-lclang_rt.builtins-wasm32',
						'-o',
						`/work/${path.basename(program)}`
					],
					preopens
				);
				if (linked.code !== 0) throw new Error(`wasm-ld exited with ${linked.code}`);
				const stdoutPath = `${program}.out`;
				const stdout = await fs.open(stdoutPath, 'w');
				await runWasi(
					await WebAssembly.compile(await fs.readFile(program)),
					['program'],
					{},
					stdout
				);
				await stdout.close();
				results[mode].output = await fs.readFile(stdoutPath, 'utf8');
				results[mode].outputMatches = results[mode].output === PROGRAMS[source].output;
			}
			report.programs[source] = results;
		}

		const pchBytes = await fs.readFile(path.join(work, 'stdc++.pch'));
		const cacheDir = path.join(work, 'module-cache');
		const pcms = [];
		for (const entry of await fs.readdir(cacheDir, { withFileTypes: true, recursive: true })) {
			if (!entry.name.endsWith('.pcm')) continue;
			const bytes = await fs.readFile(path.join(entry.parentPath, entry.name));
			pcms.push({
				name: entry.name,
				raw: bytes.length,
				gzip: gzipSync(bytes, { level: 9 }).length
			});
		}
		pcms.sort((a, b) => b.raw - a.raw);
		report.pch = {
			buildMs: Math.round(pchBuildMs),
			raw: pchBytes.length,
			gzip: gzipSync(pchBytes, { level: 9 }).length
		};
		report.moduleCache = {
			files: pcms.length,
			rawBytes: await directoryBytes(cacheDir),
			gzipBytes: pcms.reduce((sum, pcm) => sum + pcm.gzip, 0),
			largest: pcms.slice(0, 3)
		};
		report.libcxxHeaderBytes = await directoryBytes(path.join(root, 'include', 'c++', 'v1'));

		console.log(`First run and warm median of ${options.runs - 1} runs (ms):`);
		console.table(
			Object.fromEntries(
				Object.entries(report.programs).flatMap(([source, results]) =>
					Object.entries(results).map(([mode, result]) => [
						`${source} ${mode}`,
						{
							first: result.firstMs,
							warm: result.warmMedianMs,
							output: result.outputMatches ? 'ok' : JSON.stringify(result.output)
						}
					])
				)
			)
		);
		console.log(JSON.stringify({ pch: report.pch, moduleCache: report.moduleCache }, null, 2));
		if (options.json) await fs.writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`);
		const mismatched = Object.values(report.programs).some((results) =>
			Object.values(results).some((result) => !result.outputMatches)
		);
		if (mismatched) process.exitCode = 1;
	} finally {
		await fs.rm(scratch, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
