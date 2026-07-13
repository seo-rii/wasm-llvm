#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { packageSwiftRuntimeDist } from './package-runtime.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const RUNTIME_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const DEFAULT_DIST_DIR = path.join(RUNTIME_ROOT, 'dist');
const REQUIRED_RUNTIME_FILES = ['runner-worker.js', 'swiftc.wasm', 'swiftpm.wasm', 'sdk.tar.gz'];

async function pathStats(filePath) {
	return stat(filePath).catch(() => null);
}

async function hashFile(filePath) {
	return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

function assertSha256(value, optionName) {
	if (typeof value !== 'string' || !/^[a-f0-9]{64}$/iu.test(value)) {
		throw new Error(`${optionName} must be a 64-character SHA-256 hex digest`);
	}
	return value.toLowerCase();
}

function archiveExtensionFromUrl(inputUrl) {
	const pathname = new URL(inputUrl).pathname.toLowerCase();
	if (pathname.endsWith('.tar.gz')) return '.tar.gz';
	if (pathname.endsWith('.tgz')) return '.tgz';
	if (pathname.endsWith('.zip')) return '.zip';
	throw new Error(`Unsupported Swift runtime URL archive format: ${inputUrl}`);
}

function requestUrl(inputUrl, redirectCount = 0) {
	const parsed = new URL(inputUrl);
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new Error(`Swift runtime input URL must use http or https: ${inputUrl}`);
	}
	if (redirectCount > 5) {
		throw new Error(`Swift runtime input URL redirected too many times: ${inputUrl}`);
	}
	const getter = parsed.protocol === 'https:' ? httpsGet : httpGet;
	return new Promise((resolve, reject) => {
		const request = getter(parsed, (response) => {
			const statusCode = response.statusCode ?? 0;
			if (
				statusCode >= 300 &&
				statusCode < 400 &&
				typeof response.headers.location === 'string'
			) {
				response.resume();
				resolve(requestUrl(new URL(response.headers.location, parsed).href, redirectCount + 1));
				return;
			}
			if (statusCode < 200 || statusCode >= 300) {
				response.resume();
				reject(new Error(`Swift runtime input URL returned HTTP ${statusCode}: ${inputUrl}`));
				return;
			}
			resolve(response);
		});
		request.on('error', reject);
	});
}

async function downloadSwiftRuntimeArchive(inputUrl, expectedSha256) {
	const normalizedExpectedSha256 = assertSha256(expectedSha256, 'inputSha256');
	const tempDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-url-import-'));
	const archivePath = path.join(tempDir, `runtime${archiveExtensionFromUrl(inputUrl)}`);
	let keepTempDir = false;
	try {
		const response = await requestUrl(inputUrl);
		const hash = createHash('sha256');
		await new Promise((resolve, reject) => {
			const output = createWriteStream(archivePath);
			response.on('data', (chunk) => {
				hash.update(chunk);
			});
			response.on('error', reject);
			output.on('error', reject);
			output.on('finish', resolve);
			response.pipe(output);
		});
		const actualSha256 = hash.digest('hex');
		if (actualSha256 !== normalizedExpectedSha256) {
			throw new Error(
				`Swift runtime input URL sha256 mismatch: expected ${normalizedExpectedSha256}, got ${actualSha256}`
			);
		}
		keepTempDir = true;
		return {
			archivePath,
			cleanup: async () => {
				await rm(tempDir, { recursive: true, force: true });
			}
		};
	} finally {
		if (!keepTempDir) await rm(tempDir, { recursive: true, force: true });
	}
}

async function collectBundleFilePaths(bundleDir) {
	const entries = [];
	async function visit(dir) {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await visit(entryPath);
			} else if (entry.isFile()) {
				entries.push(path.relative(bundleDir, entryPath).split(path.sep).join('/'));
			}
		}
	}
	await visit(bundleDir);
	return entries.sort();
}

async function hashBundleTree(bundleDir) {
	const hash = createHash('sha256');
	for (const relativePath of await collectBundleFilePaths(bundleDir)) {
		const fileBytes = await readFile(path.join(bundleDir, relativePath));
		hash.update(`${relativePath}\0${fileBytes.byteLength}\0`);
		hash.update(fileBytes);
		hash.update('\0');
	}
	return hash.digest('hex');
}

