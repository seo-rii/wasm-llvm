#!/usr/bin/env node
// Local validation fixture only; this does not publish or select a release pin.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyArtifactDirectory } from '../../scripts/verify.mjs';
import { verifyWamrBrowser } from '../../../wamr-browser/scripts/verify.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
for (const key of ['--baseline', '--baseline-manifest-sha256', '--lldb', '--wamr', '--output'])
	assert(args.get(key), `Missing ${key}`);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const baselineRoot = path.resolve(args.get('--baseline'));
const output = path.resolve(args.get('--output'));
assert(
	![baselineRoot, path.resolve(args.get('--lldb')), path.resolve(args.get('--wamr'))].includes(
		output
	),
	'Use a separate fixture directory'
);
const baselineBytes = await readFile(path.join(baselineRoot, 'runtime-manifest.v2.json'));
assert.equal(
	digest(baselineBytes),
	args.get('--baseline-manifest-sha256'),
	'Pinned baseline manifest'
);
const manifest = JSON.parse(baselineBytes);
const bytes = new Map();
for (const asset of [manifest.debugger.lldb, manifest.debugger.targetRuntime]) {
	for (const kind of ['js', 'wasm', 'worker']) {
		assert(/^debug\/[a-z0-9.-]+$/u.test(asset[kind]), 'Canonical fixture asset path');
		const content = await readFile(path.join(baselineRoot, asset[kind]));
		assert.equal(digest(content), asset[`${kind}Sha256`], `Baseline ${kind} integrity`);
	}
}
const lldb = await verifyArtifactDirectory(path.resolve(args.get('--lldb')));
const wamr = await verifyWamrBrowser({ artifacts: path.resolve(args.get('--wamr')) });
assert.equal(lldb.receipt.source.llvmRevision, manifest.debugger.lldb.llvmRevision);
assert.equal(lldb.receipt.source.patchesSha256, manifest.debugger.lldb.patchesSha256);
assert.equal(wamr.wamrRevision, manifest.debugger.targetRuntime.revision);
for (const [asset, directory, names, hashes] of [
	[
		manifest.debugger.lldb,
		args.get('--lldb'),
		['lldb-web-dap.js', 'lldb-web-dap.wasm', 'lldb-web-dap.pthread.mjs'],
		lldb.receipt.assets
	],
	[
		manifest.debugger.targetRuntime,
		args.get('--wamr'),
		['wamr-debug.js', 'wamr-debug.wasm', 'wamr-debug.worker.mjs'],
		Object.fromEntries(wamr.assets.map((asset) => [asset.path, asset]))
	]
]) {
	for (const [index, kind] of ['js', 'wasm', 'worker'].entries()) {
		const name = names[index];
		const content = await readFile(path.join(directory, name));
		assert.equal(digest(content), hashes[name].sha256, 'Verified candidate integrity');
		asset[kind] = `debug/${name}`;
		asset[`${kind}Sha256`] = hashes[name].sha256;
		bytes.set(asset[kind], content);
	}
}
manifest.version += '-module-api-local-experiment';
manifest.debugger.lldb.moduleInstantiation = lldb.receipt.build.moduleInstantiation;
manifest.debugger.lldb.sourcesLockSha256 = lldb.receipt.producer.sourcesLockSha256;
manifest.debugger.targetRuntime.moduleInstantiation = wamr.moduleInstantiation;
manifest.debugger.targetRuntime.provenance = wamr.provenance;
assert.equal(manifest.debugger.lldb.moduleInstantiation, 'emscripten-instantiate-wasm-v1');
assert.equal(manifest.debugger.targetRuntime.moduleInstantiation, 'emscripten-instantiate-wasm-v1');
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
await mkdir(path.join(output, 'debug'), { recursive: true });
for (const [name, content] of bytes) await writeFile(path.join(output, name), content);
await writeFile(path.join(output, 'runtime-manifest.v2.json'), manifestBytes);
if (lldb.receipt.build.derivation) {
	const proof = await readFile(path.join(args.get('--lldb'), 'post-link-experiment.json'));
	assert.equal(
		JSON.parse(proof).input.manifestSha256,
		digest(baselineBytes),
		'Post-link proof input is the pinned baseline'
	);
	await writeFile(path.join(output, 'post-link-experiment.json'), proof);
}
await writeFile(
	path.join(output, 'experiment-receipt.json'),
	JSON.stringify(
		{
			format: 'wasm-llvm-debug-module-api-local-experiment-v1',
			baselineManifestSha256: digest(baselineBytes),
			candidateManifestSha256: digest(manifestBytes),
			lldb: lldb.receipt,
			wamr
		},
		null,
		2
	) + '\n'
);
console.log(
	JSON.stringify({
		manifestSha256: digest(manifestBytes),
		manifestBytes: manifestBytes.length,
		output
	})
);
