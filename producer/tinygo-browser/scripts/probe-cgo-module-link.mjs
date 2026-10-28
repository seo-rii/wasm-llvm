import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PRODUCER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_CASES = [
	'legacy-destination', 'canonical-destination', 'same-legacy', 'same-canonical',
	'preview2', 'wasm64', 'unknown-vendor', 'different-layout',
	'empty-header-layout', 'empty-destination-layout'
];

async function identity(filename) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(filename)) hash.update(chunk);
	return { path: filename, bytes: (await stat(filename)).size, sha256: hash.digest('hex') };
}

async function runLogged(command, args, { cwd, env, stdoutPath, stderrPath, timeoutMs }) {
	const stdout = await open(stdoutPath, 'w', 0o600);
	const stderr = await open(stderrPath, 'w', 0o600);
	try {
		return await new Promise((resolve, reject) => {
			const child = spawn(command, args, {
				cwd, env, detached: true, stdio: ['ignore', stdout.fd, stderr.fd]
			});
			let killTimer;
			const timer = setTimeout(() => {
				try { process.kill(-child.pid, 'SIGTERM'); } catch {}
				killTimer = setTimeout(() => {
					try { process.kill(-child.pid, 'SIGKILL'); } catch {}
				}, 5000);
			}, timeoutMs);
			child.once('error', (error) => {
				clearTimeout(timer); clearTimeout(killTimer); reject(error);
			});
			child.once('close', (exitCode, signal) => {
				clearTimeout(timer); clearTimeout(killTimer); resolve({ exitCode, signal });
			});
		});
	} finally {
		await stdout.close(); await stderr.close();
	}
}

