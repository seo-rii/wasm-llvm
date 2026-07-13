import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
	importSwiftRuntimeDist,
	parseImportRuntimeArgs,
	resolveSwiftRuntimeImportSource
} from './import-runtime.mjs';
import {
	buildFileEntries,
	createSwiftRuntimeManifest,
	fingerprintFileEntries
} from './runtime-manifest.mjs';
import { createSwiftRuntimeBuildInfo } from './runtime-build-info.mjs';

const VALID_RUNNER_WORKER_SOURCE = `
self.onmessage = async (event) => {
	const {
		run,
		baseUrl,
		manifestUrl,
		code,
		stdin,
		args = [],
		activePath,
		workspaceFiles = []
	} = event.data || {};
	self.postMessage({ progress: { percent: 1, stage: 'Loading Swift' } });
	if (!run || !baseUrl || !manifestUrl || !code || !activePath) {
		self.postMessage({ error: 'invalid Swift run message' });
		return;
	}
	const manifest = await (await fetch(manifestUrl)).json();
	const swiftcUrl = new URL('swiftc.wasm', baseUrl).href;
	const swiftpmUrl = new URL('swiftpm.wasm', baseUrl).href;
	const sdkUrl = new URL('sdk.tar.gz', baseUrl).href;
	if (stdin || args.length || workspaceFiles.length) {
		self.postMessage({ output: [manifest.runtime, swiftcUrl, swiftpmUrl, sdkUrl].join('\\n').slice(0, 0) });
	}
	self.postMessage({ results: true });
};
`;

const VALID_SDK_ARCHIVE_BYTES = Uint8Array.from(gzipSync(Uint8Array.of(115, 100, 107)));

function taggedWasm(tag) {
	const sectionName = Buffer.from('wasm-idle-test', 'utf8');
	const tagBytes = Buffer.from(tag, 'utf8');
	return Uint8Array.of(
		0,
		97,
		115,
		109,
		1,
		0,
		0,
		0,
		0,
		1 + sectionName.byteLength + tagBytes.byteLength,
		sectionName.byteLength,
		...sectionName,
		...tagBytes
	);
}

async function writeFileEnsuringDir(filePath, contents) {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, contents);
}

async function writeValidSourceBundle(sourceDir) {
	await writeFileEnsuringDir(path.join(sourceDir, 'runner-worker.js'), VALID_RUNNER_WORKER_SOURCE);
	await writeFileEnsuringDir(
		path.join(sourceDir, 'swiftc.wasm'),
		taggedWasm('swiftc Swift compiler')
	);
	await writeFileEnsuringDir(path.join(sourceDir, 'swiftpm.wasm'), taggedWasm('swiftpm SwiftPM'));
	await writeFileEnsuringDir(path.join(sourceDir, 'sdk.tar.gz'), VALID_SDK_ARCHIVE_BYTES);
	await writeFileEnsuringDir(
		path.join(sourceDir, 'runtime-build.json'),
		`${JSON.stringify(
			createSwiftRuntimeBuildInfo({
				swiftVersion: '6.3.3',
				wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
				source: 'unit test import source'
			}),
			null,
			2
		)}\n`
	);
	await writeFileEnsuringDir(path.join(sourceDir, 'SOURCE.txt'), 'external CI bundle\n');
}

async function createTarGz(sourceDir, archivePath) {
	await new Promise((resolve, reject) => {
		const child = spawn('tar', [
			'-czf',
			archivePath,
			'-C',
			path.dirname(sourceDir),
			path.basename(sourceDir)
		]);
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`tar failed with exit code ${code}`));
		});
	});
}

