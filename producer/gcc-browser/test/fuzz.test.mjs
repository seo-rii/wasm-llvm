import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateCorpus, evaluateExpression } from '../fuzz/generate.mjs';
import { fuzz, runBoundedProcess } from '../fuzz/run.mjs';
import { sha256 } from '../qualification/compile.mjs';
import { functionAssembly } from '../qualification/assertions.mjs';

async function temporary(t) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gcc-fuzz-test-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	return directory;
}

test('CLI symlink invocation rejects invalid options instead of silently succeeding', async t => {
	const directory = await temporary(t);
	const entry = path.join(directory, 'fuzz-symlink.mjs');
	await fs.symlink(fileURLToPath(new URL('../fuzz/run.mjs', import.meta.url)), entry);
	const result = spawnSync(process.execPath, [entry, '--bogus'], {
		encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024
	});
	assert.ifError(result.error);
	assert.equal(result.status, 1, 'A symlinked CLI must run its argument validation');
	assert.match(result.stderr, /Unknown, duplicate or missing option --bogus/);
});

test('seed/index replay is stable and covers both languages, library code and AVX assembly', () => {
	const corpus = generateCorpus({ seed: 0xffffffff, count: 42 });
	assert.deepEqual(corpus, generateCorpus({ seed: 0xffffffff, count: 42 }));
	assert.notEqual(JSON.stringify(corpus), JSON.stringify(generateCorpus({ seed: 0, count: 42 })));
	for (const index of [0, 1, 5, 17, 41]) {
		assert.deepEqual(generateCorpus({ seed: 0xffffffff, caseIndex: index }).cases[0], corpus.cases[index]);
	}
	assert.deepEqual([...new Set(corpus.cases.map(c => c.family))].sort(),
		['c-unsigned-control', 'cpp-stl-pbds-exceptions', 'cpp-target-optimize-push-pop', 'cpp-unsigned-control']);
	assert.deepEqual([...new Set(corpus.cases.map(c => c.request.optimization))].sort(), ['0', '1', '2', '3', 's']);
	assert.deepEqual([...new Set(corpus.cases.map(c => c.request.cpu))].sort(), ['avx2-fma', 'x86-64']);
	for (const item of corpus.cases) {
		assert.match(item.id, /^case-[0-9]{6}$/);
		if (item.request.emit === 'executable') {
			assert.equal(item.request.cpu, 'x86-64');
			assert(item.stdin && item.expectedStdout);
		} else {
			assert.equal(item.request.emit, 'assembly');
			assert.equal(item.check, 'avx2-fma');
			assert(item.assemblyChecks.length >= 4);
		}
	}
	assert.throws(() => generateCorpus({ seed: -1 }), /uint32/);
	assert.throws(() => generateCorpus({ seed: 0, count: 1001 }), /count/);
	assert.throws(() => generateCorpus({ seed: 0, caseIndex: Infinity }), /index/);
});

test('independent oracle handles unsigned overflow, bounded shifts and nonzero division', () => {
	const constant = value => ({ constant: value });
	const check = (op, left, right, expected) => assert.equal(evaluateExpression({ op,
		left: constant(left), right: constant(right) }, {}), expected);
	check('add', 0xffffffff, 1, 0n);
	check('sub', 0, 1, 0xffffffffn);
	check('mul', 0xffffffff, 0xffffffff, 1n);
	check('shl', 0xffffffff, 32, 0xffffffffn);
	check('shl', 1, 63, 0x80000000n);
	check('shr', 0x80000000, 31, 1n);
	check('div', 0xffffffff, 0, 0xffffffffn);
	check('mod', 0xffffffff, 0, 0n);
});