async function createImportProvenance(inputPath, inputStats, sourceDir, { hashPath = inputPath } = {}) {
	const provenance = {
		inputPath,
		sourceDir,
		sourceTreeSha256: await hashBundleTree(sourceDir)
	};
	if (inputStats.isFile()) {
		provenance.inputSha256 = await hashFile(hashPath);
	}
	return provenance;
}

async function assertLocalArchiveSha256(inputPath, inputStats, expectedSha256) {
	if (expectedSha256 === undefined || expectedSha256 === null || expectedSha256 === '') return;
	if (!inputStats.isFile()) {
		throw new Error('inputSha256 can only be used with local archive files, inputUrl, or inputDescriptor archives');
	}
	const normalizedExpectedSha256 = assertSha256(expectedSha256, 'inputSha256');
	const actualSha256 = await hashFile(inputPath);
	if (actualSha256 !== normalizedExpectedSha256) {
		throw new Error(
			`Swift runtime input archive sha256 mismatch: expected ${normalizedExpectedSha256}, got ${actualSha256}`
		);
	}
}

function appendImportProvenanceNotes(notes, provenance) {
	const provenanceParts = [
		`import-input=${provenance.inputPath}`,
		...(provenance.inputSha256 ? [`import-input-sha256=${provenance.inputSha256}`] : []),
		`import-source-tree-sha256=${provenance.sourceTreeSha256}`
	];
	return [notes, provenanceParts.join('; ')].filter(Boolean).join('\n');
}

async function hasRuntimeFile(candidateDir, relativePath) {
	const directStats = await pathStats(path.join(candidateDir, relativePath));
	if (directStats?.isFile()) return true;
	if (relativePath.endsWith('.wasm')) {
		const compressedStats = await pathStats(path.join(candidateDir, `${relativePath}.gz`));
		return !!compressedStats?.isFile();
	}
	return false;
}

async function isRuntimeBundleDir(candidateDir) {
	const candidateStats = await pathStats(candidateDir);
	if (!candidateStats?.isDirectory()) return false;
	for (const relativePath of REQUIRED_RUNTIME_FILES) {
		if (!(await hasRuntimeFile(candidateDir, relativePath))) return false;
	}
	return true;
}

async function findRuntimeBundleDir(unpackedDir) {
	if (await isRuntimeBundleDir(unpackedDir)) return unpackedDir;
	const entries = await readdir(unpackedDir, { withFileTypes: true });
	const candidates = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const candidateDir = path.join(unpackedDir, entry.name);
		if (await isRuntimeBundleDir(candidateDir)) candidates.push(candidateDir);
	}
	if (candidates.length === 1) return candidates[0];
	if (candidates.length > 1) {
		throw new Error(
			`Swift runtime archive contains multiple bundle roots:\n${candidates.join('\n')}`
		);
	}
	throw new Error(
		`Swift runtime bundle root was not found in ${unpackedDir}. Required files: ${REQUIRED_RUNTIME_FILES.join(', ')}.`
	);
}

function runCommand(command, args, { cwd } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		let stderr = '';
		child.stderr.on('data', (chunk) => {
			stderr += chunk;
		});
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(
				new Error(
					`${command} ${args.join(' ')} failed with exit code ${code}${stderr ? `:\n${stderr}` : ''}`
				)
			);
		});
	});
}

async function unpackArchive(inputPath, destinationDir, commandRunner) {
	if (inputPath.endsWith('.tar.gz') || inputPath.endsWith('.tgz')) {
		await commandRunner('tar', ['-xzf', inputPath, '-C', destinationDir]);
		return;
	}
	if (inputPath.endsWith('.zip')) {
		await commandRunner('unzip', ['-q', inputPath, '-d', destinationDir]);
		return;
	}
	throw new Error(`Unsupported Swift runtime archive format: ${inputPath}`);
}

export async function resolveSwiftRuntimeImportSource(input, { commandRunner = runCommand } = {}) {
	const normalizedInput = path.resolve(input);
	const inputStats = await pathStats(normalizedInput);
	if (!inputStats) {
		throw new Error(`Swift runtime import input was not found: ${normalizedInput}`);
	}
	if (inputStats.isDirectory()) {
		return {
			inputPath: normalizedInput,
			inputStats,
			sourceDir: await findRuntimeBundleDir(normalizedInput),
			cleanup: async () => {}
		};
	}
	if (!inputStats.isFile()) {
		throw new Error(`Swift runtime import input must be a directory or archive: ${normalizedInput}`);
	}
	const tempDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-import-'));
	let keepTempDir = false;
	try {
		await unpackArchive(normalizedInput, tempDir, commandRunner);
		const sourceDir = await findRuntimeBundleDir(tempDir);
		keepTempDir = true;
		return {
			inputPath: normalizedInput,
			inputStats,
			sourceDir,
			cleanup: async () => {
				await rm(tempDir, { recursive: true, force: true });
			}
		};
	} finally {
		if (!keepTempDir) await rm(tempDir, { recursive: true, force: true });
	}
}

