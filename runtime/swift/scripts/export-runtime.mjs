#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
	validateSwiftRuntimeBuildInfo,
	validateSwiftRuntimeSdkChecksum
} from './runtime-build-info.mjs';
import { validateSwiftRuntimeBundleInBrowser } from './runtime-contract-runner.mjs';
import {
	validateSwiftRuntimeFileSignatures,
	validateSwiftRuntimeManifestFiles
} from './runtime-manifest.mjs';
import {
	expectedBaselineCommandByPreset,
	parseBuildPlanProvenance,
	validateBaselineReceiptProvenance,
	validateBrowserBuildLogProvenance,
	validateBuildPlanProvenance,
	validateSourceBootstrapReceiptProvenance
} from './readiness.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const RUNTIME_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const DEFAULT_BUNDLE_DIR = path.join(RUNTIME_ROOT, 'dist');
const DEFAULT_OUT_DIR = path.join(RUNTIME_ROOT, 'out');

function readOptionValue(argv, index, optionName) {
	const value = argv[index + 1];
	if (typeof value !== 'string' || !value || value.startsWith('--')) {
		throw new Error(`${optionName} requires a value`);
	}
	return value;
}

function assertTimeoutMs(timeoutMs) {
	if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
		throw new Error('timeoutMs must be a positive safe integer when provided');
	}
}

function assertSafeArchiveName(archiveName) {
	if (!/^[A-Za-z0-9._+-]+\.t(?:ar\.)?gz$/u.test(archiveName)) {
		throw new Error('archiveName must be a safe .tar.gz or .tgz file name');
	}
	if (archiveName.includes('..')) {
		throw new Error('archiveName must not contain parent directory segments');
	}
}

