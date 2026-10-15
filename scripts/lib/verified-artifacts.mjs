import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export function artifactPath(value) {
	if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') ||
		path.posix.isAbsolute(value) || value === '.' || path.posix.normalize(value) !== value ||
		value.split('/').some((part) => part === '..' || part === '.')) {
		throw new Error(`Invalid artifact path: ${String(value)}`);
	}
	return value;
}

export function assertReceipt(bytes, expected, label) {
	if (!expected || !Number.isSafeInteger(expected.bytes) || expected.bytes <= 0 ||
		!/^[a-f0-9]{64}$/u.test(expected.sha256 ?? '') ||
		bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256) {
		throw new Error(`${label} does not match its pinned size and SHA-256`);
	}
}

export async function readRegular(root, relativePath, maxBytes = 128 * 1024 * 1024) {
	artifactPath(relativePath);
	maxBytes = Math.min(maxBytes, 128 * 1024 * 1024);
	const rootPath = path.resolve(root);
	if (!(await lstat(rootPath)).isDirectory()) throw new Error(`Artifact root is not a directory: ${rootPath}`);
	let current = rootPath;
	const parts = relativePath.split('/');
	for (const [index, part] of parts.entries()) {
		current = path.join(current, part);
		const stats = await lstat(current);
		if (index < parts.length - 1 ? !stats.isDirectory() : !stats.isFile()) {
			throw new Error(`Artifact path is not a regular file or directory: ${relativePath}`);
		}
	}
	const handle = await open(current, 'r');
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.size <= 0 || before.size > maxBytes) {
			throw new Error(`Artifact is empty or exceeds its byte limit: ${relativePath}`);
		}
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (bytes.byteLength !== before.size || after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
			throw new Error(`Artifact changed while it was read: ${relativePath}`);
		}
		return bytes;
	} finally {
		await handle.close();
	}
}

export async function readVerified(root, relativePath, expected) {
	const bytes = await readRegular(root, relativePath, expected.bytes);
	assertReceipt(bytes, expected, relativePath);
	return bytes;
}

export async function listRegularFiles(root, relative = '') {
	const result = [];
	for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
		const name = relative ? `${relative}/${entry.name}` : entry.name;
		artifactPath(name);
		if (entry.isDirectory()) result.push(...await listRegularFiles(root, name));
		else if (entry.isFile()) result.push(name);
		else throw new Error(`Artifact tree contains a non-regular path: ${name}`);
	}
	return result.sort();
}

export function describeArtifact(relativePath, bytes, compression) {
	const receipt = { path: artifactPath(relativePath), bytes: bytes.byteLength, sha256: sha256(bytes) };
	if (compression === 'gzip') {
		const logical = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
		if (!logical.byteLength) throw new Error(`Empty logical artifact: ${relativePath}`);
		receipt.uncompressedBytes = logical.byteLength;
		receipt.uncompressedSha256 = sha256(logical);
	}
	return receipt;
}

export async function verifyArtifactDirectory(directory, identity, expectedArtifacts) {
	const receipt = JSON.parse(await readRegular(directory, 'producer-receipt.json', 1024 * 1024));
	for (const [key, value] of Object.entries(identity)) {
		if (receipt[key] !== value) throw new Error(`Producer receipt ${key} does not match its contract`);
	}
	if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length !== expectedArtifacts.length) {
		throw new Error('Producer receipt has an invalid artifact set');
	}
	const expectedPaths = expectedArtifacts.map((entry) => entry.path).sort();
	const receiptPaths = receipt.artifacts.map((entry) => artifactPath(entry.path)).sort();
	if (JSON.stringify(receiptPaths) !== JSON.stringify(expectedPaths) ||
		JSON.stringify(await listRegularFiles(directory)) !== JSON.stringify([...expectedPaths, 'producer-receipt.json'].sort())) {
		throw new Error('Producer artifact file set differs from its contract');
	}
	for (const expected of expectedArtifacts) {
		const actual = receipt.artifacts.find((entry) => entry.path === expected.path);
		for (const key of ['bytes', 'sha256', 'uncompressedBytes', 'uncompressedSha256']) {
			if (expected[key] !== undefined && actual[key] !== expected[key]) {
				throw new Error(`Producer artifact ${expected.path} ${key} does not match its contract`);
			}
		}
		const bytes = await readVerified(directory, expected.path, actual);
		if (actual.uncompressedBytes !== undefined || actual.uncompressedSha256 !== undefined) {
			if (!Number.isSafeInteger(actual.uncompressedBytes) || actual.uncompressedBytes <= 0 || actual.uncompressedBytes > 128 * 1024 * 1024) {
				throw new Error(`Invalid uncompressed byte limit: ${expected.path}`);
			}
			const decoded = gunzipSync(bytes, { maxOutputLength: actual.uncompressedBytes });
			assertReceipt(decoded, { bytes: actual.uncompressedBytes, sha256: actual.uncompressedSha256 }, expected.path);
		}
	}
	return receipt;
}

// Publish a new directory only. A failed or concurrent invocation never replaces an existing release.
export async function publishArtifacts(outputDir, inputDirs, build) {
	const output = path.resolve(outputDir);
	if (output === path.parse(output).root) throw new Error('Artifact output must not be a filesystem root');
	await mkdir(path.dirname(output), { recursive: true });
	const canonicalOutput = path.join(await realpath(path.dirname(output)), path.basename(output));
	for (const inputDir of inputDirs) {
		const input = await realpath(inputDir);
		if (canonicalOutput === input || canonicalOutput.startsWith(`${input}${path.sep}`) || input.startsWith(`${canonicalOutput}${path.sep}`)) {
			throw new Error('Artifact output must not overlap its inputs');
		}
	}
	if (await lstat(output).catch(() => null)) throw new Error(`Artifact output already exists: ${output}`);
	const lockPath = `${output}.producer-lock`;
	const lock = await open(lockPath, 'wx', 0o600);
	const temporary = `${output}.staging-${randomUUID()}`;
	try {
		if (await lstat(output).catch(() => null)) throw new Error(`Artifact output already exists: ${output}`);
		await mkdir(temporary, { mode: 0o700 });
		const result = await build(temporary);
		if (await lstat(output).catch(() => null)) throw new Error(`Artifact output already exists: ${output}`);
		await rename(temporary, output);
		return result;
	} finally {
		await rm(temporary, { recursive: true, force: true });
		await lock.close();
		await rm(lockPath);
	}
}

export async function writeArtifact(root, relativePath, bytes) {
	const destination = path.join(root, artifactPath(relativePath));
	await mkdir(path.dirname(destination), { recursive: true });
	await writeFile(destination, bytes);
}
