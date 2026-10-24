#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCorpus } from './generate.mjs';
import { loadBundle, sha256 } from '../qualification/compile.mjs';
import { assertCaseResult, assertStaticExecutable, functionAssembly } from '../qualification/assertions.mjs';

const compileCli = fileURLToPath(new URL('../qualification/compile.mjs', import.meta.url));
const writeJson = (name, value) => fs.writeFile(name, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const MAX_STREAM_BYTES = 1024 * 1024;

// Every child, including native references and version probes, is bounded by
// both its individual deadline and the remaining campaign wall-clock budget.
// Synthetic tests exercise this helper; they are not actual compiler evidence.
export async function runBoundedProcess({ command, args, directory, name, deadline, timeoutMs, input = '' }) {
	assert(/^[a-z][a-z0-9-]+$/.test(name), 'Invalid process evidence name');
	const available = Math.floor(deadline - performance.now());
	const timeout = Math.min(timeoutMs, available);
	const started = performance.now();
	const result = timeout > 0 ? spawnSync(command, args, {
		input, encoding: 'utf8', cwd: directory, timeout, killSignal: 'SIGKILL', maxBuffer: MAX_STREAM_BYTES,
		env: { ...process.env, LANG: 'C', LC_ALL: 'C' }
	}) : { status: null, signal: null, error: new Error('Campaign wall-clock budget exhausted before process start') };
	const stdout = Buffer.from(result.stdout ?? '').subarray(0, MAX_STREAM_BYTES);
	const stderr = Buffer.from(result.stderr ?? '').subarray(0, MAX_STREAM_BYTES);
	const evidence = { command, args, timeoutMs: Math.max(0, timeout), milliseconds: performance.now() - started,
		status: result.status, signal: result.signal, error: result.error?.message, errorCode: result.error?.code,
		stdoutBytes: stdout.length, stderrBytes: stderr.length,
		stdoutTruncated: Buffer.byteLength(result.stdout ?? '') > stdout.length,
		stderrTruncated: Buffer.byteLength(result.stderr ?? '') > stderr.length };
	await fs.writeFile(path.join(directory, `${name}.stdout`), stdout, { flag: 'wx', mode: 0o600 });
	await fs.writeFile(path.join(directory, `${name}.stderr`), stderr, { flag: 'wx', mode: 0o600 });
	await writeJson(path.join(directory, `${name}.process.json`), evidence);
	assert.ifError(result.error);
	assert.equal(result.status, 0, `${name} failed (status=${result.status}, signal=${result.signal}); see ${directory}/${name}.stderr`);
	return { ...evidence, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
}

function checkAssembly(test, bytes) {
	const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	for (const rule of test.assemblyChecks ?? []) {
		const body = functionAssembly(text, rule.function);
		for (const pattern of rule.require) assert.match(body, new RegExp(pattern, 'm'), `${test.id}: ${rule.function} missing ${pattern}`);
		for (const pattern of rule.forbid) assert.doesNotMatch(body, new RegExp(pattern, 'm'), `${test.id}: ${rule.function} leaked ${pattern}`);
	}
}

export async function fuzz({ bundle: bundleDirectory, output, manifestSha256, seed = 20261024, cases = 24, caseIndex,
	nativeCc = 'gcc-13', nativeCxx = 'g++-13', maxSeconds = 600, caseTimeoutSeconds = 90, allowNativeVersionMismatch = false }) {
	assert(/^[a-f0-9]{64}$/.test(manifestSha256 ?? ''), '--manifest-sha256 must pin the bundle digest');
	assert(Number.isInteger(maxSeconds) && maxSeconds >= 1 && maxSeconds <= 3600, 'max seconds must be 1..3600');
	assert(Number.isInteger(caseTimeoutSeconds) && caseTimeoutSeconds >= 1 && caseTimeoutSeconds <= 300, 'case timeout seconds must be 1..300');
	const corpus = generateCorpus({ seed, count: cases, caseIndex });
	const bundleRoot = await fs.realpath(bundleDirectory);
	const canonicalOutput = path.join(await fs.realpath(path.dirname(path.resolve(output))), path.basename(output));
	assert(canonicalOutput !== bundleRoot && !canonicalOutput.startsWith(bundleRoot + path.sep) &&
		!bundleRoot.startsWith(canonicalOutput + path.sep), 'Fuzz output must not overlap its bundle');
	await fs.mkdir(canonicalOutput, { mode: 0o700 });
	const started = performance.now(), deadline = started + maxSeconds * 1000;
	const evidence = { schemaVersion: 1, kind: 'gcc-generated-real-fuzz-report', passed: false,
		seed, requestedCases: cases, selectedCaseIndex: caseIndex, maxSeconds, caseTimeoutSeconds,
		method: 'Seeded grammar/property differential fuzzing; no coverage-guided claims.',
		oracle: 'Independent BigInt uint32 interpreter plus native GCC; source has bounded loops/shifts, nonzero divisors and runtime stdin.',
		requestedManifestSha256: manifestSha256, allowNativeVersionMismatch,
		environment: { node: process.version, platform: process.platform, architecture: process.arch, kernel: os.release() },
		browserQualification: 'This campaign uses fresh Node Emscripten processes. Replay corpus.json with wasm-idle/scripts/fuzz-x86-cross-gcc.mjs for actual Chromium Worker coverage.',
		tests: [], nativeCompilers: {} };
	let nativeDirectory;
	try {
		assert.equal(process.platform, 'linux', 'Generated baseline programs execute only on native Linux');
		assert.equal(process.arch, 'x64', 'Generated baseline programs require an x86-64 Linux host');
		const bundle = await loadBundle(bundleRoot, manifestSha256);
		corpus.compilerIdentity = { manifestSha256: bundle.manifestSha256, compiler: bundle.manifest.compiler,
			host: bundle.manifest.host, target: bundle.manifest.target, assets: bundle.manifest.assets,
			sysrootSha256: bundle.manifest.assets.sysroot.sha256 };
		const corpusBytes = Buffer.from(JSON.stringify(corpus, null, 2) + '\n');
		// Persist the entire immutable campaign before executing a loader or compiler.
		await fs.writeFile(path.join(canonicalOutput, 'corpus.json'), corpusBytes, { flag: 'wx', mode: 0o600 });
		evidence.corpusSha256 = sha256(corpusBytes);
		evidence.compilerIdentity = corpus.compilerIdentity;
		for (const name of Object.keys(bundle.manifest.assets)) {
			assert(performance.now() < deadline, 'Campaign wall-clock budget exhausted during bundle verification');
			await bundle.readAsset(name);
		}
		const processCall = (directory, name, command, args, input = '', timeoutMs = caseTimeoutSeconds * 1000) =>
			runBoundedProcess({ command, args, directory, name, input, deadline, timeoutMs });
		const languages = [...new Set(corpus.cases.map(test => test.request.language))];
		for (const language of languages) {
			const compiler = language === 'c' ? nativeCc : nativeCxx;
			const versionResult = await processCall(canonicalOutput, `native-${language}-version`, compiler, ['-dumpfullversion', '-dumpversion'], '', 10_000);
			const targetResult = await processCall(canonicalOutput, `native-${language}-target`, compiler, ['-dumpmachine'], '', 10_000);
			const version = versionResult.stdout.trim(), target = targetResult.stdout.trim();
			const sameVersion = version === bundle.manifest.compiler.version;
			evidence.nativeCompilers[language] = { compiler, version, target, sameVersion };
			assert(/^x86_64-[a-z0-9_-]*linux[a-z0-9_-]*$/.test(target), `Native compiler target is ${target}, expected x86-64 Linux`);
			assert(sameVersion || allowNativeVersionMismatch,
				`Native ${compiler} ${version} differs from Wasm GCC ${bundle.manifest.compiler.version}; use the matching GCC or explicitly --allow-native-version-mismatch`);
		}
		nativeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'gcc-generated-fuzz-exec-'));
		await fs.chmod(nativeDirectory, 0o700);
		for (const test of corpus.cases) {
			const directory = path.join(canonicalOutput, test.id);
			await fs.mkdir(directory, { mode: 0o700 });
			const item = { id: test.id, index: test.index, family: test.family, passed: false,
				sourceSha256: sha256(test.request.code), request: { ...test.request, code: undefined }, stdin: test.stdin,
				expectedStdout: test.expectedStdout };
			evidence.tests.push(item);
			const requestPath = path.join(directory, 'request.json');
			const sourcePath = path.join(directory, test.request.language === 'c' ? 'main.c' : 'main.cpp');
			await writeJson(requestPath, test.request);
			await fs.writeFile(sourcePath, test.request.code, { flag: 'wx', mode: 0o600 });
			await fs.writeFile(path.join(directory, 'stdin.txt'), test.stdin, { flag: 'wx', mode: 0o600 });
			await fs.writeFile(path.join(directory, 'expected-stdout.txt'), test.expectedStdout, { flag: 'wx', mode: 0o600 });
			await processCall(directory, 'wasm-host', process.execPath, ['--expose-gc', compileCli,
				bundleRoot, bundle.manifestSha256, requestPath, directory]);
			const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
			item.compilation = result;
			assert.equal(result.exitCode, 0, `${test.id}: unexpected GCC diagnostic: ${result.stderr}`);
			assert(result.artifact, `${test.id}: missing output`);
			const artifactPath = path.join(directory, test.request.emit === 'assembly' ? 'main.s' : 'main.elf');
			assert.equal(result.artifact.path, artifactPath, 'Compile adapter returned an unexpected output path');
			const bytes = await fs.readFile(artifactPath);
			assert.equal(bytes.length, result.artifact.bytes);
			assert.equal(sha256(bytes), result.artifact.sha256);
			assertCaseResult(test, { ...result, artifact: { ...result.artifact, bytes } });
			if (test.request.emit === 'assembly') checkAssembly(test, bytes);
			const compiler = test.request.language === 'c' ? nativeCc : nativeCxx;
			const referencePath = path.join(directory, test.request.emit === 'assembly' ? 'reference.s' : 'reference.elf');
			const args = ['-march=x86-64', ...(test.request.cpu === 'avx2-fma' ? ['-mavx2', '-mfma'] : []),
				`-O${test.request.optimization}`, `-std=${test.request.standard}`, '-fno-pie', '-fno-pic',
				...(test.request.emit === 'assembly' ? ['-S'] : ['-static', '-no-pie']), sourcePath, '-o', referencePath];
			const nativeCompile = await processCall(directory, 'native-compile', compiler, args);
			const referenceBytes = await fs.readFile(referencePath);
			item.nativeReference = { compiler, args, milliseconds: nativeCompile.milliseconds,
				bytes: referenceBytes.length, sha256: sha256(referenceBytes) };
			if (test.request.emit === 'assembly') {
				checkAssembly(test, referenceBytes);
				item.assemblyChecksPassed = true;
				item.nativeExecution = 'Intentionally not executed: AVX2/FMA output is assembly-only.';
			} else {
				assert.equal(test.request.cpu, 'x86-64', 'Only baseline executable fuzz cases may run');
				assertStaticExecutable(referenceBytes);
				for (const [name, inputPath] of [['wasm-program', artifactPath], ['native-program', referencePath]]) {
					// /dev/shm may be mounted noexec. Preserve evidence there and run a
					// private verified copy from the system temporary directory instead.
					const executionPath = path.join(nativeDirectory, `${test.id}-${name}`);
					await fs.copyFile(inputPath, executionPath, fs.constants.COPYFILE_EXCL);
					await fs.chmod(executionPath, 0o700);
					const execution = await processCall(directory, name, executionPath, [], test.stdin, 10_000);
					item[name] = execution;
					assert.equal(execution.stdout, test.expectedStdout, `${test.id}: ${name} differs from the independent oracle`);
					assert.equal(execution.stderr, '', `${test.id}: ${name} emitted unexpected runtime diagnostics`);
				}
				assert.equal(item['wasm-program'].stdout, item['native-program'].stdout, `${test.id}: differential mismatch`);
			}
			item.passed = true;
			await writeJson(path.join(directory, 'fuzz-case.json'), item);
		}
		assert(performance.now() <= deadline, 'Campaign wall-clock budget exhausted before completion');
		evidence.passed = true;
	} catch (error) {
		evidence.error = error.stack ?? String(error);
		throw error;
	} finally {
		evidence.milliseconds = performance.now() - started;
		evidence.completedCases = evidence.tests.filter(test => test.passed).length;
		evidence.plannedCases = corpus.cases.length;
		await writeJson(path.join(canonicalOutput, 'fuzz-report.json'), evidence);
		if (nativeDirectory) await fs.rm(nativeDirectory, { recursive: true, force: true });
	}
	return { passed: evidence.passed, tests: evidence.completedCases, manifestSha256, corpusSha256: evidence.corpusSha256,
		report: path.join(canonicalOutput, 'fuzz-report.json'), corpus: path.join(canonicalOutput, 'corpus.json') };
}