function readOptionValue(argv, index, optionName) {
	const value = argv[index + 1];
	if (typeof value !== 'string' || !value || value.startsWith('--')) {
		throw new Error(`${optionName} requires a value`);
	}
	return value;
}

export function parseImportRuntimeArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--') {
			continue;
		} else if (arg === '--help') {
			options.help = true;
		} else if (arg === '--input') {
			options.input = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--input-descriptor') {
			options.inputDescriptor = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--prefer-descriptor-archive-file') {
			options.preferDescriptorArchiveFile = true;
		} else if (arg === '--input-url') {
			options.inputUrl = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--input-sha256') {
			options.inputSha256 = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--dist-dir') {
			options.distDir = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--swift-version') {
			options.swiftVersion = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--wasm-sdk-id') {
			options.wasmSdkId = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--wasm-sdk-url') {
			options.wasmSdkUrl = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--wasm-sdk-checksum') {
			options.wasmSdkChecksum = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--official-wasm-sdk-provenance') {
			options.officialWasmSdkProvenance = true;
		} else if (arg === '--source') {
			options.source = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--notes') {
			options.notes = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--browser-contract') {
			options.runBrowserContract = true;
		} else if (arg === '--require-descriptor-metadata') {
			options.requireDescriptorMetadata = true;
		} else if (arg === '--timeout-ms') {
			options.timeoutMs = Number(readOptionValue(argv, index, arg));
			index += 1;
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	return options;
}

function usage() {
	return [
		'Usage: pnpm run import:runtime -- --input <dir|archive> --swift-version <version> --wasm-sdk-id <sdk_id> --source <provenance>',
		'       pnpm run import:runtime -- --input-url <url> --input-sha256 <sha256> --swift-version <version> --wasm-sdk-id <sdk_id> --source <provenance>',
		'       pnpm run import:runtime -- --input-descriptor <export.json> [--source <provenance>]',
		'',
		'Imports an externally built browser-hosted Swift runtime bundle, validates it, and writes runtime/swift/dist.',
		'Accepted inputs: a bundle directory, .tar.gz, .tgz, or .zip archive, an http(s) archive URL with SHA-256, or a wasm-swift export descriptor.',
		'The bundle root must contain runner-worker.js, swiftc.wasm or swiftc.wasm.gz, swiftpm.wasm or swiftpm.wasm.gz, and sdk.tar.gz.',
		'Use --require-descriptor-metadata with --input-descriptor to require fingerprint, runtimeContract, and files metadata.',
		'Use --prefer-descriptor-archive-file with --input-descriptor to read the sibling archiveFile even when the descriptor records a url.',
		'Metadata and --browser-contract are forwarded to package:runtime.'
	].join('\n');
}

function assertDescriptorString(value, fieldName) {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`Swift runtime export descriptor ${fieldName} is required`);
	}
	return value;
}

function assertDescriptorArchiveFile(archiveFile) {
	const value = assertDescriptorString(archiveFile, 'archiveFile');
	if (!/^[A-Za-z0-9._+-]+\.t(?:ar\.)?gz$/u.test(value) || value.includes('..')) {
		throw new Error('Swift runtime export descriptor archiveFile must be a safe .tar.gz or .tgz file name');
	}
	return value;
}

function applyDescriptorDefault(options, key, descriptorValue, fieldName) {
	if (options[key] === undefined) return descriptorValue;
	if (options[key] !== descriptorValue) {
		throw new Error(
			`Swift runtime export descriptor ${fieldName} ${descriptorValue} does not match --${fieldName.replace(/[A-Z]/gu, (char) => `-${char.toLowerCase()}`)} ${options[key]}`
		);
	}
	return options[key];
}

function normalizeDescriptorOptionalObject(value, fieldName) {
	if (value === undefined || value === null) return null;
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`Swift runtime export descriptor ${fieldName} must be an object when provided`);
	}
	return value;
}

