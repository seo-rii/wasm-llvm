#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

import { PACKAGED_PTHREAD_WORKER } from './build.mjs';
import { isMain, parseArguments, producerRoot } from './shared.mjs';

const gzipAsync = promisify(gzip);

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

export async function packageWamrBrowser({ build, output }) {
	if (!build) throw new Error('--build is required');
	if (!output) throw new Error('--output is required');
	build = path.resolve(build);
	output = path.resolve(output);
	const input = path.join(build, 'wasm-idle-output');
	await mkdir(output, { recursive: true });
	const js = await readFile(path.join(input, 'wamr-debug.js'));
	const wasm = await readFile(path.join(input, 'wamr-debug.wasm'));
	const worker = await readFile(path.join(input, PACKAGED_PTHREAD_WORKER));
	const compressedWasm = await gzipAsync(wasm, { level: 9, mtime: 0 });
	await copyFile(path.join(input, 'wamr-debug.js'), path.join(output, 'wamr-debug.js'));
	await copyFile(path.join(input, 'wamr-debug.wasm'), path.join(output, 'wamr-debug.wasm'));
	await copyFile(
		path.join(input, PACKAGED_PTHREAD_WORKER),
		path.join(output, PACKAGED_PTHREAD_WORKER)
	);
	await writeFile(path.join(output, 'wamr-debug.wasm.gz'), compressedWasm);

	const [sourcesLockBytes, producerManifestBytes] = await Promise.all([
		readFile(path.join(producerRoot, 'sources.lock.json')),
		readFile(path.join(producerRoot, 'manifest.json'))
	]);
	const lock = JSON.parse(sourcesLockBytes);
	const producerManifest = JSON.parse(producerManifestBytes);
	const receipt = {
		format: 'wasm-idle-wamr-debug-v1',
		protocolVersion: 1,
		transport: 'shared-ring-v1',
		pthreadTransport: 'pthread-transport-v1',
		wamrRevision: lock.wamr.commit,
		emscriptenVersion: lock.emscripten.version,
		emsdkRevision: lock.emscripten.commit,
		provenance: {
			sourcesLockSha256: sha256(sourcesLockBytes),
			producerManifestSha256: sha256(producerManifestBytes),
			patchesSha256: sha256(
				Object.values(producerManifest.patches)
					.map((entry) => entry.sha256)
					.join('\n')
			),
			overlaysSha256: sha256(
				Object.values(producerManifest.overlays)
					.map((entry) => entry.sha256)
					.join('\n')
			)
		},
		assets: [
			{ path: 'wamr-debug.js', bytes: js.byteLength, sha256: sha256(js) },
			{ path: 'wamr-debug.wasm', bytes: wasm.byteLength, sha256: sha256(wasm) },
			{
				path: PACKAGED_PTHREAD_WORKER,
				bytes: worker.byteLength,
				sha256: sha256(worker)
			},
			{
				path: 'wamr-debug.wasm.gz',
				bytes: compressedWasm.byteLength,
				sha256: sha256(compressedWasm),
				uncompressedBytes: wasm.byteLength,
				uncompressedSha256: sha256(wasm)
			}
		]
	};
	await writeFile(
		path.join(output, 'producer-receipt.json'),
		`${JSON.stringify(receipt, null, 2)}\n`
	);
	console.log(`Packaged WAMR browser debugger in ${output}`);
}

if (isMain(import.meta.url)) {
	await packageWamrBrowser(parseArguments(process.argv.slice(2)));
}