// This validates the generator/oracle with the machine's native compiler. It
// is explicitly not a Wasm GCC or Chromium qualification campaign.
test('generated C/C++ native executions match the oracle, including STL/PBDS/exceptions', async t => {
	const directory = await temporary(t);
	for (const seed of [0, 0xffffffff]) {
		for (const item of generateCorpus({ seed, count: 6 }).cases) {
			const prefix = path.join(directory, `${seed}-${item.id}`);
			const source = `${prefix}.${item.request.language === 'c' ? 'c' : 'cpp'}`;
			const output = prefix + (item.request.emit === 'assembly' ? '.s' : '.elf');
			await fs.writeFile(source, item.request.code);
			const compiler = item.request.language === 'c'
				? (process.env.CC_FOR_BUILD ?? 'gcc') : (process.env.CXX_FOR_BUILD ?? 'g++');
			const result = spawnSync(compiler, [`-std=${item.request.standard}`, `-O${item.request.optimization}`,
				'-march=x86-64', ...(item.request.cpu === 'avx2-fma' ? ['-mavx2', '-mfma'] : []),
				...(item.request.emit === 'assembly' ? ['-S'] : []), source, '-o', output],
				{ encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
			assert.ifError(result.error);
			assert.equal(result.status, 0, result.stderr);
			if (item.request.emit === 'assembly') {
				const assembly = await fs.readFile(output, 'utf8');
				for (const rule of item.assemblyChecks) {
					const body = functionAssembly(assembly, rule.function);
					for (const pattern of rule.require) assert.match(body, new RegExp(pattern, 'm'));
					for (const pattern of rule.forbid) assert.doesNotMatch(body, new RegExp(pattern, 'm'));
				}
			} else {
				const execution = spawnSync(output, [], { input: item.stdin, encoding: 'utf8',
					timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
				assert.ifError(execution.error);
				assert.equal(execution.status, 0, execution.stderr);
				assert.equal(execution.stdout, item.expectedStdout, `seed=${seed}, index=${item.index}`);
			}
		}
	}
});

test('synthetic child failures preserve bounded stdout/stderr and process status', async t => {
	const directory = await temporary(t);
	await assert.rejects(runBoundedProcess({ command: process.execPath,
		args: ['-e', 'process.stdout.write("partial output"); process.stderr.write("original failure"); process.exit(7)'],
		directory, name: 'synthetic-failure', deadline: performance.now() + 5000, timeoutMs: 4000 }), /failed/);
	assert.equal(await fs.readFile(path.join(directory, 'synthetic-failure.stderr'), 'utf8'), 'original failure');
	assert.equal(await fs.readFile(path.join(directory, 'synthetic-failure.stdout'), 'utf8'), 'partial output');
	assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'synthetic-failure.process.json'))).status, 7);
	await assert.rejects(runBoundedProcess({ command: process.execPath,
		args: ['-e', 'process.stderr.write("before hang"); while(true) {}'], directory,
		name: 'synthetic-timeout', deadline: performance.now() + 5000, timeoutMs: 500 }), /ETIMEDOUT/);
	assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'synthetic-timeout.process.json'))).signal, 'SIGKILL');
	assert.match(await fs.readFile(path.join(directory, 'synthetic-timeout.stderr'), 'utf8'), /before hang/);
	await assert.rejects(runBoundedProcess({ command: '/nonexistent-not-started', args: [], directory,
		name: 'synthetic-budget', deadline: performance.now() - 1, timeoutMs: 100 }), /budget exhausted/);
	assert.match(JSON.parse(await fs.readFile(path.join(directory, 'synthetic-budget.process.json'))).error, /before process start/);
	await assert.rejects(runBoundedProcess({ command: process.execPath,
		args: ['-e', 'process.stderr.write("flood".repeat(1024*1024))'], directory,
		name: 'synthetic-output', deadline: performance.now() + 5000, timeoutMs: 4000 }), /ENOBUFS/);
	assert((await fs.stat(path.join(directory, 'synthetic-output.stderr'))).size <= 1024 * 1024);
});

async function syntheticBundle(directory) {
	const bundle = path.join(directory, 'synthetic-bundle');
	await fs.mkdir(bundle);
	const assets = {};
	for (const tool of ['cc1', 'cc1plus', 'as', 'ld']) {
		for (const [type, bytes] of [['Js', Buffer.from('export default async function() { throw new Error("intentional synthetic host failure"); }')],
			['Wasm', Buffer.from('0061736d01000000', 'hex')]]) {
			const name = `${tool}.${type === 'Js' ? 'mjs' : 'wasm'}`;
			await fs.writeFile(path.join(bundle, name), bytes);
			assets[`${tool}${type}`] = { path: name, bytes: bytes.length, sha256: sha256(bytes) };
		}
	}
	const tar = Buffer.alloc(1024);
	await fs.writeFile(path.join(bundle, 'sysroot.tar'), tar);
	assets.sysroot = { path: 'sysroot.tar', bytes: tar.length, sha256: sha256(tar) };
	const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'gcc-x86_64-linux-gnu', host: 'wasm32-emscripten',
		target: 'x86_64-linux-gnu', compiler: { family: 'gcc', version: '0.0.0-synthetic' }, linkMode: 'static',
		sysrootPath: '/sysroot', gccInstallation: '/sysroot/usr/lib/gcc/x86_64-linux-gnu/16',
		resourceDir: '/sysroot/usr/lib/gcc/x86_64-linux-gnu/16/include', gnu: { gccVersion: '16' },
		cpuProfiles: ['x86-64', 'avx2-fma'], assets }));
	await fs.writeFile(path.join(bundle, 'gcc-toolchain.v1.json'), manifest);
	return { bundle, manifestSha256: sha256(manifest) };
}

test('synthetic campaign rejects native version mismatch and preserves replay before host failure', async t => {
	const directory = await temporary(t);
	const identity = await syntheticBundle(directory);
	const options = { ...identity, seed: 1, cases: 1, maxSeconds: 10,
		nativeCc: process.env.CC_FOR_BUILD ?? 'gcc', nativeCxx: process.env.CXX_FOR_BUILD ?? 'g++' };
	const mismatch = path.join(directory, 'mismatch');
	await assert.rejects(fuzz({ ...options, output: mismatch }), /differs from Wasm GCC/);
	const mismatchReport = JSON.parse(await fs.readFile(path.join(mismatch, 'fuzz-report.json')));
	assert.equal(mismatchReport.passed, false);
	assert.equal(mismatchReport.nativeCompilers.c.sameVersion, false);
	assert.equal(mismatchReport.completedCases, 0);
	const failure = path.join(directory, 'host-failure');
	await assert.rejects(fuzz({ ...options, output: failure, allowNativeVersionMismatch: true }), /wasm-host failed/);
	const corpusBytes = await fs.readFile(path.join(failure, 'corpus.json'));
	const report = JSON.parse(await fs.readFile(path.join(failure, 'fuzz-report.json')));
	assert.equal(report.corpusSha256, sha256(corpusBytes));
	assert.equal(report.plannedCases, 1);
	assert.equal(report.tests[0].index, 0);
	assert.equal(report.tests[0].passed, false);
	assert.match(await fs.readFile(path.join(failure, 'case-000000', 'wasm-host.stderr'), 'utf8'), /intentional synthetic host failure/);
	assert.equal(JSON.parse(corpusBytes).compilerIdentity.manifestSha256, identity.manifestSha256);
});
