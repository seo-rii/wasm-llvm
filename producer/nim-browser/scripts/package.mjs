#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import {
	artifactPath, assertReceipt, describeArtifact, jsonBytes, publishArtifacts, readRegular,
	readVerified, sha256, verifyArtifactDirectory, writeArtifact
} from '../../../scripts/lib/verified-artifacts.mjs';
import { patchClangJs, patchNimLicense, upgradeLegacyClangJs } from './patches.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORMAT = 'wasm-llvm-nim-browser-artifacts-v1';
const ASSETS = ['nim/nim-bundle.js', 'nim/nim.wasm', 'nim/nimbase.h', 'clang/clang.js',
	'clang/clang.wasm', 'clang/lld.wasm', 'clang/memfs.wasm', 'clang/sysroot.tar'];
const LEGAL = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md'];

export async function loadContract() {
	const manifestBytes = await readRegular(ROOT, 'manifest.json', 1024 * 1024);
	const manifest = JSON.parse(manifestBytes);
	const lockBytes = await readRegular(ROOT, 'sources.lock.json', 1024 * 1024);
	const lock = JSON.parse(lockBytes);
	if (sha256(lockBytes) !== manifest.sourceLockSha256 || manifest.schemaVersion !== 1 ||
		manifest.producerId !== 'wasm-llvm/nim-browser' || lock.schemaVersion !== 1 ||
		JSON.stringify(lock.assets.map((entry) => entry.path)) !== JSON.stringify(ASSETS)) {
		throw new Error('Nim source lock does not match its producer manifest');
	}
	const outputs = [...lock.assets.map(({ path: name, bytes, sha256: digest }) => ({ path: name, bytes, sha256: digest })),
		{ path: 'LICENSE', bytes: lock.license.bytes, sha256: lock.license.sha256 },
		{ path: 'THIRD_PARTY_NOTICES.md', bytes: lock.notices.bytes, sha256: lock.notices.sha256 },
		{ path: 'README.md', bytes: lock.documentation.bytes, sha256: lock.documentation.sha256 }];
	return { manifest, lock, outputs,
		identity: { schemaVersion: 1, format: FORMAT, producerId: manifest.producerId,
			manifestSha256: sha256(manifestBytes), sourceLockSha256: sha256(lockBytes) } };
}

export async function verifyNimArtifacts(directory, contract) {
	contract ??= await loadContract();
	return verifyArtifactDirectory(directory, contract.identity, contract.outputs);
}

// Never trust an HTTP Content-Length, a server filename, or a self-described archive digest.
export async function downloadLockedArchive(artifact, fetchImpl = fetch) {
	const response = await fetchImpl(artifact.archiveUrl, {
		credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(120_000)
	});
	let reader;
	try {
		if (!response.ok || response.url !== artifact.archiveUrl || !response.body) throw new Error('Nim archive download returned an unexpected response');
		const length = response.headers.get('content-length');
		if (length !== null && (!/^\d+$/u.test(length) || Number(length) !== artifact.bytes)) {
			throw new Error('Nim archive download has an unexpected Content-Length');
		}
		const result = Buffer.alloc(artifact.bytes);
		reader = response.body.getReader();
		let offset = 0;
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			if (offset + value.byteLength > result.byteLength) throw new Error('Nim archive download exceeds its pinned byte limit');
			result.set(value, offset);
			offset += value.byteLength;
		}
		if (offset !== result.byteLength) throw new Error('Nim archive download is truncated');
		assertReceipt(result, artifact, 'Nim source archive');
		return result;
	} catch (error) {
		await (reader ? reader.cancel() : response.body?.cancel())?.catch(() => {});
		throw error;
	} finally {
		reader?.releaseLock();
	}
}

