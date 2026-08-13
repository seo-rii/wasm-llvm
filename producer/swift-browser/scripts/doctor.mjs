#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateSwiftRuntimeBuildInfo } from './runtime-build-info.mjs';
import {
	validateSwiftRuntimeFileSignatures,
	validateSwiftRuntimeManifestFiles
} from './runtime-manifest.mjs';
import { probeSwiftToolchain, swiftWasmMetadata } from './probe-toolchain.mjs';
import { validateSwiftBrowserBuildPlan } from './verify-build-outputs.mjs';

const thisFile = fileURLToPath(import.meta.url);
const defaultProducerRoot = path.resolve(path.dirname(thisFile), '..');

async function isFile(filePath) {
	return !!(await stat(filePath).catch(() => null))?.isFile();
}

async function isDirectory(filePath) {
	return !!(await stat(filePath).catch(() => null))?.isDirectory();
}

export function parseDoctorArgs(argv) {
	const options = { planPath: null, bundleDir: null, probeToolchain: false, json: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--') continue;
		if (arg === '--help' || arg === '-h') return { help: true };
		if (arg === '--probe-toolchain') options.probeToolchain = true;
		else if (arg === '--json') options.json = true;
		else if (arg === '--plan' || arg === '--bundle-dir') {
			const value = argv[index + 1];
			if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
			if (arg === '--plan') options.planPath = path.resolve(value);
			else options.bundleDir = path.resolve(value);
			index += 1;
		} else throw new Error(`Unknown option: ${arg}`);
	}
	return options;
}

export async function verifySwiftProducer({
	producerRoot = defaultProducerRoot,
	planPath = null,
	bundleDir = null,
	probeToolchain = false
} = {}) {
	const errors = [];
	const manifestPath = path.join(producerRoot, 'manifest.json');
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
	if (manifest.schemaVersion !== 1 || manifest.producerId !== 'wasm-llvm/swift-browser') {
		errors.push('Swift producer manifest identity is invalid');
	}
	for (const [patch, expectedHash] of Object.entries(manifest.patches ?? {})) {
		const patchBytes = await readFile(path.join(producerRoot, 'patches', patch)).catch(() => null);
		if (!patchBytes) {
			errors.push(`Swift producer patch is missing: ${patch}`);
			continue;
		}
		const actualHash = createHash('sha256').update(patchBytes).digest('hex');
		if (actualHash !== expectedHash) errors.push(`Swift producer patch hash mismatch: ${patch}`);
	}
	const sdk = swiftWasmMetadata();
	if (
		manifest.wasmSdk?.id !== sdk.wasmSdkId ||
		manifest.wasmSdk?.url !== sdk.wasmSdkUrl ||
		manifest.wasmSdk?.sha256 !== sdk.wasmSdkChecksum
	) {
		errors.push('Swift producer manifest does not match the pinned Wasm SDK metadata');
	}

	let plan = null;
	if (planPath) {
		try {
			plan = JSON.parse(await readFile(planPath, 'utf8'));
			errors.push(...validateSwiftBrowserBuildPlan(plan));
		} catch (error) {
			errors.push(`Swift browser build plan could not be read: ${error.message}`);
		}
	}

	let bundle = null;
	if (bundleDir && (await isDirectory(bundleDir))) {
		try {
			const runtimeManifest = JSON.parse(
				await readFile(path.join(bundleDir, 'runtime-manifest.v1.json'), 'utf8')
			);
			const buildInfo = JSON.parse(await readFile(path.join(bundleDir, 'runtime-build.json'), 'utf8'));
			errors.push(...(await validateSwiftRuntimeManifestFiles(bundleDir, runtimeManifest)));
			errors.push(...validateSwiftRuntimeBuildInfo(buildInfo));
			errors.push(...(await validateSwiftRuntimeFileSignatures(bundleDir)));
			bundle = { manifest: runtimeManifest, buildInfo };
		} catch (error) {
			errors.push(`Swift browser bundle could not be verified: ${error.message}`);
		}
	} else if (bundleDir) {
		errors.push(`Swift browser bundle directory was not found: ${bundleDir}`);
	}

	let toolchain = null;
	if (probeToolchain) {
		try {
			toolchain = await probeSwiftToolchain();
		} catch (error) {
			errors.push(error.message);
		}
	}

	return {
		ready: errors.length === 0,
		manifestPath,
		patches: Object.keys(manifest.patches ?? {}),
		planPath,
		plan,
		bundleDir,
		bundle,
		toolchain,
		errors
	};
}

function usage() {
	return [
		'Usage: pnpm swift:doctor -- [options]',
		'',
		'Options:',
		'  --plan <file>       Validate a browser compiler build plan',
		'  --bundle-dir <dir>  Validate a packaged Swift bundle',
		'  --probe-toolchain   Probe the installed native Swift/Wasm SDK',
		'  --json              Print the report as JSON'
	].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
	try {
		const options = parseDoctorArgs(process.argv.slice(2));
		if (options.help) console.log(usage());
		else {
			const report = await verifySwiftProducer(options);
			if (options.json) console.log(JSON.stringify(report, null, 2));
			else {
				console.log(`Swift producer manifest: ${report.manifestPath}`);
				console.log(`Pinned patches: ${report.patches.length}`);
				for (const error of report.errors) console.error(`error: ${error}`);
				console.log(`Ready: ${report.ready ? 'yes' : 'no'}`);
			}
			if (!report.ready) process.exitCode = 1;
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
