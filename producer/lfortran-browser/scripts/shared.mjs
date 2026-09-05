import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(PRODUCER_ROOT, '../..');
export const OUTPUT_NAMES = ['lfortran.js', 'lfortran.wasm', 'lfortran.data'];
export const INPUT_FILES = [
	'sources.lock.json', 'manifest.json', 'patches/source-archive-and-bridge.patch',
	'src/CMakeLists.txt', 'src/compiler.cpp', 'scripts/producer.mjs',
	'scripts/shared.mjs', 'scripts/validate.mjs',
	'fixtures/read-array.f90', 'fixtures/module.f90', 'fixtures/invalid.f90'
];
export const VALIDATION_CASES = [
	{ name: 'read-array', fixture: 'read-array.f90', stdin: '3\n10 20 30\n', stdout: '60\n', exitCode: 0 },
	{ name: 'read-array-other-input', fixture: 'read-array.f90', stdin: '4\n-5 6 7 8\n', stdout: '16\n', exitCode: 0 },
	{ name: 'module', fixture: 'module.f90', stdin: '', stdout: '42\n', exitCode: 0 },
	{ name: 'invalid-source', fixture: 'invalid.f90', stdin: '', stdout: '', exitCode: 1 }
];

export async function exists(file) {
	return access(file).then(() => true, () => false);
}

export async function sha256(file) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(file)) hash.update(chunk);
	return hash.digest('hex');
}

export async function sourceTreeHash(directory) {
	const hash = createHash('sha256');
	async function visit(current, prefix) {
		const entries = await readdir(current, { withFileTypes: true });
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
			const file = path.join(current, entry.name);
			const name = `${prefix}${entry.name}`;
			if (entry.isDirectory()) await visit(file, `${name}/`);
			else if (entry.isSymbolicLink()) hash.update(`link\0${name}\0${await readlink(file)}\0`);
			else if (entry.isFile()) hash.update(`file\0${name}\0${await sha256(file)}\0`);
			else throw new Error(`Unexpected source entry: ${name}`);
		}
	}
	await visit(directory, '');
	return hash.digest('hex');
}

export async function assertSourceTree(directory, identity) {
	if (!identity?.treeSha256 || identity.treeSha256 !== await sourceTreeHash(directory)) {
		throw new Error('Cached LFortran source changed; remove the task source directory and prepare again');
	}
}

export function assertValidation(receipt) {
	const validation = receipt.validation;
	if (validation?.passed !== true || validation.engine !== 'node' ||
		validation.validatorSha256 !== receipt.inputs['scripts/validate.mjs'] ||
		validation.cases?.length !== VALIDATION_CASES.length) {
		throw new Error('Real Fortran evaluation has not passed with the current validator');
	}
	for (const [index, expected] of VALIDATION_CASES.entries()) {
		const actual = validation.cases[index];
		if (actual.name !== expected.name || actual.exitCode !== expected.exitCode || actual.stdout !== expected.stdout ||
			actual.sourceSha256 !== receipt.inputs[`fixtures/${expected.fixture}`] ||
			actual.stdinSha256 !== createHash('sha256').update(expected.stdin).digest('hex')) {
			throw new Error(`Fortran validation evidence differs: ${expected.name}`);
		}
		if (expected.exitCode === 0 && !['.o', '.wasm'].every((suffix) => actual.generated?.some((item) =>
			item.name.endsWith(suffix) && Number.isSafeInteger(item.size) && item.size > 8 && /^[a-f0-9]{64}$/.test(item.sha256)))) {
			throw new Error(`Fortran validation lacks generated LLVM outputs: ${expected.name}`);
		}
		if (expected.exitCode !== 0 && !actual.diagnostic?.includes('this_symbol_is_not_declared')) {
			throw new Error('Fortran validation lacks the upstream invalid-source diagnostic');
		}
	}
}

export async function readJson(file) {
	return JSON.parse(await readFile(file, 'utf8'));
}

export async function writeJson(file, value) {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(value, null, '\t')}\n`);
}

export async function inputHashes() {
	return Object.fromEntries(await Promise.all(INPUT_FILES.map(async (name) =>
		[name, await sha256(path.join(PRODUCER_ROOT, name))])));
}

export function validateLock(lock) {
	if (lock.schemaVersion !== 1 || lock.hostPlatform !== 'linux-x86_64') throw new Error('Unsupported source lock');
	for (const item of [lock.source, lock.emsdk, ...lock.packages, ...lock.sdkArchives]) {
		if (!/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size <= 0) {
			throw new Error('Every downloaded input needs a SHA-256 and byte size');
		}
		if (!item.url.startsWith('https://') || path.basename(item.archive) !== item.archive) {
			throw new Error('Invalid locked archive URL or filename');
		}
		if (item.repository && !/^[a-f0-9]{40}$/.test(item.commit)) throw new Error('Unpinned source commit');
	}
	const llvm = lock.packages.find((item) => item.name === 'llvm');
	if (!llvm || llvm.abi !== 'emscripten-4' || lock.emsdk.version !== '4.0.9') {
		throw new Error('The upstream LLVM archive requires the pinned Emscripten 4 ABI');
	}
	return lock;
}

export function outputDirectory(value) {
	const out = path.resolve(value ?? path.join(REPO_ROOT, 'out/lfortran-browser'));
	const relative = path.relative(path.join(REPO_ROOT, 'out'), out);
	if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error('Writable output must be a task directory below this repository\'s out/');
	}
	return out;
}

export function run(command, args, { cwd, env = process.env, capture = false, timeoutMs } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
		let timedOut = false;
		const timer = timeoutMs && setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
		let stdout = '';
		let stderr = '';
		if (capture) {
			child.stdout.on('data', (chunk) => { stdout += chunk; });
			child.stderr.on('data', (chunk) => { stderr += chunk; });
		}
		child.on('error', (error) => { clearTimeout(timer); reject(error); });
		child.on('close', (code) => {
			clearTimeout(timer);
			if (timedOut) reject(new Error(`${path.basename(command)} exceeded ${timeoutMs} ms`));
			else if (code === 0) resolve(stdout.trim());
			else reject(new Error(`${path.basename(command)} exited ${code}${capture ? `: ${stderr.slice(-4000)}` : ''}`));
		});
	});
}

export async function assertInputsMatch(receipt) {
	const expected = await inputHashes();
	if (!receipt || JSON.stringify(receipt.inputs) !== JSON.stringify(expected)) {
		throw new Error('Receipt does not match the current source lock and producer inputs; rebuild required');
	}
}