function normalizeDescriptorOptionalFiles(value) {
	if (value === undefined || value === null) return null;
	if (!Array.isArray(value)) {
		throw new Error('Swift runtime export descriptor files must be an array when provided');
	}
	return value;
}

function normalizeDescriptorOptionalSha256(value, fieldName) {
	if (value === undefined || value === null) return null;
	return assertSha256(value, `descriptor ${fieldName}`);
}

async function assertDescriptorMatchesImportedRuntimeBuild(descriptor, sourceDir) {
	if (!descriptor?.runtimeBuildSha256) return;
	const runtimeBuildPath = path.join(sourceDir, 'runtime-build.json');
	const actualSha256 = await hashFile(runtimeBuildPath);
	if (descriptor.runtimeBuildSha256 !== actualSha256) {
		throw new Error(
			`Swift runtime export descriptor runtimeBuildSha256 ${descriptor.runtimeBuildSha256} does not match imported runtime-build.json ${actualSha256}`
		);
	}
}

function assertDescriptorMatchesImportedManifest(descriptor, manifest) {
	if (!descriptor) return;
	const errors = [];
	if (descriptor.fingerprint && descriptor.fingerprint !== manifest.fingerprint) {
		errors.push(
			`fingerprint ${descriptor.fingerprint} does not match imported manifest ${manifest.fingerprint}`
		);
	}
	if (
		descriptor.runtimeContract &&
		JSON.stringify(descriptor.runtimeContract) !== JSON.stringify(manifest.runtimeContract)
	) {
		errors.push('runtimeContract does not match imported manifest runtimeContract');
	}
	if (descriptor.files && JSON.stringify(descriptor.files) !== JSON.stringify(manifest.files)) {
		errors.push('files do not match imported manifest files');
	}
	if (errors.length > 0) {
		throw new Error(
			`Swift runtime export descriptor metadata does not match imported bundle:\n${errors.join('\n')}`
		);
	}
}

function assertDescriptorHasImportMetadata(descriptor) {
	if (!descriptor) {
		throw new Error('--require-descriptor-metadata requires --input-descriptor');
	}
	const missing = [];
	if (!descriptor.fingerprint) missing.push('fingerprint');
	if (!descriptor.runtimeContract) missing.push('runtimeContract');
	if (!descriptor.files) missing.push('files');
	if (!descriptor.runtimeBuildSha256) missing.push('runtimeBuildSha256');
	if (missing.length > 0) {
		throw new Error(
			`Swift runtime export descriptor is missing required metadata: ${missing.join(', ')}`
		);
	}
}

