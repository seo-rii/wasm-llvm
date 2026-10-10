#!/usr/bin/env node

// Node measurements are reference data. Browser startup, streaming preparation, tiering,
// caching, and execution must be measured separately before promoting compiler artifacts.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WASI } from 'node:wasi';
import { gzipSync } from 'node:zlib';

const MODULES = ['clang', 'lld'];
const PROVENANCE_FILES = ['compiler-build.json', 'toolchain.json', 'benchmark-provenance.json'];
const RESOURCE_DIR = '/lib/clang/22';
const INCLUDE_ARGS = [
	'/include/c++/v1',
	'/include/wasm32-wasi/c++/v1',
	`${RESOURCE_DIR}/include`,
	'/include/wasm32-wasi',
	'/include'
].flatMap((dir) => ['-internal-isystem', dir]);

export const SOURCES = {
	'c.c': `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static int cmp(const void *a, const void *b) { return *(const int *)a - *(const int *)b; }
int main(void) {
	int v[64];
	for (int i = 0; i < 64; i++) v[i] = (i * 37) % 64;
	qsort(v, 64, sizeof v[0], cmp);
	char buf[32];
	snprintf(buf, sizeof buf, "%d %d", v[0], v[63]);
	printf("%s %zu\\n", buf, strlen(buf));
	return 0;
}
`,
	'stdcpp.cpp': `#include <bits/stdc++.h>
using namespace std;
int main() {
	vector<long long> v;
	for (int i = 0; i < 1000; i++) v.push_back((i * 7919LL) % 1009);
	sort(v.begin(), v.end());
	map<long long, int> freq;
	for (auto x : v) freq[x]++;
	set<long long> uniq(v.begin(), v.end());
	priority_queue<long long> pq(v.begin(), v.end());
	string s = to_string(accumulate(v.begin(), v.end(), 0LL));
	cout << freq.size() << ' ' << uniq.size() << ' ' << pq.top() << ' ' << s << '\\n';
}
`,
	'templates.cpp': `#include <algorithm>
#include <functional>
#include <map>
#include <numeric>
#include <optional>
#include <cstdio>
#include <format>
#include <sstream>
#include <string>
#include <tuple>
#include <unordered_map>
#include <variant>
#include <vector>
using Value = std::variant<int, double, std::string, std::vector<int>>;
template <class... F> struct overloaded : F... { using F::operator()...; };
template <class... F> overloaded(F...) -> overloaded<F...>;
int main() {
	std::vector<Value> values{1, 2.5, std::string("x"), std::vector<int>{1, 2, 3}};
	std::map<std::string, std::vector<std::tuple<int, double, std::string>>> table;
	std::unordered_map<std::string, std::function<int(int)>> ops{
		{"double", [](int x) { return x * 2; }}, {"square", [](int x) { return x * x; }}};
	std::ostringstream out;
	for (const auto &value : values)
		std::visit(overloaded{[&](int x) { out << ops["square"](x); },
		                      [&](double x) { out << x; },
		                      [&](const std::string &x) { out << x; },
		                      [&](const std::vector<int> &x) {
			                      out << std::accumulate(x.begin(), x.end(), 0);
		                      }},
		           value);
	table["a"].emplace_back(1, 2.0, "b");
	std::optional<int> found = std::stoi(out.str());
	std::printf("%s\\n", std::format("{} {} {:>3}", out.str(), found.value_or(-1), table["a"].size()).c_str());
}
`
};

export const WORKLOADS = [
	{
		name: 'c -O2',
		tool: 'clang',
		source: 'c.c',
		args: ['-O2', '-std=gnu17', '-x', 'c']
	},
	{
		name: 'bits/stdc++ -O2',
		tool: 'clang',
		source: 'stdcpp.cpp',
		args: ['-O2', '-std=gnu++17', '-x', 'c++']
	},
	{
		name: 'templates -O2',
		tool: 'clang',
		source: 'templates.cpp',
		args: ['-O2', '-std=gnu++20', '-x', 'c++']
	},
	{
		name: 'bits/stdc++ -O0 -g',
		tool: 'clang',
		source: 'stdcpp.cpp',
		args: [
			'-O0',
			'-std=gnu++17',
			'-x',
			'c++',
			'-debug-info-kind=standalone',
			'-dwarf-version=4',
			'-debugger-tuning=gdb'
		]
	},
	{ name: 'link bits/stdc++', tool: 'lld', link: 'stdcpp.cpp' }
];

export const EXPECTED_OUTPUT = {
	'c.c': '0 63 4\n',
	'stdcpp.cpp': '1000 1000 1008 504678\n',
	'templates.cpp': '12.5x6 12   1\n'
};

