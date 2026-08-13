#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';
import {
	SWIFT_RUNTIME_CONTRACT_CASES,
	createSwiftRuntimeContract,
	validateSwiftRuntimeContract
} from './runtime-contract.mjs';
import {
	validateSwiftRuntimeBuildInfo,
	validateSwiftRuntimeSdkChecksum
} from './runtime-build-info.mjs';
import { validateSwiftRuntimeManifestFiles } from './runtime-manifest.mjs';

export function buildSwiftWorkerRequest(testCase, baseUrl) {
	const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
	return {
		run: true,
		baseUrl: normalizedBaseUrl,
		manifestUrl: new URL('runtime-manifest.v1.json', normalizedBaseUrl).href,
		code: testCase.code,
		stdin: testCase.stdin,
		args: testCase.args,
		activePath: testCase.activePath,
		workspaceFiles: testCase.workspaceFiles,
		log: true
	};
}

export function collectSwiftWorkerResult(messages) {
	let stdout = '';
	const diagnostics = [];
	let completed = false;
	let error = '';
	for (const message of messages) {
		if (typeof message?.output === 'string') stdout += message.output;
		if (message?.diagnostic) diagnostics.push(message.diagnostic);
		if (message?.results) completed = true;
		if (typeof message?.error === 'string' && message.error) error = message.error;
	}
	return { stdout, diagnostics, completed, error };
}

export function assertSwiftContractCaseResult(testCase, messages) {
	const result = collectSwiftWorkerResult(messages);
	if (testCase.expectError) {
		if (!result.error) {
			throw new Error(`${testCase.name} was expected to fail but did not post a worker error.`);
		}
		if (
			testCase.expectedErrorPattern &&
			!new RegExp(testCase.expectedErrorPattern, 'u').test(result.error)
		) {
			throw new Error(
				`${testCase.name} error mismatch.\nExpected pattern:\n${testCase.expectedErrorPattern}\nActual:\n${result.error}`
			);
		}
		if (result.completed) {
			throw new Error(`${testCase.name} posted both an error and a successful results message.`);
		}
		if (result.stdout !== testCase.expectedStdout) {
			throw new Error(
				`${testCase.name} stdout mismatch.\nExpected:\n${testCase.expectedStdout}\nActual:\n${result.stdout}`
			);
		}
		return result;
	}
	if (result.error) {
		throw new Error(`${testCase.name} failed with worker error: ${result.error}`);
	}
	if (!result.completed) {
		throw new Error(`${testCase.name} did not post a successful results message.`);
	}
	if (result.stdout !== testCase.expectedStdout) {
		throw new Error(
			`${testCase.name} stdout mismatch.\nExpected:\n${testCase.expectedStdout}\nActual:\n${result.stdout}`
		);
	}
	return result;
}

export async function resolveChromiumExecutable(chromiumExecutable = '') {
	if (chromiumExecutable) return chromiumExecutable;
	const executablePath = chromium.executablePath();
	await access(executablePath);
	return executablePath;
}