async function readSwiftRuntimeExportDescriptor(descriptorPath) {
	const normalizedDescriptorPath = path.resolve(descriptorPath);
	let descriptor;
	try {
		descriptor = JSON.parse(await readFile(normalizedDescriptorPath, 'utf8'));
	} catch (error) {
		throw new Error(
			`Swift runtime export descriptor could not be read from ${normalizedDescriptorPath}: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
	}
	if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
		throw new Error('Swift runtime export descriptor must be an object');
	}
	if (descriptor.format !== 'wasm-swift-runtime-export-v1') {
		throw new Error('Swift runtime export descriptor format must be wasm-swift-runtime-export-v1');
	}
	const archiveFile = assertDescriptorArchiveFile(descriptor.archiveFile);
	const archiveSha256 = assertSha256(descriptor.archiveSha256, 'descriptor archiveSha256');
	const swiftVersion = assertDescriptorString(descriptor.swiftVersion, 'swiftVersion');
	const wasmSdkId = assertDescriptorString(descriptor.wasmSdkId, 'wasmSdkId');
	const url = descriptor.url === null || descriptor.url === undefined ? null : assertDescriptorString(descriptor.url, 'url');
	const fingerprint =
		descriptor.fingerprint === undefined || descriptor.fingerprint === null
			? null
			: assertDescriptorString(descriptor.fingerprint, 'fingerprint');
	const runtimeContract = normalizeDescriptorOptionalObject(
		descriptor.runtimeContract,
		'runtimeContract'
	);
	const files = normalizeDescriptorOptionalFiles(descriptor.files);
	const runtimeBuildSha256 = normalizeDescriptorOptionalSha256(
		descriptor.runtimeBuildSha256,
		'runtimeBuildSha256'
	);
	const buildSource =
		typeof descriptor.buildSource === 'string' && descriptor.buildSource.trim()
			? descriptor.buildSource
			: `Swift runtime export descriptor ${normalizedDescriptorPath}`;
	if (url && !/^https?:\/\//u.test(url)) {
		throw new Error('Swift runtime export descriptor url must be http(s) when provided');
	}
	return {
		descriptorPath: normalizedDescriptorPath,
		archiveFile,
		archiveSha256,
		swiftVersion,
		wasmSdkId,
		url,
		fingerprint,
		runtimeContract,
		files,
		runtimeBuildSha256,
		buildSource,
		localArchivePath: path.join(path.dirname(normalizedDescriptorPath), archiveFile)
	};
}

export async function importSwiftRuntimeDist(options) {
	const explicitInputCount = [options.input, options.inputUrl, options.inputDescriptor].filter(
		(value) => typeof value === 'string' && value.trim()
	).length;
	if (explicitInputCount > 1) {
		throw new Error('use only one Swift runtime import input source');
	}
	if (
		options.preferDescriptorArchiveFile &&
		!(typeof options.inputDescriptor === 'string' && options.inputDescriptor.trim())
	) {
		throw new Error('--prefer-descriptor-archive-file requires --input-descriptor');
	}
	let descriptor = null;
	if (typeof options.inputDescriptor === 'string' && options.inputDescriptor.trim()) {
		descriptor = await readSwiftRuntimeExportDescriptor(options.inputDescriptor);
		const useDescriptorUrl = descriptor.url && !options.preferDescriptorArchiveFile;
		options = {
			...options,
			input: useDescriptorUrl ? undefined : descriptor.localArchivePath,
			inputUrl: useDescriptorUrl ? descriptor.url : undefined,
			inputSha256: descriptor.archiveSha256,
			swiftVersion: applyDescriptorDefault(
				options,
				'swiftVersion',
				descriptor.swiftVersion,
				'swiftVersion'
			),
			wasmSdkId: applyDescriptorDefault(options, 'wasmSdkId', descriptor.wasmSdkId, 'wasmSdkId'),
			source: options.source ?? descriptor.buildSource
		};
	}
	if (options.requireDescriptorMetadata) {
		assertDescriptorHasImportMetadata(descriptor);
	}
	const hasInput = typeof options.input === 'string' && options.input.trim();
	const hasInputUrl = typeof options.inputUrl === 'string' && options.inputUrl.trim();
	if (!hasInput && !hasInputUrl) {
		throw new Error('input, inputUrl, or inputDescriptor is required');
	}
	let downloaded = null;
	const input = hasInput ? options.input : options.inputUrl;
	if (hasInputUrl) {
		if (typeof options.inputSha256 !== 'string' || !options.inputSha256.trim()) {
			throw new Error('inputSha256 is required when inputUrl is used');
		}
		downloaded = await downloadSwiftRuntimeArchive(options.inputUrl, options.inputSha256);
	}
	let imported = null;
	try {
		imported = await resolveSwiftRuntimeImportSource(downloaded?.archivePath ?? input);
		if (hasInput) {
			await assertLocalArchiveSha256(imported.inputPath, imported.inputStats, options.inputSha256);
		}
		await assertDescriptorMatchesImportedRuntimeBuild(descriptor, imported.sourceDir);
		const importProvenance = await createImportProvenance(
			descriptor?.descriptorPath ?? (hasInputUrl ? options.inputUrl : imported.inputPath),
			imported.inputStats,
			imported.sourceDir,
			{ hashPath: imported.inputPath }
		);
		const packaged = await packageSwiftRuntimeDist({
			...options,
			sourceDir: imported.sourceDir,
			distDir: options.distDir ?? DEFAULT_DIST_DIR,
			notes: appendImportProvenanceNotes(
				descriptor
					? [options.notes, `import-descriptor=${descriptor.descriptorPath}`]
							.filter(Boolean)
							.join('\n')
					: options.notes,
				importProvenance
			)
		});
		assertDescriptorMatchesImportedManifest(descriptor, packaged.manifest);
		return packaged;
	} finally {
		await imported?.cleanup();
		await downloaded?.cleanup();
	}
}

async function main(argv = process.argv.slice(2)) {
	const options = parseImportRuntimeArgs(argv);
	if (options.help) {
		console.log(usage());
		return;
	}
	const result = await importSwiftRuntimeDist(options);
	console.log(`Imported wasm-swift runtime dist at ${result.distDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