function usage() {
	return `Usage: node benchmark-compiler.mjs --sysroot <dir|sysroot.tar.zip> --baseline <dir> \\
  --candidate <name>=<dir> [--candidate ...] [--runs 5] [--max-growth 10] [--json out.json] [--enforce]

Each <dir> contains raw clang and lld modules (build-toolchain.mjs --compiler-only output) or
clang.zip and lld.zip release archives. --enforce exits nonzero when a candidate exceeds the
size budget or produces a program with unexpected output.`;
}

export function parseArgs(argv) {
	const options = { candidates: [], runs: 5, maxGrowth: 10, enforce: false };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const value = () => {
			const next = argv[++index];
			if (next === undefined) throw new Error(`${arg} requires a value`);
			return next;
		};
		if (arg === '--') continue;
		else if (arg === '--help' || arg === '-h') options.help = true;
		else if (arg === '--sysroot') options.sysroot = value();
		else if (arg === '--baseline') options.baseline = value();
		else if (arg === '--candidate') {
			const entry = value();
			const separator = entry.indexOf('=');
			if (separator <= 0) throw new Error(`--candidate expects <name>=<dir>, got ${entry}`);
			if (separator === entry.length - 1) {
				throw new Error(`--candidate requires a directory, got ${entry}`);
			}
			options.candidates.push({
				name: entry.slice(0, separator),
				dir: entry.slice(separator + 1)
			});
		} else if (arg === '--runs') options.runs = Number(value());
		else if (arg === '--max-growth') options.maxGrowth = Number(value());
		else if (arg === '--json') options.json = value();
		else if (arg === '--enforce') options.enforce = true;
		else throw new Error(`Unknown argument ${arg}`);
	}
	if (options.help) return options;
	if (!options.sysroot || !options.baseline || options.candidates.length === 0) {
		throw new Error('--sysroot, --baseline and at least one --candidate are required');
	}
	const names = new Set(['baseline']);
	for (const { name } of options.candidates) {
		if (names.has(name)) throw new Error(`Duplicate benchmark name: ${name}`);
		names.add(name);
	}
	if (!Number.isInteger(options.runs) || options.runs < 2) {
		throw new Error('--runs must be an integer of at least 2');
	}
	if (!Number.isFinite(options.maxGrowth) || options.maxGrowth < 0) {
		throw new Error('--max-growth must be a non-negative percentage');
	}
	return options;
}

export function sizeReport(baseline, candidate, maxGrowth) {
	const modules = {};
	let withinBudget = true;
	for (const name of MODULES) {
		const entry = {};
		for (const kind of ['raw', 'gzip']) {
			const growth =
				((candidate[name][kind] - baseline[name][kind]) / baseline[name][kind]) * 100;
			entry[kind] = {
				bytes: candidate[name][kind],
				growthPercent: Number(growth.toFixed(2))
			};
			if (growth > maxGrowth) withinBudget = false;
		}
		modules[name] = entry;
	}
	return { modules, withinBudget };
}

export function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function exists(filePath) {
	return !!(await fs.stat(filePath).catch(() => null));
}

function unzipSingle(archive) {
	const result = spawnSync('unzip', ['-p', archive], { maxBuffer: 1 << 30 });
	if (result.status !== 0) throw new Error(`unzip ${archive} failed: ${result.stderr}`);
	return result.stdout;
}

async function loadModules(dir) {
	const modules = {};
	for (const name of MODULES) {
		const raw = path.join(dir, name);
		const bytes = (await exists(raw))
			? await fs.readFile(raw)
			: unzipSingle(path.join(dir, `${name}.zip`));
		modules[name] = {
			bytes,
			raw: bytes.length,
			gzip: gzipSync(bytes, { level: 9 }).length,
			sha256: createHash('sha256').update(bytes).digest('hex')
		};
	}
	return modules;
}

async function loadProvenance(dir) {
	const receipts = [];
	for (const name of PROVENANCE_FILES) {
		const file = path.join(dir, name);
		if (!(await exists(file))) continue;
		const bytes = await fs.readFile(file);
		receipts.push({
			file: path.resolve(file),
			sha256: createHash('sha256').update(bytes).digest('hex'),
			receipt: JSON.parse(bytes.toString('utf8'))
		});
	}
	return receipts;
}

async function prepareSysroot(sysroot, scratch) {
	if ((await fs.stat(sysroot)).isDirectory()) return path.resolve(sysroot);
	const target = path.join(scratch, 'sysroot');
	await fs.mkdir(target, { recursive: true });
	const tar = spawnSync('tar', ['-x', '-C', target], {
		input: unzipSingle(sysroot)
	});
	if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
	return target;
}