async function startBundleServer(bundleDir) {
	const root = path.resolve(bundleDir);
	const requestCounts = new Map();
	const server = http.createServer(async (request, response) => {
		try {
			const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
			const relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
			if (relativePath) {
				requestCounts.set(relativePath, (requestCounts.get(relativePath) ?? 0) + 1);
			}
			response.setHeader('access-control-allow-origin', '*');
			response.setHeader('cross-origin-opener-policy', 'same-origin');
			response.setHeader('cross-origin-embedder-policy', 'require-corp');
			response.setHeader('cross-origin-resource-policy', 'cross-origin');
			if (!relativePath) {
				response.setHeader('content-type', 'text/html');
				response.writeHead(200);
				response.end('<!doctype html><title>wasm-swift contract</title>');
				return;
			}
			const resolvedPath = path.resolve(root, relativePath || 'index.html');
			if (!resolvedPath.startsWith(`${root}${path.sep}`) && resolvedPath !== root) {
				response.writeHead(403).end('forbidden');
				return;
			}
			let bytes = await readFile(resolvedPath).catch(() => null);
			if (!bytes && !resolvedPath.endsWith('.gz')) {
				bytes = await readFile(`${resolvedPath}.gz`).catch(() => null);
				if (bytes) response.setHeader('content-encoding', 'gzip');
			}
			if (!bytes) return response.writeHead(404).end('not found');
			if (resolvedPath.endsWith('.js')) response.setHeader('content-type', 'text/javascript');
			if (resolvedPath.endsWith('.json'))
				response.setHeader('content-type', 'application/json');
			if (resolvedPath.endsWith('.wasm'))
				response.setHeader('content-type', 'application/wasm');
			response.writeHead(200);
			response.end(bytes);
		} catch (error) {
			response.writeHead(500).end(error instanceof Error ? error.message : String(error));
		}
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		server.close();
		throw new Error('failed to start Swift runtime bundle server.');
	}
	return {
		baseUrl: `http://127.0.0.1:${address.port}/`,
		getRequestCount: (relativePath) => requestCounts.get(relativePath) ?? 0,
		close: () => new Promise((resolve) => server.close(resolve))
	};
}

async function readRuntimeBuildInfo(bundleDir) {
	const buildInfoPath = path.join(bundleDir, 'runtime-build.json');
	try {
		return JSON.parse(await readFile(buildInfoPath, 'utf8'));
	} catch (error) {
		throw new Error(
			`Swift runtime build metadata could not be read from ${buildInfoPath}: ${error.message}`
		);
	}
}

async function validateRuntimeBuildInfo(bundleDir, manifest) {
	const buildInfo = await readRuntimeBuildInfo(bundleDir);
	const errors = validateSwiftRuntimeBuildInfo(buildInfo);
	if (typeof buildInfo.source !== 'string' || buildInfo.source.trim().length === 0) {
		errors.push('source provenance is required');
	}
	if (buildInfo.swiftVersion !== manifest.swiftVersion) {
		errors.push(
			`swiftVersion ${buildInfo.swiftVersion} does not match manifest ${manifest.swiftVersion}`
		);
	}
	if (buildInfo.wasmSdkId !== manifest.wasmSdkId) {
		errors.push(`wasmSdkId ${buildInfo.wasmSdkId} does not match manifest ${manifest.wasmSdkId}`);
	}
	errors.push(
		...(await validateSwiftRuntimeSdkChecksum(buildInfo, {
			bundleDir,
			messagePrefix: ''
		}))
	);
	if (errors.length > 0) {
		throw new Error(`Swift runtime build metadata is invalid:\n${errors.join('\n')}`);
	}
	return buildInfo;
}

export async function validateSwiftRuntimeBundleInBrowser({
	bundleDir,
	chromiumExecutable = '',
	timeoutMs = 60_000,
	cases = SWIFT_RUNTIME_CONTRACT_CASES
}) {
	const contractErrors = validateSwiftRuntimeContract({
		...createSwiftRuntimeContract(),
		cases
	});
	if (contractErrors.length > 0) {
		throw new Error(`Swift browser runtime contract cases are invalid:\n${contractErrors.join('\n')}`);
	}
	const manifest = JSON.parse(
		await readFile(path.join(bundleDir, 'runtime-manifest.v1.json'), 'utf8')
	);
	const manifestErrors = await validateSwiftRuntimeManifestFiles(bundleDir, manifest);
	if (manifestErrors.length > 0) {
		throw new Error(`Swift runtime manifest is invalid:\n${manifestErrors.join('\n')}`);
	}
	await validateRuntimeBuildInfo(bundleDir, manifest);
	const server = await startBundleServer(bundleDir);
	const executablePath = await resolveChromiumExecutable(chromiumExecutable);
	const browser = await chromium.launch({
		executablePath,
		headless: true,
		args: ['--no-sandbox']
	});
	try {
		const page = await browser.newPage();
		await page.goto(server.baseUrl);
		const crossOriginIsolated = await page.evaluate(() => globalThis.crossOriginIsolated);
		if (!crossOriginIsolated) {
			throw new Error(
				'Swift browser runtime contract must run in a cross-origin isolated page.'
			);
		}
		await page.evaluate(async (baseUrl) => {
			const response = await fetch(new URL('runtime-manifest.v1.json', baseUrl).href);
			if (!response.ok) throw new Error(`manifest fetch failed: ${response.status}`);
			return await response.json();
		}, server.baseUrl);
		const workerAssetRequestCountsBefore = Object.fromEntries(
			['runtime-manifest.v1.json', 'swiftc.wasm', 'swiftpm.wasm', 'sdk.tar.gz'].map((asset) => [
				asset,
				server.getRequestCount(asset)
			])
		);
		const results = [];
		for (const testCase of cases) {
			const request = buildSwiftWorkerRequest(testCase, server.baseUrl);
			const messages = await page.evaluate(
				async ({ workerUrl, request, timeoutMs }) => {
					return await new Promise((resolve, reject) => {
						const worker = new Worker(workerUrl);
						const messages = [];
						const timeout = setTimeout(() => {
							worker.terminate();
							reject(
								new Error(`Swift worker contract timed out after ${timeoutMs}ms`)
							);
						}, timeoutMs);
						worker.onerror = (event) => {
							clearTimeout(timeout);
							worker.terminate();
							reject(new Error(event.message || 'Swift worker script error'));
						};
						worker.onmessage = (event) => {
							messages.push(event.data);
							if (event.data?.results || event.data?.error) {
								clearTimeout(timeout);
								worker.terminate();
								resolve(messages);
							}
						};
						worker.postMessage(request);
					});
				},
				{
					workerUrl: new URL('runner-worker.js', server.baseUrl).href,
					request,
					timeoutMs
				}
			);
			results.push({
				name: testCase.name,
				...assertSwiftContractCaseResult(testCase, messages)
			});
		}
		const missingWorkerAssetRequests = Object.entries(workerAssetRequestCountsBefore)
			.filter(([asset, countBefore]) => server.getRequestCount(asset) <= countBefore)
			.map(([asset]) => asset);
		if (missingWorkerAssetRequests.length > 0) {
			throw new Error(
				`Swift worker contract did not request required runtime assets: ${missingWorkerAssetRequests.join(', ')}`
			);
		}
		const workerAssetRequests = Object.fromEntries(
			Object.entries(workerAssetRequestCountsBefore).map(([asset, countBefore]) => [
				asset,
				server.getRequestCount(asset) - countBefore
			])
		);
		return { baseUrl: server.baseUrl, workerAssetRequests, results };
	} finally {
		await browser.close();
		await server.close();
	}
}

function readOptionValue(argv, index, optionName) {
	const value = argv[index + 1];
	if (typeof value !== 'string' || !value || value.startsWith('--')) {
		throw new Error(`${optionName} requires a value`);
	}
	return value;
}

function assertTimeoutMs(timeoutMs) {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error('timeoutMs must be a positive safe integer');
	}
}