async function fromArchive(archiveBytes, contract) {
	assertReceipt(archiveBytes, contract.lock.artifact, 'Nim source archive');
	const work = await mkdtemp(path.join(os.tmpdir(), 'wasm-llvm-nim-'));
	try {
		const archive = path.join(work, 'source.tar.gz');
		await writeArtifact(work, 'source.tar.gz', archiveBytes);
		const { stdout } = await run('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
		const names = stdout.trimEnd().split('\n');
		const prefix = `${contract.lock.artifact.archiveRoot}/`;
		for (const name of names) {
			if (!name.startsWith(prefix)) throw new Error('Nim archive entry is outside its pinned source root');
			artifactPath(name.replace(/\/$/u, ''));
		}
		const required = [...contract.lock.assets.map((entry) => ({
			path: `demo/static/${entry.path}`, bytes: entry.sourceBytes, sha256: entry.sourceSha256
		})), { path: 'LICENSE', bytes: contract.lock.license.sourceBytes, sha256: contract.lock.license.sourceSha256 },
		{ path: 'README.md', bytes: contract.lock.documentation.bytes, sha256: contract.lock.documentation.sha256 }];
		const inputs = new Map();
		for (const entry of required) {
			const name = `${prefix}${entry.path}`;
			if (names.filter((candidate) => candidate === name).length !== 1) throw new Error(`Nim archive must contain exactly one ${entry.path}`);
			// Read only explicitly named members to stdout. No archive entry is extracted to disk.
			const { stdout: bytes } = await run('tar', ['-xOzf', archive, '--', name], {
				encoding: 'buffer', maxBuffer: entry.bytes, timeout: 120_000
			});
			assertReceipt(bytes, entry, entry.path);
			inputs.set(entry.path, bytes);
		}
		return inputs;
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

async function fromSource(directory, contract) {
	const inputs = new Map();
	for (const entry of contract.lock.assets) {
		const name = `demo/static/${entry.path}`;
		inputs.set(name, await readVerified(directory, name, { bytes: entry.sourceBytes, sha256: entry.sourceSha256 }));
	}
	inputs.set('LICENSE', await readVerified(directory, 'LICENSE', {
		bytes: contract.lock.license.sourceBytes, sha256: contract.lock.license.sourceSha256
	}));
	inputs.set('README.md', await readVerified(directory, 'README.md', contract.lock.documentation));
	return inputs;
}

async function fromRuntime(directory, contract) {
	const outputs = new Map();
	for (const entry of contract.lock.assets) {
		const compressed = !['nim/nimbase.h', 'clang/clang.js'].includes(entry.path);
		const name = `${entry.path}${compressed ? '.gz.bin' : '.bin'}`;
		const stored = await readRegular(directory, name, compressed ? entry.bytes + 1024 * 1024 : entry.bytes);
		let bytes = compressed ? gunzipSync(stored, { maxOutputLength: entry.bytes }) : stored;
		if (entry.path === 'clang/clang.js' && sha256(bytes) !== entry.sha256) {
			assertReceipt(bytes, contract.lock.legacyRuntime.clangJs, 'Legacy runtime clang.js');
			bytes = Buffer.from(upgradeLegacyClangJs(bytes.toString('utf8')));
		}
		assertReceipt(bytes, entry, entry.path);
		outputs.set(entry.path, bytes);
	}
	for (const name of LEGAL) outputs.set(name, await readVerified(directory, name, contract.outputs.find((entry) => entry.path === name)));
	return outputs;
}

export async function packageNim({ sourceDir, fromRuntimeDir, archivePath, download = false, outputDir, contract, fetchImpl } = {}) {
	contract ??= await loadContract();
	if (!outputDir || [sourceDir, fromRuntimeDir, archivePath, download].filter(Boolean).length !== 1) {
		throw new Error('Nim packaging requires an output and exactly one of --source, --from-runtime, --archive or --download');
	}
	let outputs;
	if (fromRuntimeDir) outputs = await fromRuntime(fromRuntimeDir, contract);
	else {
		const inputs = sourceDir ? await fromSource(sourceDir, contract) : await fromArchive(
			archivePath ? await readVerified(path.dirname(path.resolve(archivePath)), path.basename(archivePath), contract.lock.artifact)
				: await downloadLockedArchive(contract.lock.artifact, fetchImpl), contract);
		outputs = new Map();
		for (const entry of contract.lock.assets) {
			const source = inputs.get(`demo/static/${entry.path}`);
			outputs.set(entry.path, entry.path === 'clang/clang.js' ? Buffer.from(patchClangJs(source.toString('utf8'))) : source);
		}
		outputs.set('LICENSE', Buffer.from(patchNimLicense(inputs.get('LICENSE').toString('utf8'))));
		outputs.set('README.md', inputs.get('README.md'));
		outputs.set('THIRD_PARTY_NOTICES.md', await readVerified(ROOT, 'THIRD_PARTY_NOTICES.md',
			contract.outputs.find((entry) => entry.path === 'THIRD_PARTY_NOTICES.md')));
	}
	for (const entry of contract.outputs) assertReceipt(outputs.get(entry.path), entry, entry.path);
	return publishArtifacts(outputDir, [sourceDir, fromRuntimeDir, archivePath && path.dirname(path.resolve(archivePath))].filter(Boolean), async (temporary) => {
		const artifacts = [];
		for (const entry of contract.outputs) {
			const bytes = outputs.get(entry.path);
			await writeArtifact(temporary, entry.path, bytes);
			artifacts.push(describeArtifact(entry.path, bytes));
		}
		const receipt = { ...contract.identity, artifacts };
		await writeArtifact(temporary, 'producer-receipt.json', jsonBytes(receipt));
		await verifyNimArtifacts(temporary, contract);
		return receipt;
	});
}

async function main() {
	const args = process.argv.slice(2).filter((arg) => arg !== '--');
	const options = { outputDir: path.resolve(ROOT, '../../out/nim-browser') };
	const seen = new Set();
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--help') {
			console.log('package:nim -- (--source <distribution-root> | --from-runtime <installed-dir> | --archive <pinned-tar.gz> | --download) --out <new-dir>\nverify:nim-artifacts -- --verify <output-dir>');
			return;
		}
		if (seen.has(arg)) throw new Error(`Duplicate Nim producer option: ${arg}`);
		seen.add(arg);
		if (arg === '--download') { options.download = true; continue; }
		const key = { '--source': 'sourceDir', '--from-runtime': 'fromRuntimeDir', '--archive': 'archivePath', '--out': 'outputDir', '--verify': 'verify' }[arg];
		if (!key || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid Nim producer option: ${arg}`);
		options[key] = path.resolve(args[++i]);
	}
	if (options.verify && seen.size !== 1) throw new Error('--verify cannot be combined with packaging');
	if (!options.verify && !options.sourceDir && !options.fromRuntimeDir && !options.archivePath && !options.download) {
		options.sourceDir = process.env.WASM_LLVM_NIM_SOURCE_DIR;
	}
	const receipt = options.verify ? await verifyNimArtifacts(options.verify) : await packageNim(options);
	console.log(`${options.verify ? 'Verified' : 'Packaged'} ${receipt.producerId}: ${receipt.artifacts.length} pinned artifacts`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