async function runWasi(module, args, preopens) {
	const prepareStart = performance.now();
	const wasi = new WASI({
		version: 'preview1',
		args,
		env: {},
		preopens,
		returnOnExit: true
	});
	const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
	const start = performance.now();
	const code = wasi.start(instance);
	const end = performance.now();
	return {
		code,
		ms: end - start,
		preparationMs: start - prepareStart,
		totalMs: end - prepareStart
	};
}

function compileArgs(workload, input, output) {
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
		...INCLUDE_ARGS,
		'-ferror-limit',
		'19',
		...workload.args,
		'-o',
		output,
		input
	];
}

function linkArgs(object, output, cpp = true) {
	return [
		'wasm-ld',
		'--export-dynamic',
		'-z',
		'stack-size=1048576',
		'-L/lib/wasm32-wasi/noeh',
		'-L/lib/wasm32-wasi',
		'/lib/wasm32-wasi/crt1.o',
		object,
		'/lib/wasm32-wasi/libc-printscan-long-double.a',
		'-lc',
		...(cpp ? ['-lc++', '-lc++abi'] : []),
		'-lm',
		`-L${RESOURCE_DIR}/lib/wasi`,
		'-lclang_rt.builtins-wasm32',
		'-o',
		output
	];
}

async function checkPrograms(variant, sysroot, work) {
	const failures = [];
	const preopens = { '/': sysroot, '/work': work };
	for (const source of Object.keys(SOURCES)) {
		const workload = WORKLOADS.find(
			(entry) => entry.source === source && entry.tool === 'clang'
		);
		const object = `/work/check-${source}.o`;
		const program = `/work/check-${source}.wasm`;
		const compiled = await runWasi(
			variant.compiled.clang,
			compileArgs(workload, `/work/${source}`, object),
			preopens
		);
		const linked = await runWasi(
			variant.compiled.lld,
			linkArgs(object, program, !source.endsWith('.c')),
			preopens
		);
		if (compiled.code !== 0 || linked.code !== 0) {
			failures.push(`${source}: compile ${compiled.code}, link ${linked.code}`);
			continue;
		}
		const stdoutPath = path.join(work, `check-${source}.out`);
		const stdout = await fs.open(stdoutPath, 'w');
		const wasi = new WASI({
			version: 'preview1',
			args: ['program'],
			env: {},
			stdout: stdout.fd,
			returnOnExit: true
		});
		const module = await WebAssembly.compile(
			await fs.readFile(path.join(work, path.basename(program)))
		);
		const code = wasi.start(await WebAssembly.instantiate(module, wasi.getImportObject()));
		await stdout.close();
		const output = await fs.readFile(stdoutPath, 'utf8');
		if (code !== 0 || output !== EXPECTED_OUTPUT[source]) {
			failures.push(`${source}: exit ${code}, output ${JSON.stringify(output)}`);
		}
	}
	return failures;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(usage());
		return;
	}
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'clang-benchmark-'));
	try {
		const sysroot = await prepareSysroot(options.sysroot, scratch);
		const variants = [{ name: 'baseline', dir: options.baseline }, ...options.candidates].map(
			(variant) => ({ ...variant })
		);
		for (const variant of variants) {
			variant.modules = await loadModules(variant.dir);
			variant.provenance = await loadProvenance(variant.dir);
			variant.compiled = {};
			variant.compileMs = {};
			for (const name of MODULES) {
				const start = performance.now();
				variant.compiled[name] = await WebAssembly.compile(variant.modules[name].bytes);
				variant.compileMs[name] = performance.now() - start;
			}
			// Report labels must never select filesystem paths or make variants share their outputs.
			variant.work = await fs.mkdtemp(path.join(scratch, 'variant-'));
			for (const [name, source] of Object.entries(SOURCES)) {
				await fs.writeFile(path.join(variant.work, name), source);
			}
			variant.timings = Object.fromEntries(WORKLOADS.map((workload) => [workload.name, []]));
			variant.preparationTimings = Object.fromEntries(
				WORKLOADS.map((workload) => [workload.name, []])
			);
			variant.totalTimings = Object.fromEntries(
				WORKLOADS.map((workload) => [workload.name, []])
			);
			variant.failures = [];
		}

		// Interleave variants within each run so machine load drifts affect them equally.
		for (let run = 0; run < options.runs; run++) {
			for (const variant of variants) {
				const preopens = { '/': sysroot, '/work': variant.work };
				for (const workload of WORKLOADS) {
					const args =
						workload.tool === 'clang'
							? compileArgs(
									workload,
									`/work/${workload.source}`,
									`/work/${workload.source}.o`
								)
							: linkArgs(`/work/${workload.link}.o`, '/work/linked.wasm');
					const result = await runWasi(variant.compiled[workload.tool], args, preopens);
					if (result.code !== 0) {
						variant.failures.push(`${workload.name} exited with ${result.code}`);
					}
					variant.timings[workload.name].push(result.ms);
					variant.preparationTimings[workload.name].push(result.preparationMs);
					variant.totalTimings[workload.name].push(result.totalMs);
				}
			}
		}

		for (const variant of variants) {
			variant.failures.push(...(await checkPrograms(variant, sysroot, variant.work)));
		}

		const report = {
			generatedAt: new Date().toISOString(),
			measurementScope:
				'Node WASI reference: local bytes, no download, no persistent cache, fresh instance per invocation. Browser acceptance is separate.',
			gzipLevel: 9,
			runs: options.runs,
			maxGrowthPercent: options.maxGrowth,
			node: process.version,
			v8: process.versions.v8,
			platform: process.platform,
			arch: process.arch,
			sourceSha256: Object.fromEntries(
				Object.entries(SOURCES).map(([name, source]) => [
					name,
					createHash('sha256').update(source).digest('hex')
				])
			),
			workloads: WORKLOADS,
			expectedOutput: EXPECTED_OUTPUT,
			variants: variants.map((variant) => ({
				name: variant.name,
				dir: path.resolve(variant.dir),
				provenance: variant.provenance,
				sizes: Object.fromEntries(
					MODULES.map((name) => [
						name,
						{
							raw: variant.modules[name].raw,
							gzip: variant.modules[name].gzip,
							sha256: variant.modules[name].sha256
						}
					])
				),
				moduleCompileMs: Object.fromEntries(
					MODULES.map((name) => [name, Math.round(variant.compileMs[name])])
				),
				workloads: Object.fromEntries(
					WORKLOADS.map((workload) => {
						const timings = variant.timings[workload.name];
						return [
							workload.name,
							{
								firstMs: Math.round(timings[0]),
								warmMedianMs: Math.round(median(timings.slice(1))),
								firstPreparationMs: Math.round(
									variant.preparationTimings[workload.name][0]
								),
								warmPreparationMedianMs: Math.round(
									median(variant.preparationTimings[workload.name].slice(1))
								),
								firstInstantiateAndRunMs: Math.round(
									variant.totalTimings[workload.name][0]
								),
								warmInstantiateAndRunMedianMs: Math.round(
									median(variant.totalTimings[workload.name].slice(1))
								),
								samplesMs: timings,
								preparationSamplesMs: variant.preparationTimings[workload.name],
								instantiateAndRunSamplesMs: variant.totalTimings[workload.name]
							}
						];
					})
				),
				failures: variant.failures
			}))
		};
		for (const [index, entry] of report.variants.entries()) {
			if (index === 0) continue;
			const size = sizeReport(
				variants[0].modules,
				variants[index].modules,
				options.maxGrowth
			);
			entry.sizeGrowth = size.modules;
			entry.withinSizeBudget = size.withinBudget;
			entry.speedup = Object.fromEntries(
				WORKLOADS.map((workload) => [
					workload.name,
					Number(
						(
							report.variants[0].workloads[workload.name].warmMedianMs /
							entry.workloads[workload.name].warmMedianMs
						).toFixed(3)
					)
				])
			);
		}

		console.log(`Warm median of ${options.runs - 1} runs after one first run (ms):`);
		console.table(
			Object.fromEntries(
				report.variants.map((entry) => [
					entry.name,
					Object.fromEntries(
						WORKLOADS.map((workload) => [
							workload.name,
							entry.workloads[workload.name].warmMedianMs
						])
					)
				])
			)
		);
		console.log(
			`Module sizes (growth vs baseline, budget ${options.maxGrowth}% raw and gzip):`
		);
		console.table(
			Object.fromEntries(
				report.variants.map((entry) => [
					entry.name,
					Object.fromEntries(
						MODULES.flatMap((name) =>
							['raw', 'gzip'].map((kind) => [
								`${name} ${kind}`,
								`${entry.sizes[name][kind]}${
									entry.sizeGrowth
										? ` (${entry.sizeGrowth[name][kind].growthPercent}%)`
										: ''
								}`
							])
						)
					)
				])
			)
		);
		let failed = false;
		for (const entry of report.variants) {
			if (entry.failures.length) {
				failed = true;
				console.log(`${entry.name}: FAILED ${entry.failures.join('; ')}`);
			}
			if (entry.withinSizeBudget === false) {
				failed = true;
				console.log(`${entry.name}: exceeds the ${options.maxGrowth}% size budget`);
			}
		}
		if (options.json) await fs.writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`);
		if (failed && options.enforce) process.exitCode = 1;
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
