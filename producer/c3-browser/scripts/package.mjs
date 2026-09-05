#!/usr/bin/env node

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReceipt, paths, producerRoot, readManifest, sha256 } from './producer.mjs';
import { assertAcceptanceInputs } from './evidence.mjs';

export const compilerAssets = ['c3c.mjs', 'c3c.wasm'];

export function requireSmokeChecks(smoke) {
	for (const check of ['compileOnly', 'invalidSourceDiagnostic', 'builtinLink', 'arithmetic', 'hostByteInputOutput']) {
		if (smoke?.checks?.[check] !== true) throw new Error(`Missing successful compiler smoke check: ${check}`);
	}
}

export async function verify(directory = paths().release) {
	const manifestBytes = await readFile(path.join(producerRoot, 'manifest.json'));
	const receipt = JSON.parse(await readFile(path.join(directory, 'producer-receipt.json'), 'utf8'));
	if (receipt.schemaVersion !== 1 || receipt.producerId !== 'wasm-llvm/c3-browser' || receipt.manifestSha256 !== sha256(manifestBytes)) {
		throw new Error('C3 receipt does not match the producer manifest');
	}
	if (JSON.stringify(Object.keys(receipt.assets ?? {}).sort()) !== JSON.stringify([...compilerAssets].sort())) {
		throw new Error('C3 receipt must describe exactly the compiler loader and Wasm module');
	}
	if (receipt.build?.manifestSha256 !== sha256(manifestBytes) ||
		receipt.build?.builderSha256 !== sha256(await readFile(path.join(producerRoot, 'scripts/producer.mjs')))) {
		throw new Error('C3 receipt was built with a different manifest or build script');
	}
	requireSmokeChecks(receipt.smoke);
	requireSmokeChecks(receipt.browserSmoke);
	await assertAcceptanceInputs(receipt.smoke);
	await assertAcceptanceInputs(receipt.browserSmoke);
	if (receipt.browserSmoke.checks.browserGuest !== true) throw new Error('Missing browser program execution evidence');
	for (const name of compilerAssets) {
		const bytes = await readFile(path.join(directory, name));
		assertReceipt(bytes, receipt.assets[name], name);
		assertReceipt(bytes, receipt.smoke.assets?.[name] ?? {}, `${name} smoke evidence`);
		assertReceipt(bytes, receipt.browserSmoke.assets?.[name] ?? {}, `${name} browser evidence`);
		assertReceipt(bytes, receipt.build.assets?.[name] ?? {}, `${name} build evidence`);
		if (name.endsWith('.wasm')) await WebAssembly.compile(bytes);
	}
	console.log(`Verified C3 producer artifacts in ${directory}`);
	return receipt;
}

export async function packageCompiler(p = paths()) {
	const manifest = await readManifest();
	const manifestSha256 = sha256(await readFile(path.join(producerRoot, 'manifest.json')));
	const build = JSON.parse(await readFile(path.join(p.build, 'build-receipt.json'), 'utf8'));
	if (build.manifestSha256 !== manifestSha256) throw new Error('Build used another manifest; rebuild before packaging');
	if (build.builderSha256 !== sha256(await readFile(path.join(producerRoot, 'scripts/producer.mjs')))) {
		throw new Error('Build script changed; rebuild before packaging');
	}
	const smoke = JSON.parse(await readFile(path.join(p.build, 'smoke.json'), 'utf8'));
	const browserSmoke = JSON.parse(await readFile(path.join(p.build, 'browser-smoke.json'), 'utf8'));
	requireSmokeChecks(smoke);
	requireSmokeChecks(browserSmoke);
	await assertAcceptanceInputs(smoke);
	await assertAcceptanceInputs(browserSmoke);
	if (browserSmoke.checks.browserGuest !== true) throw new Error('Missing browser program execution evidence');
	const assets = {};
	for (const name of compilerAssets) {
		const bytes = await readFile(path.join(p.build, name));
		assertReceipt(bytes, build.assets?.[name] ?? {}, `${name} build evidence`);
		assertReceipt(bytes, smoke.assets?.[name] ?? {}, `${name} smoke evidence`);
		assertReceipt(bytes, browserSmoke.assets?.[name] ?? {}, `${name} browser evidence`);
		assets[name] = { bytes: bytes.length, sha256: sha256(bytes) };
	}
	await mkdir(p.release, { recursive: true });
	for (const name of compilerAssets) await copyFile(path.join(p.build, name), path.join(p.release, name));
	await writeFile(path.join(p.release, 'producer-receipt.json'), `${JSON.stringify({
		schemaVersion: 1,
		producerId: manifest.producerId,
		manifestSha256,
		compilerHost: manifest.compilerHost,
		programTarget: manifest.programTarget,
		sources: manifest.sources,
		llvm: manifest.llvm,
		patches: manifest.patches,
		build,
		smoke,
		browserSmoke,
		assets
	}, null, 2)}\n`);
	await verify(p.release);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [option, ...extra] = process.argv.slice(2);
	if (extra.length || (option !== undefined && option !== '--verify')) throw new Error('Usage: package.mjs [--verify]');
	if (option === '--verify') await verify();
	else await packageCompiler();
}