async function sha256File(filePath) {
	return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

function runCommand(command, args, { cwd } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		let stderr = '';
		child.stderr.setEncoding('utf8');
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

export function parseExportSwiftRuntimeArgs(argv) {
	const options = {
		bundleDir: DEFAULT_BUNDLE_DIR,
		outDir: DEFAULT_OUT_DIR,
		runBrowserContract: false,
		requireBuildPlanProvenance: false,
		requireSourceBootstrapProvenance: false,
		requireBrowserBuildCommandProvenance: false,
		requireBrowserBuildExecutionProvenance: false,
		requireBrowserBuildLogProvenance: false,
		requireBaselineProvenance: false
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--') {
			continue;
		} else if (arg === '--help') {
			return { help: true };
		} else if (arg === '--bundle-dir') {
			options.bundleDir = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--out-dir') {
			options.outDir = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--archive-name') {
			options.archiveName = readOptionValue(argv, index, arg);
			assertSafeArchiveName(options.archiveName);
			index += 1;
		} else if (arg === '--url') {
			options.url = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--browser-contract') {
			options.runBrowserContract = true;
		} else if (arg === '--require-build-plan-provenance') {
			options.requireBuildPlanProvenance = true;
		} else if (arg === '--require-source-bootstrap-provenance') {
			options.requireSourceBootstrapProvenance = true;
		} else if (arg === '--require-browser-build-command-provenance') {
			options.requireBrowserBuildCommandProvenance = true;
		} else if (arg === '--require-browser-build-execution-provenance') {
			options.requireBrowserBuildExecutionProvenance = true;
		} else if (arg === '--require-browser-build-log-provenance') {
			options.requireBrowserBuildLogProvenance = true;
		} else if (arg === '--require-upstream-baseline-provenance') {
			options.requireBaselineProvenance = true;
		} else if (arg === '--timeout-ms') {
			options.timeoutMs = Number(readOptionValue(argv, index, arg));
			assertTimeoutMs(options.timeoutMs);
			index += 1;
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	assertTimeoutMs(options.timeoutMs);
	if (options.archiveName) assertSafeArchiveName(options.archiveName);
	if (options.url && !/^https?:\/\//u.test(options.url)) {
		throw new Error('url must be an http(s) URL when provided');
	}
	return options;
}

async function validateExportableBundle(
	bundleDir,
	{
		runBrowserContract = false,
		requireBuildPlanProvenance = false,
		requireSourceBootstrapProvenance = false,
		requireBrowserBuildCommandProvenance = false,
		requireBrowserBuildExecutionProvenance = false,
		requireBrowserBuildLogProvenance = false,
		requireBaselineProvenance = false,
		timeoutMs
	} = {}
) {
	const manifest = JSON.parse(
		await readFile(path.join(bundleDir, 'runtime-manifest.v1.json'), 'utf8')
	);
	const manifestErrors = await validateSwiftRuntimeManifestFiles(bundleDir, manifest);
	const buildInfo = JSON.parse(await readFile(path.join(bundleDir, 'runtime-build.json'), 'utf8'));
	const buildInfoErrors = validateSwiftRuntimeBuildInfo(buildInfo);
	const signatureErrors = await validateSwiftRuntimeFileSignatures(bundleDir);
	const errors = [...manifestErrors, ...buildInfoErrors, ...signatureErrors];
	if (buildInfo.swiftVersion !== manifest.swiftVersion) {
		errors.push(
			`runtime-build.json swiftVersion ${buildInfo.swiftVersion} does not match manifest ${manifest.swiftVersion}`
		);
	}
	if (buildInfo.wasmSdkId !== manifest.wasmSdkId) {
		errors.push(
			`runtime-build.json wasmSdkId ${buildInfo.wasmSdkId} does not match manifest ${manifest.wasmSdkId}`
		);
	}
	errors.push(...(await validateSwiftRuntimeSdkChecksum(buildInfo, { bundleDir })));
	let validatedBuildPlan = null;
	if (
		requireBuildPlanProvenance ||
		requireSourceBootstrapProvenance ||
		requireBrowserBuildCommandProvenance ||
		requireBrowserBuildExecutionProvenance
	) {
		const buildPlanResult = await validateBuildPlanProvenance(buildInfo.source, {
			bundleDir,
			requireBrowserBuildCommand: requireBrowserBuildCommandProvenance,
			requireBrowserBuildExecution: requireBrowserBuildExecutionProvenance,
			requireSourceBootstrapProvenance
		});
		validatedBuildPlan = buildPlanResult.plan;
		errors.push(...buildPlanResult.errors);
	}
	if (requireBrowserBuildLogProvenance) {
		const browserBuildLogResult = await validateBrowserBuildLogProvenance(buildInfo.source, {
			bundleDir
		});
		errors.push(...browserBuildLogResult.errors);
	}
	if (requireSourceBootstrapProvenance) {
		const sourceBootstrapResult = await validateSourceBootstrapReceiptProvenance(
			buildInfo.source,
			{
				expectedSourceBootstrap: validatedBuildPlan?.sourceBootstrap,
				bundleDir
			}
		);
		errors.push(...sourceBootstrapResult.errors);
	}
	if (requireBaselineProvenance) {
		const buildPlanProvenance = parseBuildPlanProvenance(buildInfo.source);
		const expectedBuildPlanPath = buildPlanProvenance?.planPath?.trim();
		const baselineResult = await validateBaselineReceiptProvenance(buildInfo.source, {
			expectedBuildPlanPath: path.isAbsolute(expectedBuildPlanPath || '')
				? expectedBuildPlanPath
				: undefined,
			expectedCommands: expectedBaselineCommandByPreset(validatedBuildPlan),
			bundleDir
		});
		errors.push(...baselineResult.errors);
	}
	if (errors.length > 0) {
		throw new Error(`Swift runtime bundle is not exportable:\n${errors.join('\n')}`);
	}
	if (runBrowserContract) {
		await validateSwiftRuntimeBundleInBrowser({ bundleDir, timeoutMs });
	}
	return { manifest, buildInfo };
}

export async function exportSwiftRuntimeArchive({
	bundleDir = DEFAULT_BUNDLE_DIR,
	outDir = DEFAULT_OUT_DIR,
	archiveName,
	url,
	runBrowserContract = false,
	requireBuildPlanProvenance = false,
	requireSourceBootstrapProvenance = false,
	requireBrowserBuildCommandProvenance = false,
	requireBrowserBuildExecutionProvenance = false,
	requireBrowserBuildLogProvenance = false,
	requireBaselineProvenance = false,
	timeoutMs,
	commandRunner = runCommand
} = {}) {
	assertTimeoutMs(timeoutMs);
	const normalizedBundleDir = path.resolve(bundleDir);
	const normalizedOutDir = path.resolve(outDir);
	const { manifest, buildInfo } = await validateExportableBundle(normalizedBundleDir, {
		runBrowserContract,
		requireBuildPlanProvenance,
		requireSourceBootstrapProvenance,
		requireBrowserBuildCommandProvenance,
		requireBrowserBuildExecutionProvenance,
		requireBrowserBuildLogProvenance,
		requireBaselineProvenance,
		timeoutMs
	});
	const resolvedArchiveName = archiveName ?? `wasm-swift-${manifest.fingerprint}.tar.gz`;
	assertSafeArchiveName(resolvedArchiveName);
	await mkdir(normalizedOutDir, { recursive: true });
	const archivePath = path.join(normalizedOutDir, resolvedArchiveName);
	await commandRunner('tar', [
		'-czf',
		archivePath,
		'-C',
		path.dirname(normalizedBundleDir),
		path.basename(normalizedBundleDir)
	]);
	const archiveSha256 = await sha256File(archivePath);
	const runtimeBuildSha256 = await sha256File(path.join(normalizedBundleDir, 'runtime-build.json'));
	const sha256Path = `${archivePath}.sha256`;
	await writeFile(sha256Path, `${archiveSha256}  ${resolvedArchiveName}\n`, 'utf8');
	const descriptor = {
		format: 'wasm-swift-runtime-export-v1',
		archiveFile: resolvedArchiveName,
		archiveSha256,
		url: url ?? null,
		swiftVersion: manifest.swiftVersion,
		wasmSdkId: manifest.wasmSdkId,
		fingerprint: manifest.fingerprint,
		runtimeContract: manifest.runtimeContract,
		files: manifest.files,
		runtimeBuildSha256,
		buildSource: buildInfo.source
	};
	const descriptorPath = path.join(normalizedOutDir, `${resolvedArchiveName}.json`);
	await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
	return {
		bundleDir: normalizedBundleDir,
		archivePath,
		sha256Path,
		descriptorPath,
		archiveSha256,
		descriptor
	};
}

function usage() {
	return [
		'Usage: pnpm --dir runtime/swift run export:runtime -- [--bundle-dir <dir>] [--out-dir <dir>] [--archive-name <name.tar.gz>]',
		'',
		'Validates a packaged wasm-swift runtime bundle and writes a distributable archive, .sha256 file, and descriptor JSON.',
		'Use --browser-contract to run the Swift browser contract before exporting.',
		'Use --require-build-plan-provenance to require build-plan path, sha256, and contracts before exporting.',
		'Use --require-source-bootstrap-provenance to require source bootstrap receipt provenance before exporting.',
		'Use --require-browser-build-command-provenance to require browserCompilerBuild.command provenance before exporting.',
		'Use --require-browser-build-execution-provenance to require browserCompilerBuild.execution provenance before exporting.',
		'Use --require-browser-build-log-provenance to require browser build log provenance before exporting.',
		'Use --require-upstream-baseline-provenance to require passed upstream baseline receipt provenance before exporting.',
		'Use --url <http(s)-url> to record the expected published archive URL in the descriptor.'
	].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	try {
		const options = parseExportSwiftRuntimeArgs(process.argv.slice(2));
		if (options.help) {
			console.log(usage());
		} else {
			const result = await exportSwiftRuntimeArchive(options);
			console.log(
				`Exported wasm-swift runtime ${result.archivePath} sha256 ${result.archiveSha256}`
			);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
