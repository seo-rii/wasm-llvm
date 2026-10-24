#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases } from './cases.mjs';
import { assertCaseResult, assertStaticExecutable } from './assertions.mjs';
import { loadBundle, sha256 } from './compile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// Execute only the baseline fixtures, in a separate native Linux subprocess.
// Neither this runner nor the browser gate emulates or instantiates x86 ELF.
export async function executeNative(artifactPath, test, outputDirectory) {
	assert.equal(process.platform, 'linux', 'Native execution qualification requires Linux');
	assert.equal(process.arch, 'x64', 'Native execution qualification requires x86-64');
	assert.equal(test.request.cpu, 'x86-64', 'Only baseline fixtures may run on the qualification machine');
	assertStaticExecutable(await fs.readFile(artifactPath));
	await fs.chmod(artifactPath, 0o700);
	const started = performance.now();
	const run = spawnSync(artifactPath, [], { input: test.stdin, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
		cwd: outputDirectory, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
	const evidence = { platform: process.platform, architecture: process.arch, kernel: os.release(),
		milliseconds: performance.now() - started, status: run.status, signal: run.signal,
		stdin: test.stdin, stdout: run.stdout ?? '', stderr: run.stderr ?? '', error: run.error?.message };
	await fs.writeFile(path.join(outputDirectory, 'native-execution.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
	assert.ifError(run.error);
	assert.equal(run.status, 0, `Native ${test.id} failed: ${run.stderr}`);
	assert.equal(run.stdout, test.stdout, `Native ${test.id} produced unexpected stdout`);
	return evidence;
}

async function compareNativeCompiler(test, sourcePath, outputDirectory, compiler, wasmVersion) {
	const version = spawnSync(compiler, ['-dumpfullversion', '-dumpversion'], { encoding: 'utf8', timeout: 10_000 });
	if (version.error?.code === 'ENOENT') return { available: false, compiler, reason: 'Native compiler executable is unavailable' };
	assert.ifError(version.error);
	assert.equal(version.status, 0, `Cannot query native compiler ${compiler}`);
	const actualVersion = version.stdout.trim();
	const binary = path.join(outputDirectory, 'native-reference.elf');
	const args = ['-static', '-fno-pie', '-no-pie', '-march=x86-64', `-O${test.request.optimization}`,
		`-std=${test.request.standard}`, sourcePath, '-o', binary];
	const started = performance.now();
	const compilation = spawnSync(compiler, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
	assert.ifError(compilation.error);
	assert.equal(compilation.status, 0, `Native compiler comparison failed: ${compilation.stderr}`);
	const execution = spawnSync(binary, [], { input: test.stdin, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
		env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
	assert.ifError(execution.error);
	assert.equal(execution.status, 0, `Native reference exited ${execution.status}`);
	assert.equal(execution.stdout, test.stdout, `Native reference differs for ${test.id}`);
	return { available: true, compiler, version: actualVersion, sameVersion: actualVersion === wasmVersion,
		args, compileAndRunMilliseconds: performance.now() - started, bytes: (await fs.stat(binary)).size,
		stdout: execution.stdout, stderr: compilation.stderr, executionStatus: execution.status,
		comparison: 'The native compiler and Wasm compiler binaries produced the same expected stdout.' };
}

export async function qualify({ bundle: bundleDirectory, output, manifestSha256, nativeCxx = 'g++', nativeCc = 'gcc' }) {
	const bundle = await loadBundle(bundleDirectory, manifestSha256);
	const canonicalOutput = path.join(await fs.realpath(path.dirname(path.resolve(output))), path.basename(output));
	assert(canonicalOutput !== bundle.root && !canonicalOutput.startsWith(bundle.root + path.sep) &&
		!bundle.root.startsWith(canonicalOutput + path.sep), 'Qualification output must not overlap its bundle');
	await fs.mkdir(canonicalOutput, { mode: 0o700 }); // Existing paths, including symlinks, fail.
	const evidence = { schemaVersion: 1, kind: 'gcc-x86_64-linux-gnu-real-qualification', passed: false,
		compiler: bundle.manifest.compiler, host: bundle.manifest.host, target: bundle.manifest.target,
		manifestSha256: bundle.manifestSha256, assets: bundle.manifest.assets, tests: [],
		environment: { node: process.version, platform: process.platform, architecture: process.arch, kernel: os.release() },
		memoryMetrics: { wasm: 'Maximum allocated linear-memory byte length per Emscripten module. Memory grows monotonically; sampled after synchronous callMain.',
			host: 'Fresh Node compile-process maximum resident set size, from process.resourceUsage().maxRSS, in KiB. This includes JavaScript, Wasm, sysroot and host overhead.' },
		browserQualification: 'Separate required gate in wasm-idle/scripts/verify-x86-cross-gcc.mjs. This report does not establish Chromium acceptance.' };
	const started = performance.now();
	try {
		// Verify every asset before executing any loader. Children pin the exact
		// manifest digest again and rehash the bytes they consume.
		for (const name of ['cc1Js', 'cc1Wasm', 'cc1plusJs', 'cc1plusWasm', 'asJs', 'asWasm', 'ldJs', 'ldWasm', 'sysroot']) {
			await bundle.readAsset(name);
		}
		for (const test of cases) {
			const testOutput = path.join(canonicalOutput, test.id);
			await fs.mkdir(testOutput, { mode: 0o700 });
			const sourcePath = path.join(here, 'fixtures', test.fixture);
			const source = await fs.readFile(sourcePath, 'utf8');
			const requestPath = path.join(testOutput, 'request.json');
			await fs.writeFile(requestPath, JSON.stringify({ ...test.request, code: source }) + '\n', { flag: 'wx', mode: 0o600 });
			const childStarted = performance.now();
			const child = spawnSync(process.execPath, ['--expose-gc', path.join(here, 'compile.mjs'), bundle.root,
				bundle.manifestSha256, requestPath, testOutput], { encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
			await fs.writeFile(path.join(testOutput, 'host.stdout'), child.stdout ?? '', { mode: 0o600 });
			await fs.writeFile(path.join(testOutput, 'host.stderr'), child.stderr ?? '', { mode: 0o600 });
			const item = { id: test.id, sourceSha256: sha256(source), request: test.request, passed: false,
				milliseconds: performance.now() - childStarted, hostExitCode: child.status, hostSignal: child.signal };
			evidence.tests.push(item);
			assert.ifError(child.error);
			assert.equal(child.status, 0, `${test.id}: actual compiler host failed: ${child.stderr}`);
			const result = JSON.parse(await fs.readFile(path.join(testOutput, 'result.json'), 'utf8'));
			Object.assign(item, result);
			if (result.artifact) {
				const bytes = await fs.readFile(result.artifact.path);
				assert.equal(sha256(bytes), result.artifact.sha256, `${test.id}: artifact changed`);
				assertCaseResult(test, { ...result, artifact: { ...result.artifact, bytes } });
			} else assertCaseResult(test, result);
			if (test.check === 'pragma-object') {
				const disassembly = spawnSync('objdump', ['-d', result.artifact.path], { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
				assert.ifError(disassembly.error);
				assert.equal(disassembly.status, 0, `objdump failed: ${disassembly.stderr}`);
				assert.match(disassembly.stdout, /\bvpaddd\b/);
				assert.match(disassembly.stdout, /\bvfmadd(?:132|213|231)ps\b/);
				await fs.writeFile(path.join(testOutput, 'disassembly.txt'), disassembly.stdout, { flag: 'wx', mode: 0o600 });
				item.disassemblyVerified = true;
			}
			if (test.stdin !== undefined) {
				item.nativeExecution = await executeNative(result.artifact.path, test, testOutput);
				item.nativeComparison = await compareNativeCompiler(test, sourcePath, testOutput,
					test.request.language === 'c' ? nativeCc : nativeCxx, bundle.manifest.compiler.version);
			}
			item.passed = true;
		}
		evidence.passed = true;
	} catch (error) {
		evidence.error = error.stack ?? String(error);
		throw error;
	} finally {
		evidence.milliseconds = performance.now() - started;
		await fs.writeFile(path.join(canonicalOutput, 'qualification.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
	}
	return { passed: true, tests: evidence.tests.length, manifestSha256: bundle.manifestSha256,
		evidence: path.join(canonicalOutput, 'qualification.json') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const args = process.argv.slice(2);
		const options = {};
		const fields = { '--bundle': 'bundle', '--output': 'output', '--manifest-sha256': 'manifestSha256', '--native-cxx': 'nativeCxx', '--native-cc': 'nativeCc' };
		for (let i = 0; i < args.length; i += 2) {
			assert(fields[args[i]] && args[i + 1], 'Usage: node qualification/run.mjs --bundle DIR --output NEW_DIR [--manifest-sha256 HEX] [--native-cxx g++-13] [--native-cc gcc-13]');
			assert(!(fields[args[i]] in options), `Duplicate ${args[i]}`);
			options[fields[args[i]]] = args[i + 1];
		}
		assert(options.bundle && options.output, '--bundle and --output are required');
		console.log(JSON.stringify(await qualify(options), null, 2));
	} catch (error) {
		console.error(error.stack ?? String(error)); process.exitCode = 1;
	}
}
