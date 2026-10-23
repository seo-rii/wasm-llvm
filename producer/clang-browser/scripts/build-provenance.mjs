import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function fileIdentity(file) {
	const hash = createHash('sha256');
	let bytes = 0;
	for await (const chunk of createReadStream(file)) {
		bytes += chunk.length;
		hash.update(chunk);
	}
	return { bytes, sha256: hash.digest('hex') };
}

export async function assertFileUnchanged(file, expected, label) {
	const current = await fileIdentity(file);
	if (current.bytes !== expected.bytes || current.sha256 !== expected.sha256)
		throw new Error(`${label} changed during compilation`);
}

export async function claimFreshBuildDirectory(directory) {
	await fs.mkdir(directory, { recursive: true });
	if (!(await fs.lstat(directory)).isDirectory() || (await fs.readdir(directory)).length !== 0)
		throw new Error(`Verified builds require a fresh empty build directory: ${directory}`);
	// Exclusive creation prevents two producers from sharing the initially empty output.
	try {
		await fs.writeFile(path.join(directory, '.fresh-build-claim'), `${randomUUID()}\n`, { flag: 'wx' });
	} catch (error) {
		if (error.code === 'EEXIST') throw new Error(`Build directory is already claimed: ${directory}`);
		throw error;
	}
}

export async function directoryIdentity(directory) {
	const root = await fs.realpath(directory);
	const hash = createHash('sha256');
	let bytes = 0;
	let entries = 0;
	async function visit(relative) {
		const absolute = path.join(root, relative);
		const stat = await fs.lstat(absolute);
		let item;
		if (stat.isSymbolicLink()) {
			const resolved = await fs.realpath(absolute);
			const targetRelative = path.relative(root, resolved);
			if (targetRelative === '..' || targetRelative.startsWith(`..${path.sep}`) || path.isAbsolute(targetRelative))
				throw new Error(`SDK symlink escapes its recorded tree: ${relative}`);
			item = [relative, 'symlink', await fs.readlink(absolute)];
		} else if (stat.isFile()) {
			const identity = await fileIdentity(absolute);
			bytes += identity.bytes;
			item = [relative, 'file', stat.mode & 0o777, identity.bytes, identity.sha256];
		} else if (stat.isDirectory()) {
			item = [relative, 'directory', stat.mode & 0o777];
		} else throw new Error(`Unsupported SDK input: ${relative}`);
		hash.update(`${JSON.stringify(item)}\n`);
		entries += 1;
		if (stat.isDirectory()) {
			for (const name of (await fs.readdir(absolute)).sort()) await visit(relative ? `${relative}/${name}` : name);
		}
	}
	await visit('');
	return { bytes, entries, sha256: hash.digest('hex') };
}

export async function assertDirectoryUnchanged(directory, expected, label) {
	const current = await directoryIdentity(directory);
	if (current.bytes !== expected.bytes || current.entries !== expected.entries || current.sha256 !== expected.sha256)
		throw new Error(`${label} changed during compilation`);
}