async function sha256File(filePath) {
	return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function createDescriptorMetadata(sourceDir) {
	const files = await buildFileEntries(sourceDir);
	const fingerprint = fingerprintFileEntries(files);
	const manifest = createSwiftRuntimeManifest({
		files,
		swiftVersion: '6.3.3',
		wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
		fingerprint
	});
	return {
		fingerprint,
		runtimeContract: manifest.runtimeContract,
		files,
		runtimeBuildSha256: await sha256File(path.join(sourceDir, 'runtime-build.json'))
	};
}

async function serveFile(filePath) {
	const server = createServer(async (_request, response) => {
		try {
			response.writeHead(200, { 'content-type': 'application/gzip' });
			response.end(await readFile(filePath));
		} catch (error) {
			response.writeHead(500, { 'content-type': 'text/plain' });
			response.end(error instanceof Error ? error.message : String(error));
		}
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	return {
		url: `http://127.0.0.1:${server.address().port}/bundle.tar.gz`,
		close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
	};
}

test('parses Swift runtime import URL arguments', () => {
	assert.deepEqual(
		parseImportRuntimeArgs([
			'--input-url',
			'https://example.test/bundle.tar.gz',
			'--input-sha256',
			'0'.repeat(64),
			'--swift-version',
			'6.3.3',
			'--wasm-sdk-id',
			'swift-6.3.3-RELEASE_wasm',
			'--source',
			'remote CI'
		]),
		{
			inputUrl: 'https://example.test/bundle.tar.gz',
			inputSha256: '0'.repeat(64),
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			source: 'remote CI'
		}
	);
	assert.equal(
		parseImportRuntimeArgs(['--input-descriptor', 'wasm-swift.tar.gz.json']).inputDescriptor,
		'wasm-swift.tar.gz.json'
	);
	assert.equal(
		parseImportRuntimeArgs([
			'--input-descriptor',
			'wasm-swift.tar.gz.json',
			'--prefer-descriptor-archive-file'
		]).preferDescriptorArchiveFile,
		true
	);
	assert.equal(
		parseImportRuntimeArgs(['--input-descriptor', 'wasm-swift.tar.gz.json', '--require-descriptor-metadata'])
			.requireDescriptorMetadata,
		true
	);
});

test('imports a Swift runtime bundle directory through the package validator', async () => {
	const sourceDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-import-source-'));
	const distDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-import-dist-'));
	try {
		await writeValidSourceBundle(sourceDir);
		const result = await importSwiftRuntimeDist({
			input: sourceDir,
			distDir,
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			source: 'external directory unit test'
		});

		assert.equal(result.sourceDir, sourceDir);
		assert.equal(result.distDir, distDir);
		assert.equal(await readFile(path.join(distDir, 'SOURCE.txt'), 'utf8'), 'external CI bundle\n');
		assert.equal(
			JSON.parse(await readFile(path.join(distDir, 'runtime-build.json'), 'utf8')).source,
			'external directory unit test'
		);
		const buildInfo = JSON.parse(await readFile(path.join(distDir, 'runtime-build.json'), 'utf8'));
		assert.match(buildInfo.notes, new RegExp(`import-input=${sourceDir.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'));
		assert.doesNotMatch(buildInfo.notes, /import-input-sha256/u);
		assert.match(buildInfo.notes, /import-source-tree-sha256=[a-f0-9]{64}/u);
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(distDir, { recursive: true, force: true });
	}
});

test('rejects imported Swift runtime bundles when SDK checksum metadata does not match', async () => {
	const sourceDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-import-sdk-checksum-source-'));
	const distDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-import-sdk-checksum-dist-'));
	try {
		await writeValidSourceBundle(sourceDir);
		await assert.rejects(
			() =>
				importSwiftRuntimeDist({
					input: sourceDir,
					distDir,
					swiftVersion: '6.3.3',
					wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
					wasmSdkUrl:
						'https://download.swift.org/swift-6.3.3-release/wasm-sdk/swift-6.3.3-RELEASE/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
					wasmSdkChecksum: 'd'.repeat(64),
					source: 'external directory unit test'
				}),
			/wasmSdkChecksum [a-f0-9]{64} does not match sdk\.tar\.gz sha256/u
		);
		await assert.rejects(() => stat(path.join(distDir, 'runtime-build.json')));
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(distDir, { recursive: true, force: true });
	}
});

test('imports a Swift runtime tarball with a single nested bundle root', async () => {
	const workDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-import-tar-'));
	const sourceDir = path.join(workDir, 'bundle');
	const archivePath = path.join(workDir, 'bundle.tar.gz');
	const distDir = path.join(workDir, 'dist');
	try {
		await writeValidSourceBundle(sourceDir);
		await createTarGz(sourceDir, archivePath);

		const result = await importSwiftRuntimeDist({
			input: archivePath,
			inputSha256: await sha256File(archivePath),
			distDir,
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			source: 'external tarball unit test'
		});

		assert.equal(result.distDir, distDir);
		assert.match(result.sourceDir, /wasm-swift-import-/u);
		assert.equal(
			JSON.parse(await readFile(path.join(distDir, 'runtime-build.json'), 'utf8')).source,
			'external tarball unit test'
		);
		const buildInfo = JSON.parse(await readFile(path.join(distDir, 'runtime-build.json'), 'utf8'));
		assert.match(buildInfo.notes, new RegExp(`import-input=${archivePath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'));
		assert.match(buildInfo.notes, new RegExp(`import-input-sha256=${await sha256File(archivePath)}`, 'u'));
		assert.match(buildInfo.notes, /import-source-tree-sha256=[a-f0-9]{64}/u);
		await assert.rejects(() => stat(result.sourceDir), /ENOENT/u);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
});

test('imports a Swift runtime tarball from URL after checksum verification', async () => {
	const workDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-import-url-'));
	const sourceDir = path.join(workDir, 'bundle');
	const archivePath = path.join(workDir, 'bundle.tar.gz');
	const distDir = path.join(workDir, 'dist');
	let server = null;
	try {
		await writeValidSourceBundle(sourceDir);
		await createTarGz(sourceDir, archivePath);
		const archiveSha256 = await sha256File(archivePath);
		server = await serveFile(archivePath);

		const result = await importSwiftRuntimeDist({
			inputUrl: server.url,
			inputSha256: archiveSha256,
			distDir,
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			source: 'external URL unit test'
		});

		assert.equal(result.distDir, distDir);
		assert.match(result.sourceDir, /wasm-swift-import-/u);
		const buildInfo = JSON.parse(await readFile(path.join(distDir, 'runtime-build.json'), 'utf8'));
		assert.equal(buildInfo.source, 'external URL unit test');
		assert.match(buildInfo.notes, new RegExp(`import-input=${server.url}`, 'u'));
		assert.match(buildInfo.notes, new RegExp(`import-input-sha256=${archiveSha256}`, 'u'));
		assert.match(buildInfo.notes, /import-source-tree-sha256=[a-f0-9]{64}/u);
		await assert.rejects(() => stat(result.sourceDir), /ENOENT/u);
	} finally {
		await server?.close();
		await rm(workDir, { recursive: true, force: true });
	}
});

test('imports a Swift runtime tarball through an export descriptor', async () => {
	const workDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-import-descriptor-'));
	const sourceDir = path.join(workDir, 'bundle');
	const archivePath = path.join(workDir, 'wasm-swift-runtime.tar.gz');
	const descriptorPath = path.join(workDir, 'wasm-swift-runtime.tar.gz.json');
	const distDir = path.join(workDir, 'dist');
	try {
		await writeValidSourceBundle(sourceDir);
		await createTarGz(sourceDir, archivePath);
		const archiveSha256 = await sha256File(archivePath);
		const descriptorMetadata = await createDescriptorMetadata(sourceDir);
		await writeFile(
			descriptorPath,
			`${JSON.stringify(
				{
					format: 'wasm-swift-runtime-export-v1',
					archiveFile: path.basename(archivePath),
					archiveSha256,
					url: null,
					swiftVersion: '6.3.3',
					wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
					...descriptorMetadata,
					buildSource: 'descriptor build source'
				},
				null,
				2
			)}\n`,
			'utf8'
		);

		const result = await importSwiftRuntimeDist({
			inputDescriptor: descriptorPath,
			distDir,
			requireDescriptorMetadata: true
		});

		assert.equal(result.distDir, distDir);
		const buildInfo = JSON.parse(await readFile(path.join(distDir, 'runtime-build.json'), 'utf8'));
		assert.equal(buildInfo.source, 'descriptor build source');
		assert.match(
			buildInfo.notes,
			new RegExp(`import-descriptor=${descriptorPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u')
		);
		assert.match(
			buildInfo.notes,
			new RegExp(`import-input=${descriptorPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u')
		);
		assert.match(buildInfo.notes, new RegExp(`import-input-sha256=${archiveSha256}`, 'u'));
		await assert.rejects(() => stat(result.sourceDir), /ENOENT/u);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
});

test('can prefer a descriptor sibling archive over its published URL', async () => {
	const workDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-import-descriptor-local-'));
	const sourceDir = path.join(workDir, 'bundle');
	const archivePath = path.join(workDir, 'wasm-swift-runtime.tar.gz');
	const descriptorPath = path.join(workDir, 'wasm-swift-runtime.tar.gz.json');
	const distDir = path.join(workDir, 'dist');
	try {
		await writeValidSourceBundle(sourceDir);
		await createTarGz(sourceDir, archivePath);
		const archiveSha256 = await sha256File(archivePath);
		await writeFile(
			descriptorPath,
			`${JSON.stringify(
				{
					format: 'wasm-swift-runtime-export-v1',
					archiveFile: path.basename(archivePath),
					archiveSha256,
					url: 'http://127.0.0.1:9/unavailable-wasm-swift-runtime.tar.gz',
					swiftVersion: '6.3.3',
					wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
					...(await createDescriptorMetadata(sourceDir)),
					buildSource: 'descriptor local archive preference'
				},
				null,
				2
			)}\n`,
			'utf8'
		);

		const result = await importSwiftRuntimeDist({
			inputDescriptor: descriptorPath,
			preferDescriptorArchiveFile: true,
			distDir,
			requireDescriptorMetadata: true
		});

		assert.equal(result.distDir, distDir);
		const buildInfo = JSON.parse(await readFile(path.join(distDir, 'runtime-build.json'), 'utf8'));
		assert.equal(buildInfo.source, 'descriptor local archive preference');
		assert.match(buildInfo.notes, new RegExp(`import-input-sha256=${archiveSha256}`, 'u'));
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
});

test('rejects strict Swift runtime descriptor imports without metadata receipt fields', async () => {
	const workDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-import-descriptor-required-'));
	const sourceDir = path.join(workDir, 'bundle');
	const archivePath = path.join(workDir, 'wasm-swift-runtime.tar.gz');
	const descriptorPath = path.join(workDir, 'wasm-swift-runtime.tar.gz.json');
	try {
		await writeValidSourceBundle(sourceDir);
		await createTarGz(sourceDir, archivePath);
		await writeFile(
			descriptorPath,
			`${JSON.stringify(
				{
					format: 'wasm-swift-runtime-export-v1',
					archiveFile: path.basename(archivePath),
					archiveSha256: await sha256File(archivePath),
					url: null,
					swiftVersion: '6.3.3',
					wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
					buildSource: 'descriptor without metadata'
				},
				null,
				2
			)}\n`,
			'utf8'
		);

		await assert.rejects(
			() =>
				importSwiftRuntimeDist({
					inputDescriptor: descriptorPath,
					distDir: path.join(workDir, 'dist'),
					requireDescriptorMetadata: true
				}),
			/missing required metadata: fingerprint, runtimeContract, files, runtimeBuildSha256/u
		);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
});

test('rejects Swift runtime export descriptors whose runtime-build digest does not match the archive', async () => {
	const workDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-import-descriptor-build-sha-'));
	const sourceDir = path.join(workDir, 'bundle');
	const archivePath = path.join(workDir, 'wasm-swift-runtime.tar.gz');
	const descriptorPath = path.join(workDir, 'wasm-swift-runtime.tar.gz.json');
	try {
		await writeValidSourceBundle(sourceDir);
		await createTarGz(sourceDir, archivePath);
		const archiveSha256 = await sha256File(archivePath);
		const descriptorMetadata = await createDescriptorMetadata(sourceDir);
		await writeFile(
			descriptorPath,
			`${JSON.stringify(
				{
					format: 'wasm-swift-runtime-export-v1',
					archiveFile: path.basename(archivePath),
					archiveSha256,
					url: null,
					swiftVersion: '6.3.3',
					wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
					...descriptorMetadata,
					runtimeBuildSha256: '0'.repeat(64),
					buildSource: 'descriptor bad runtime build checksum'
				},
				null,
				2
			)}\n`,
			'utf8'
		);

		await assert.rejects(
			() =>
				importSwiftRuntimeDist({
					inputDescriptor: descriptorPath,
					distDir: path.join(workDir, 'dist'),
					requireDescriptorMetadata: true
				}),
			/runtimeBuildSha256 .* does not match imported runtime-build\.json/u
		);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
});

test('rejects Swift runtime export descriptors whose local archive sha256 does not match', async () => {
	const workDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-import-descriptor-sha-'));
	const sourceDir = path.join(workDir, 'bundle');
	const archivePath = path.join(workDir, 'wasm-swift-runtime.tar.gz');
	const descriptorPath = path.join(workDir, 'wasm-swift-runtime.tar.gz.json');
	try {
		await writeValidSourceBundle(sourceDir);
		await createTarGz(sourceDir, archivePath);
		await writeFile(
			descriptorPath,
			`${JSON.stringify(
				{
					format: 'wasm-swift-runtime-export-v1',
					archiveFile: path.basename(archivePath),
					archiveSha256: '0'.repeat(64),
					url: null,
					swiftVersion: '6.3.3',
					wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
					...(await createDescriptorMetadata(sourceDir)),
					buildSource: 'descriptor bad archive checksum'
				},
				null,
				2
			)}\n`,
			'utf8'
		);

		await assert.rejects(
			() =>
				importSwiftRuntimeDist({
					inputDescriptor: descriptorPath,
					distDir: path.join(workDir, 'dist'),
					requireDescriptorMetadata: true
				}),
			/Swift runtime input archive sha256 mismatch/u
		);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
});

test('rejects Swift runtime export descriptors whose bundle metadata does not match the archive', async () => {
	const workDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-import-descriptor-metadata-'));
	const sourceDir = path.join(workDir, 'bundle');
	const archivePath = path.join(workDir, 'wasm-swift-runtime.tar.gz');
	const descriptorPath = path.join(workDir, 'wasm-swift-runtime.tar.gz.json');
	try {
		await writeValidSourceBundle(sourceDir);
		await createTarGz(sourceDir, archivePath);
		const archiveSha256 = await sha256File(archivePath);
		const descriptorMetadata = await createDescriptorMetadata(sourceDir);
		await writeFile(
			descriptorPath,
			`${JSON.stringify(
				{
					format: 'wasm-swift-runtime-export-v1',
					archiveFile: path.basename(archivePath),
					archiveSha256,
					url: null,
					swiftVersion: '6.3.3',
					wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
					...descriptorMetadata,
					fingerprint: '0000000000000000',
					buildSource: 'descriptor build source'
				},
				null,
				2
			)}\n`,
			'utf8'
		);

		await assert.rejects(
			() =>
				importSwiftRuntimeDist({
					inputDescriptor: descriptorPath,
					distDir: path.join(workDir, 'dist')
				}),
			/descriptor metadata does not match imported bundle[\s\S]*fingerprint/u
		);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
});

test('rejects Swift runtime export descriptors whose metadata conflicts with CLI options', async () => {
	const workDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-import-descriptor-conflict-'));
	const descriptorPath = path.join(workDir, 'wasm-swift-runtime.tar.gz.json');
	try {
		await writeFile(
			descriptorPath,
			`${JSON.stringify({
				format: 'wasm-swift-runtime-export-v1',
				archiveFile: 'wasm-swift-runtime.tar.gz',
				archiveSha256: '1'.repeat(64),
				url: null,
				swiftVersion: '6.3.3',
				wasmSdkId: 'swift-6.3.3-RELEASE_wasm'
			})}\n`,
			'utf8'
		);

		await assert.rejects(
			() =>
				importSwiftRuntimeDist({
					inputDescriptor: descriptorPath,
					swiftVersion: '6.3.4'
				}),
			/does not match --swift-version/u
		);
		await assert.rejects(
			() =>
				importSwiftRuntimeDist({
					inputDescriptor: descriptorPath,
					input: path.join(workDir, 'wasm-swift-runtime.tar.gz')
				}),
			/use only one Swift runtime import input source/u
		);
		await assert.rejects(
			() =>
				importSwiftRuntimeDist({
					input: path.join(workDir, 'wasm-swift-runtime.tar.gz'),
					preferDescriptorArchiveFile: true
				}),
			/--prefer-descriptor-archive-file requires --input-descriptor/u
		);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
});

test('rejects Swift runtime URL imports whose checksum does not match', async () => {
	const workDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-import-url-mismatch-'));
	const sourceDir = path.join(workDir, 'bundle');
	const archivePath = path.join(workDir, 'bundle.tar.gz');
	let server = null;
	try {
		await writeValidSourceBundle(sourceDir);
		await createTarGz(sourceDir, archivePath);
		server = await serveFile(archivePath);

		await assert.rejects(
			() =>
				importSwiftRuntimeDist({
					inputUrl: server.url,
					inputSha256: '0'.repeat(64),
					distDir: path.join(workDir, 'dist'),
					swiftVersion: '6.3.3',
					wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
					source: 'external URL unit test'
				}),
			/sha256 mismatch/u
		);
	} finally {
		await server?.close();
		await rm(workDir, { recursive: true, force: true });
	}
});

test('finds gzip-only compiler assets in an imported Swift bundle', async () => {
	const sourceDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-import-gzip-source-'));
	const distDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-import-gzip-dist-'));
	try {
		await writeValidSourceBundle(sourceDir);
		for (const wasmFile of ['swiftc.wasm', 'swiftpm.wasm']) {
			const wasmPath = path.join(sourceDir, wasmFile);
			await writeFile(`${wasmPath}.gz`, gzipSync(await readFile(wasmPath)));
			await rm(wasmPath);
		}

		const result = await resolveSwiftRuntimeImportSource(sourceDir);
		assert.equal(result.sourceDir, sourceDir);
		await result.cleanup();
		await importSwiftRuntimeDist({
			input: sourceDir,
			distDir,
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			source: 'external gzip unit test',
			notes: 'operator note'
		});
		assert.match(
			JSON.parse(await readFile(path.join(distDir, 'runtime-build.json'), 'utf8')).notes,
			/operator note\nimport-input=/u
		);
		await assert.rejects(() => stat(path.join(distDir, 'swiftc.wasm')));
		await assert.doesNotReject(() => stat(path.join(distDir, 'swiftc.wasm.gz')));
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(distDir, { recursive: true, force: true });
	}
});

test('rejects ambiguous Swift runtime archives', async () => {
	const workDir = await mkdtemp(path.join(tmpdir(), 'wasm-swift-import-ambiguous-'));
	const sourceA = path.join(workDir, 'a');
	const sourceB = path.join(workDir, 'b');
	const archivePath = path.join(workDir, 'ambiguous.tgz');
	try {
		await writeValidSourceBundle(sourceA);
		await writeValidSourceBundle(sourceB);
		await new Promise((resolve, reject) => {
			const child = spawn('tar', ['-czf', archivePath, '-C', workDir, 'a', 'b']);
			child.on('error', reject);
			child.on('close', (code) => {
				if (code === 0) resolve();
				else reject(new Error(`tar failed with exit code ${code}`));
			});
		});

		await assert.rejects(
			() => resolveSwiftRuntimeImportSource(archivePath),
			/multiple bundle roots/u
		);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
});