export function parseSwiftRuntimeContractRunnerArgs(argv) {
	const options = {
		bundleDir: path.resolve('static', 'wasm-swift'),
		chromiumExecutable: process.env.WASM_IDLE_CHROMIUM_EXECUTABLE || '',
		timeoutMs: 60_000
	};
	let positionalCount = 0;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--bundle-dir') {
			options.bundleDir = path.resolve(readOptionValue(argv, index, arg));
			index += 1;
		} else if (arg === '--chromium-executable') {
			options.chromiumExecutable = readOptionValue(argv, index, arg);
			index += 1;
		} else if (arg === '--timeout-ms') {
			options.timeoutMs = Number(readOptionValue(argv, index, arg));
			assertTimeoutMs(options.timeoutMs);
			index += 1;
		} else if (!arg.startsWith('-')) {
			positionalCount += 1;
			if (positionalCount > 1) {
				throw new Error('validate:contract accepts at most one bundleDir positional argument');
			}
			options.bundleDir = path.resolve(arg);
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	assertTimeoutMs(options.timeoutMs);
	return options;
}

async function main(argv = process.argv.slice(2)) {
	const options = parseSwiftRuntimeContractRunnerArgs(argv);
	const contract = createSwiftRuntimeContract();
	const result = await validateSwiftRuntimeBundleInBrowser(options);
	console.log(
		JSON.stringify(
			{
				contract: contract.format,
				bundleDir: options.bundleDir,
				baseUrl: result.baseUrl,
				workerAssetRequests: result.workerAssetRequests,
				results: result.results.map((entry) => ({
					name: entry.name,
					stdout: entry.stdout,
					diagnostics: entry.diagnostics.length
				}))
			},
			null,
			2
		)
	);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