if (process.argv[1] && (await fs.realpath(process.argv[1])) === fileURLToPath(import.meta.url)) {
	try {
		const args = process.argv.slice(2), options = {};
		const fields = { '--bundle': 'bundle', '--output': 'output', '--manifest-sha256': 'manifestSha256',
			'--native-cc': 'nativeCc', '--native-cxx': 'nativeCxx', '--seed': 'seed', '--cases': 'cases',
			'--case-index': 'caseIndex', '--max-seconds': 'maxSeconds', '--case-timeout-seconds': 'caseTimeoutSeconds' };
		const numbers = new Set(['seed', 'cases', 'caseIndex', 'maxSeconds', 'caseTimeoutSeconds']);
		for (let i = 0; i < args.length; i++) {
			if (args[i] === '--allow-native-version-mismatch') {
				assert(!options.allowNativeVersionMismatch, 'Duplicate mismatch flag');
				options.allowNativeVersionMismatch = true;
				continue;
			}
			const field = fields[args[i]];
			assert(field && args[i + 1] && !(field in options), `Unknown, duplicate or missing option ${args[i]}`);
			const value = args[++i];
			assert(!numbers.has(field) || /^\d+$/.test(value), `${field} must be a nonnegative integer`);
			options[field] = numbers.has(field) ? Number(value) : value;
		}
		assert(options.bundle && options.output, '--bundle and --output NEW_DIR are required');
		console.log(JSON.stringify(await fuzz(options), null, 2));
	} catch (error) {
		console.error(error.stack ?? String(error));
		process.exitCode = 1;
	}
}