export async function downloadPinned(url, target, expectedSha256, { fetchImpl = fetch } = {}) {
	if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('Download requires a SHA-256 pin');
	try {
		if ((await fileIdentity(target)).sha256 === expectedSha256) return;
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
	await fs.mkdir(path.dirname(target), { recursive: true });
	const temporary = `${target}.${randomUUID()}.partial`;
	try {
		const response = await fetchImpl(url);
		if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
		await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
		if ((await fileIdentity(temporary)).sha256 !== expectedSha256) throw new Error('Downloaded archive SHA-256 mismatch');
		await fs.rename(temporary, target);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

export async function extractPinnedArchive(archive, destination, expectedSha256, run) {
	if ((await fileIdentity(archive)).sha256 !== expectedSha256) throw new Error('Archive SHA-256 mismatch before extraction');
	const marker = path.join(destination, '.archive-sha256');
	if ((await fs.readFile(marker, 'utf8').catch(() => '')).trim() === expectedSha256) return;
	// A digest-specific directory is never silently trusted because it happens to exist.
	if (await fs.stat(destination).catch(() => null)) throw new Error(`Incomplete extraction cache: ${destination}; remove it before retrying`);
	await fs.mkdir(path.dirname(destination), { recursive: true });
	const staging = await fs.mkdtemp(`${destination}.staging-`);
	try {
		await run('tar', ['-xzf', archive, '-C', staging]);
		await fs.writeFile(path.join(staging, '.archive-sha256'), `${expectedSha256}\n`);
		await fs.rename(staging, destination);
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}
}

async function git(source, args, { env, raw = false } = {}) {
	const result = await execFileAsync('git', ['-C', source, ...args], {
		env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8'
	});
	return raw ? result.stdout : result.stdout.trimEnd();
}

export async function pinnedCommitPatch(source, repository, commit, marker) {
	if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Patch requires a full commit pin');
	try { await git(source, ['cat-file', '-e', `${commit}^`]); }
	catch { await git(source, ['fetch', '--depth', '2', repository, commit]); }
	const patch = await git(source, ['diff', '--binary', '--full-index', `${commit}^`, commit], { raw: true });
	const identity = { repository, commit, sha256: sha256(patch) };
	const previous = await fs.readFile(marker, 'utf8').catch((error) => {
		if (error.code === 'ENOENT') return '';
		throw error;
	});
	if (previous) {
		const legacy = `${repository}\n${commit}\n`;
		if (previous !== legacy && previous !== `${JSON.stringify(identity)}\n`) {
			throw new Error('YoWASP patch marker does not match the pinned repository, commit and digest');
		}
	} else {
		await git(source, ['cherry-pick', '--no-commit', commit]);
	}
	// Actual application is independently checked against the expected tree below.
	return { patch, identity, marker };
}

export function addWasiSignalStub(source) {
	const signature = 'void llvm::sys::PrintStackTraceOnErrorSignal(StringRef Argv0,';
	if (source.includes(signature)) return source;
	const block = [
		'void llvm::sys::AddSignalHandler(sys::SignalHandlerCallback FnPtr,',
		'                                 void *Cookie) {}',
		'void llvm::sys::RunInterruptHandlers() {}'
	].join('\n');
	if (!source.includes(block)) throw new Error('YoWASP signal stub insertion point is missing');
	return source.replace(block, `${block}\n${signature}\n                                           bool DisableCrashReporting) {}`);
}

export async function verifyPatchedCheckout({ source, commit, patches = [], transforms = [], allowedUntracked = [], allowIgnored = false }) {
	const head = await git(source, ['rev-parse', 'HEAD']);
	if (head !== commit) throw new Error(`Source checkout commit mismatch: expected ${commit}, got ${head}`);
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'clang-source-index-'));
	const env = { GIT_INDEX_FILE: path.join(temporary, 'index') };
	try {
		await git(source, ['read-tree', commit], { env });
		for (let index = 0; index < patches.length; index += 1) {
			const patchPath = path.join(temporary, `patch-${index}`);
			await fs.writeFile(patchPath, patches[index]);
			await git(source, ['apply', '--cached', '--3way', patchPath], { env });
		}
		for (const { file, transform } of transforms) {
			const original = await git(source, ['show', `:${file}`], { env, raw: true });
			const changed = transform(original);
			const blobPath = path.join(temporary, 'transformed');
			await fs.writeFile(blobPath, changed);
			const blob = await git(source, ['hash-object', '-w', blobPath]);
			await git(source, ['update-index', '--cacheinfo', `100644,${blob},${file}`], { env });
		}
		const expectedTree = await git(source, ['write-tree'], { env });
		// Only the temporary index is changed. The checkout and its real staging area are preserved.
		await git(source, ['add', '-u', '--', '.'], { env });
		const actualTree = await git(source, ['write-tree'], { env });
		if (actualTree !== expectedTree) throw new Error('Source checkout differs from the pinned commit and expected patches');
		const untracked = (await git(source, ['ls-files', '--others', ...(allowIgnored ? ['--exclude-standard'] : []), '-z'], { env }))
			.split('\0').filter(Boolean).filter((file) => !allowedUntracked.includes(file));
		if (untracked.length) throw new Error(`Unexpected source files: ${untracked.join(', ')}`);
		const diff = await git(source, ['diff', '--binary', '--full-index', commit, expectedTree], { raw: true });
		return { commit, tree: expectedTree, diffSha256: sha256(diff) };
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
}

export async function verifyClangBuildReceipt(receipt, inputs, { producerRoot = fileURLToPath(new URL('../', import.meta.url)) } = {}) {
	const fail = (message) => { throw new Error(`Clang build receipt: ${message}`); };
	const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
	const identity = (value) => value && Number.isSafeInteger(value.bytes) && value.bytes > 0 && digest(value.sha256);
	if (receipt?.schemaVersion !== 1 || receipt.producerId !== 'wasm-llvm/clang-browser' || receipt.kind !== 'clang-build-receipt') fail('unsupported schema or producer');
	if (!digest(receipt.manifestSha256)) fail('invalid manifest identity');
	const manifest = JSON.parse(await fs.readFile(path.join(producerRoot, 'manifest.json'), 'utf8'));
	if (receipt.sources?.llvm?.repository !== manifest.sources.llvm.repository ||
		receipt.sources?.emsdk?.repository !== 'https://github.com/emscripten-core/emsdk') fail('unexpected source repository');
	const expectedPatches = [manifest.sources.llvmWasiClosePatch, manifest.sources.lldWasmOnlyPatch,
		manifest.sources.clangdEmscriptenStdinPatch];
	const patches = receipt.sources?.llvm?.patches;
	if (!Array.isArray(patches) || patches.length !== 4 || !digest(patches[0]?.sha256) ||
		patches[0]?.repository !== receipt.buildOptions?.yowaspWasiPatchRepo ||
		patches[0]?.commit !== receipt.buildOptions?.yowaspWasiPatchCommit ||
		!/^[a-f0-9]{40}$/.test(patches[0]?.commit)) fail('incomplete YoWASP patch identity');
	for (const [index, patch] of expectedPatches.entries()) {
		if (patches[index + 1]?.path !== patch.path || patches[index + 1]?.sha256 !== patch.sha256) fail('local patch identity mismatch');
	}

	const inputNames = ['clang', 'lld', 'memfs', 'memfsReceipt', 'sysroot', 'clangdJs', 'clangdWasm'];
	if (receipt.buildOptions?.clangdSeparateHeaders === 'ON') inputNames.push('clangdHeaders');
	else if (receipt.buildOptions?.clangdSeparateHeaders !== 'OFF' || inputs.clangdHeaders || receipt.inputs?.clangdHeaders)
		fail('separate header inputs do not match build options');
	for (const name of inputNames) {
		const expected = receipt.inputs?.[name];
		const bytes = inputs[name];
		if (!identity(expected) || !bytes || expected.bytes !== bytes.length || expected.sha256 !== sha256(bytes)) fail(`${name} input identity mismatch`);
	}
	for (const name of ['llvm', 'emsdk']) {
		const source = receipt.sources?.[name];
		if (!source || !/^[a-f0-9]{40}$/.test(source.commit) || !/^[a-f0-9]{40}$/.test(source.tree) || !digest(source.diffSha256)) fail(`${name} source identity is incomplete`);
		if (source.commit !== receipt.buildOptions?.[`${name}Commit`]) fail(`${name} source commit differs from build options`);
	}
	for (const field of ['llvmVersion', 'wasiSdkVersion', 'emsdkVersion']) {
		if (typeof receipt.buildOptions?.[field] !== 'string' || !receipt.buildOptions[field]) fail(`missing ${field}`);
	}
	if (receipt.buildMode !== 'fresh-output-directory') fail('reused build outputs are not qualified');
	for (const name of ['wasiSdk', 'emsdkUpstream']) {
		const tree = receipt.installedToolchains?.[name];
		if (!identity(tree) || !Number.isSafeInteger(tree.entries) || tree.entries <= 0) fail(`missing ${name} installed tree identity`);
	}
	for (const name of ['cmake', 'ninja', 'tar', 'wasiClang', 'wasiClangxx', 'wasiAr', 'wasiRanlib', 'wasiLld', 'nativeC', 'nativeCxx',
		'llvmTablegen', 'clangTablegen', 'emsdkClang', 'wasmOpt', 'emccDriver']) {
		if (!identity(receipt.tools?.[name])) fail(`missing ${name} executable identity`);
	}
	const recipeFiles = ['build-toolchain.mjs', 'build-provenance.mjs', 'build-memfs.mjs',
		'prepare-clangd-headers.mjs', 'sysroot-pruning.mjs', 'gcc-compat.mjs', 'hot-path-launcher.sh',
		'resource-profile.mjs'];
	if (!Array.isArray(receipt.recipe?.files) || receipt.recipe.files.length !== recipeFiles.length ||
		receipt.recipe.sha256 !== sha256(JSON.stringify(receipt.recipe.files))) fail('invalid recipe identity');
	for (const [index, file] of recipeFiles.entries()) {
		const entry = receipt.recipe.files[index];
		if (entry?.path !== `scripts/${file}` || !identity(entry)) fail('unexpected recipe file set');
		if (producerRoot && (await fileIdentity(path.join(producerRoot, entry.path))).sha256 !== entry.sha256) fail(`recipe mismatch: ${file}`);
	}
	if (producerRoot && (await fileIdentity(path.join(producerRoot, 'manifest.json'))).sha256 !== receipt.manifestSha256) fail('producer manifest mismatch');
	return receipt;
}