// Execute the exact production normalizer against real native LLVM 22 modules.
// The native TinyGo release itself does not contain the new builder patch.
export async function probeCgoModuleLink({
	nativeTinyGo, nativeLlvmLibrary, sourceRoot, goRoot, buildDir,
	expectedDataLayout, environment, producerRoot = PRODUCER_ROOT
}, { run = runLogged } = {}) {
	const output = path.join(buildDir, 'cgo-module-link-probe');
	await mkdir(output, { recursive: true });
	const receiptPath = path.join(output, 'receipt.json');
	const receipt = {
		status: 'running',
		scope: 'Exact patched TinyGo helper with native LLVM C API parse/link/verify; not a rebuilt TinyGo or browser compiler',
		commands: []
	};
	try {
		assert(process.platform === 'linux' && process.arch === 'x64',
			'the pinned native bootstrap is linux-amd64');
		const helperPath = path.join(sourceRoot, 'builder', 'cgo_target.go');
		const helper = await readFile(helperPath, 'utf8');
		assert.equal((helper.match(/^package builder$/gmu) ?? []).length, 1);
		assert.match(await readFile(path.join(sourceRoot, 'builder', 'build.go'), 'utf8'),
			/normalizeCGoHeaderTarget\(mod, headerMod\)[\s\S]*?llvm\.LinkModules\(mod, headerMod\)/u);
		const copiedHelper = path.join(output, 'normalization.go');
		await writeFile(copiedHelper, helper.replace(/^package builder$/mu, 'package main'));
		const fixture = path.join(producerRoot, 'fixtures', 'cgo-module-link');
		const main = path.join(output, 'main.go');
		await writeFile(main, await readFile(path.join(fixture, 'main.go')));
		const library = await realpath(nativeLlvmLibrary);
		// WASI SDK's Clang contains only the WebAssembly backend. The tiny
		// native C bridge uses the runner's host compiler and the SDK's real
		// LLVM shared library; it does not compile LLVM itself.
		let nativeCc;
		for (const directory of (environment.PATH ?? process.env.PATH ?? '').split(path.delimiter)) {
			const candidate = path.join(directory, 'cc');
			if (await access(candidate, 1).then(() => true, () => false)) {
				nativeCc = await realpath(candidate);
				break;
			}
		}
		assert(nativeCc, 'native CGo module-link preflight requires a host cc compiler');
		receipt.helper = await identity(helperPath);
		receipt.executedHelper = await identity(copiedHelper);
		receipt.helperTransformation = 'Only package builder is renamed to package main; function and interface bytes are unchanged';
		receipt.nativeLlvmLibrary = await identity(library);
		receipt.nativeCc = await identity(nativeCc);
		receipt.fixture = await identity(path.join(fixture, 'main.go'));
		receipt.cHeader = await identity(path.join(fixture, 'header.c'));
		const env = {
			...environment,
			GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '1', GO111MODULE: 'off',
			GOWORK: 'off', GOENV: 'off', GOFLAGS: '', GOTOOLCHAIN: 'local',
			GOROOT: goRoot, GOMAXPROCS: '1', GOCACHE: path.join(output, 'go-cache'),
			CC: JSON.stringify(nativeCc),
			CGO_CFLAGS: '', CGO_CPPFLAGS: '', CGO_CXXFLAGS: '',
			CGO_LDFLAGS: JSON.stringify(library),
			LD_LIBRARY_PATH: path.dirname(library)
		};
		delete env.GOEXPERIMENT;
		const bitcode = path.join(output, 'header.bc');
		const executable = path.join(output, 'module-link-probe');
		async function phase(name, command, args, { baseline = false, timeoutMs = 120000 } = {}) {
			const stdoutPath = path.join(output, `${name}.stdout`);
			const stderrPath = path.join(output, `${name}.stderr`);
			const result = await run(command, args, { cwd: output, env, stdoutPath, stderrPath, timeoutMs });
			const stdout = await readFile(stdoutPath, 'utf8');
			const stderr = await readFile(stderrPath, 'utf8');
			receipt.commands.push({ name, command: [command, ...args], ...result,
				stdout: await identity(stdoutPath), stderr: await identity(stderrPath) });
			assert.equal(result.exitCode, 0, `CGo module-link ${name} failed: ${stderr.slice(-4000)}`);
			if (baseline) {
				assert.match(stderr, /Linking two modules of different target triples/u);
			} else {
				assert.equal(stderr, '', `CGo module-link ${name} emitted stderr: ${stderr.slice(-4000)}`);
			}
			return stdout;
		}
		receipt.nativeCcVersion = await phase('cc-version', nativeCc, ['--version']);
		await phase('clang', nativeTinyGo, [
			'clang', '--target=wasm32-unknown-wasip1', '-mcpu=generic',
			'-mbulk-memory', '-mnontrapping-fptoint', '-mno-multivalue',
			'-mno-reference-types', '-msign-ext', '-O1', '-c', '-emit-llvm',
			path.join(fixture, 'header.c'), '-o', bitcode
		]);
		await phase('compile', path.join(goRoot, 'bin', 'go'), [
			'build', '-o', executable, main, copiedHelper
		]);
		receipt.baseline = JSON.parse(await phase('baseline', executable,
			['baseline', bitcode, expectedDataLayout], { baseline: true, timeoutMs: 10000 }));
		receipt.execution = JSON.parse(await phase('normalize', executable,
			['normalize', bitcode, expectedDataLayout], { timeoutMs: 10000 }));
		assert.equal(receipt.execution.mode, 'normalize');
		assert.match(receipt.execution.llvmVersion, /^22\./u);
		assert.deepEqual(receipt.execution.cases.map((item) => item.case), REQUIRED_CASES);
		for (const [index, item] of receipt.execution.cases.entries()) {
			assert.equal(item.result, index < 4 ? 'linked-and-verified' : 'rejected-before-link');
			if (index < 4) assert.equal(item.globalValue, 42);
		}
		receipt.bitcode = await identity(bitcode);
		receipt.executable = await identity(executable);
		receipt.status = 'passed';
		return receipt;
	} catch (error) {
		receipt.status = 'failed';
		receipt.error = String(error);
		throw error;
	} finally {
		await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
	}
}
