import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
	checkSwiftReadiness,
	coreRegistersSwift,
	pageRegistryRegistersSwift,
	parseSwiftReadinessArgs,
	SWIFT_SYNC_RECEIPT_FILE,
	SWIFT_SYNC_RECEIPT_FORMAT,
	sourceRegistersSwift,
	supportMatrixRegistersSwift,
	swiftAssetVersionFromSource
} from './readiness.mjs';
import {
	REQUIRED_RUNTIME_FILES,
	buildFileEntries,
	createSwiftRuntimeManifest,
	fingerprintFileEntries
} from './runtime-manifest.mjs';
import {
	BUILD_PLAN_SNAPSHOT_FILE,
	BROWSER_BUILD_LOG_SNAPSHOT_FILE,
	SOURCE_BOOTSTRAP_RECEIPT_SNAPSHOT_FILE,
	createSwiftRuntimeBuildInfo,
	swiftBaselineReceiptSnapshotFile
} from './runtime-build-info.mjs';
import { createSwiftRuntimeContract } from './runtime-contract.mjs';

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
	const manifest = await (await fetch(manifestUrl)).json();
	const swiftcUrl = new URL('swiftc.wasm', baseUrl).href;
	const swiftpmUrl = new URL('swiftpm.wasm', baseUrl).href;
	const sdkUrl = new URL('sdk.tar.gz', baseUrl).href;
	self.postMessage({ progress: { percent: 1, stage: 'Loading Swift' } });
	self.postMessage({ output: [run, baseUrl, manifestUrl, code, stdin, args, activePath, workspaceFiles, manifest.runtime, swiftcUrl, swiftpmUrl, sdkUrl].join('\\n') });
	self.postMessage({ results: true });
	self.postMessage({ error: '' });
};
`;

const CONTRACT_RUNNER_WORKER_SOURCE = `
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
	const swiftc = new Uint8Array(await (await fetch(new URL('swiftc.wasm', baseUrl))).arrayBuffer());
	const swiftpm = new Uint8Array(await (await fetch(new URL('swiftpm.wasm', baseUrl))).arrayBuffer());
	const sdk = new Uint8Array(await (await fetch(new URL('sdk.tar.gz', baseUrl))).arrayBuffer());
	if (manifest.runtime !== 'Swift' || swiftc[0] !== 0 || swiftpm[0] !== 0 || sdk[0] !== 31) {
		self.postMessage({ error: 'invalid Swift runtime assets' });
		return;
	}
	if (code.includes('let =')) {
		self.postMessage({ error: 'Swift compiler failed' });
		return;
	} else if (code.includes('second = readLine()')) {
		const lines = stdin.trimEnd().split('\\n');
		self.postMessage({ output: 'swift-stdin-lines:' + lines[0] + '|' + lines[1] + '\\n' });
	} else if (code.includes('readLine')) {
		self.postMessage({ output: 'swift-stdin:' + stdin.trimEnd() + '\\n' });
	} else if (code.includes('CommandLine.arguments')) {
		self.postMessage({ output: args.join(',') + '\\n' });
	} else if (workspaceFiles.some((file) => file.path === 'Sources/Helper.swift')) {
		self.postMessage({ output: 'workspace-ok\\n' });
	} else {
		self.postMessage({ error: 'unknown Swift contract case' });
		return;
	}
	self.postMessage({ results: true });
};
`;
const VALID_SDK_ARCHIVE_BYTES = Uint8Array.from(gzipSync(Uint8Array.of(115, 100, 107)));

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function createValidBuildPlan(planDir) {
	const expectedOutputs = {
		'runner-worker.js': path.join(planDir, 'runner-worker.js'),
		'swiftc.wasm': path.join(planDir, 'swiftc.wasm'),
		'swiftpm.wasm': path.join(planDir, 'swiftpm.wasm'),
		'sdk.tar.gz': path.join(planDir, 'sdk.tar.gz')
	};
	return {
		format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
		checkoutRoot: planDir,
		buildDir: planDir,
		rawRuntimeDir: path.join(planDir, 'raw-runtime'),
		expectedOutputs,
		browserCompilerBuild: {
			command: './build-swift-browser.sh',
			execution: {
				status: 'passed',
				command: './build-swift-browser.sh',
				cwd: planDir,
				buildDir: planDir,
				rawRuntimeDir: path.join(planDir, 'raw-runtime'),
				planPath: path.join(planDir, 'build-plan.json'),
				startedAt: '2026-01-01T00:00:00.000Z',
				finishedAt: '2026-01-01T00:00:01.000Z',
				exitCode: 0
			},
			runtimeContract: createSwiftRuntimeContract(),
			requiredOutputs: [
				{
					name: 'runner-worker.js',
					expectedPath: expectedOutputs['runner-worker.js'],
					validation: 'validateSwiftRunnerWorkerSource'
				},
				{
					name: 'swiftc.wasm',
					expectedPath: expectedOutputs['swiftc.wasm'],
					validation: 'validateSwiftCompilerWasmModuleBytes',
					requiredIdentity: ['swift', 'swiftc']
				},
				{
					name: 'swiftpm.wasm',
					expectedPath: expectedOutputs['swiftpm.wasm'],
					validation: 'validateSwiftCompilerWasmModuleBytes',
					requiredIdentity: ['swiftpm', 'SwiftPM']
				},
				{
					name: 'sdk.tar.gz',
					expectedPath: expectedOutputs['sdk.tar.gz'],
					validation: 'validateSwiftSdkArchiveBytes'
				}
			]
		}
	};
}

async function writeBaselineReceipt(repoDir, overrides = {}) {
	const receiptPath = path.join(repoDir, 'baseline-receipt.json');
	const receiptBytes = Buffer.from(
		`${JSON.stringify(
			{
				format: 'wasm-idle-swift-upstream-baseline-build-v1',
				planPath: path.join(repoDir, 'build-plan.json'),
				preset: 'buildbot_linux_crosscompile_wasm',
				command: ['swift/utils/build-script', '--preset', 'buildbot_linux_crosscompile_wasm'],
				cwd: repoDir,
				status: 'passed',
				exitCode: 0,
				startedAt: '2026-01-01T00:00:00.000Z',
				finishedAt: '2026-01-01T00:00:01.000Z',
				note: 'unit test receipt',
				...overrides
			},
			null,
			2
		)}\n`
	);
	await writeFileEnsuringDir(receiptPath, receiptBytes);
	return { receiptPath, receiptDigest: sha256(receiptBytes) };
}

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

const CONTRACT_RUNNER_FETCHES_COMPILER_WORKER_SOURCE = `
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
	const manifest = await (await fetch(manifestUrl)).json();
	const swiftc = new Uint8Array(await (await fetch(new URL('swiftc.wasm', baseUrl))).arrayBuffer());
	const swiftpm = new Uint8Array(await (await fetch(new URL('swiftpm.wasm', baseUrl))).arrayBuffer());
	const sdk = new Uint8Array(await (await fetch(new URL('sdk.tar.gz', baseUrl))).arrayBuffer());
	if (
		!baseUrl ||
		!run ||
		!manifestUrl ||
		!code ||
		!activePath ||
		manifest.runtime !== 'Swift' ||
		swiftc[0] !== 0 ||
		swiftc[1] !== 97 ||
		swiftc[2] !== 115 ||
		swiftc[3] !== 109 ||
		swiftpm[0] !== 0 ||
		sdk[0] !== 31
	) {
		self.postMessage({ error: 'invalid Swift run message or compiler asset' });
		return;
	}
	if (code.includes('let =')) {
		self.postMessage({ error: 'Swift compiler failed' });
		return;
	} else if (code.includes('second = readLine()')) {
		const lines = stdin.trimEnd().split('\\n');
		self.postMessage({ output: 'swift-stdin-lines:' + lines[0] + '|' + lines[1] + '\\n' });
	} else if (code.includes('readLine')) {
		self.postMessage({ output: 'swift-stdin:' + stdin.trimEnd() + '\\n' });
	} else if (code.includes('CommandLine.arguments')) {
		self.postMessage({ output: args.join(',') + '\\n' });
	} else if (workspaceFiles.some((file) => file.path === 'Sources/Helper.swift')) {
		self.postMessage({ output: 'workspace-ok\\n' });
	} else {
		self.postMessage({ error: 'unknown Swift contract case' });
		return;
	}
	self.postMessage({ results: true });
};
`;

async function writeFileEnsuringDir(filePath, contents) {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, contents);
}

async function writeRuntimeFile(
	baseDir,
	relativePath,
	runnerWorkerSource = VALID_RUNNER_WORKER_SOURCE
) {
	if (relativePath === 'runner-worker.js') {
		await writeFileEnsuringDir(path.join(baseDir, relativePath), runnerWorkerSource);
		return;
	}
	if (relativePath.endsWith('.wasm')) {
		await writeFileEnsuringDir(
			path.join(baseDir, relativePath),
			relativePath === 'swiftc.wasm'
				? taggedWasm('swiftc Swift compiler')
				: taggedWasm('swiftpm SwiftPM')
		);
		return;
	}
	if (relativePath === 'sdk.tar.gz') {
		await writeFileEnsuringDir(
			path.join(baseDir, relativePath),
			VALID_SDK_ARCHIVE_BYTES
		);
		return;
	}
	throw new Error(`unknown fixture file ${relativePath}`);
}

async function gzipOnlyWasmFiles(baseDir) {
	for (const wasmFile of ['swiftc.wasm', 'swiftpm.wasm']) {
		const wasmPath = path.join(baseDir, wasmFile);
		await writeFile(`${wasmPath}.gz`, gzipSync(await readFile(wasmPath)));
		await rm(wasmPath);
	}
}

async function writeCompressedAssetManifest(bundleDir, overrides = {}) {
	const manifest = JSON.parse(
		await readFile(path.join(bundleDir, 'runtime-manifest.v1.json'), 'utf8')
	);
	const bundleName = path.basename(bundleDir);
	const assets =
		overrides.assets ??
		['swiftc.wasm', 'swiftpm.wasm'].map((file) => `${bundleName}/${file}`);
	const sizes =
		overrides.sizes ??
		Object.fromEntries(
			['swiftc.wasm', 'swiftpm.wasm'].map((file) => [
				`${bundleName}/${file}`,
				manifest.files.find((entry) => entry.path === file).bytes
			])
		);
	await writeFileEnsuringDir(
		path.join(path.dirname(bundleDir), 'compressed-runtime-assets.v1.json'),
		`${JSON.stringify({ assets, sizes }, null, 2)}\n`
	);
}

async function writeBundle(
	baseDir,
	{
		runnerWorkerSource = VALID_RUNNER_WORKER_SOURCE,
		runtimeFileOverrides = {},
		gzipOnlyWasm = false,
		omitBuildInfo = false,
		buildInfoOverrides = {},
		manifestOverrides = {}
	} = {}
) {
	await mkdir(baseDir, { recursive: true });
	for (const file of REQUIRED_RUNTIME_FILES) {
		await writeRuntimeFile(baseDir, file, runnerWorkerSource);
	}
	for (const [relativePath, contents] of Object.entries(runtimeFileOverrides)) {
		await writeFileEnsuringDir(path.join(baseDir, relativePath), contents);
	}
	if (!omitBuildInfo) {
		const buildInfo = {
			...createSwiftRuntimeBuildInfo({
				swiftVersion: '6.3.3',
				wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
				source: 'unit-test-source'
			}),
			...buildInfoOverrides
		};
		const buildInfoSource = `${JSON.stringify(buildInfo, null, 2)}\n`;
		await writeFileEnsuringDir(path.join(baseDir, 'runtime-build.json'), buildInfoSource);
	}
	const files = await buildFileEntries(baseDir);
	const fingerprint = fingerprintFileEntries(files);
	const manifest = {
		...createSwiftRuntimeManifest({
			files,
			swiftVersion: '6.3.3',
			wasmSdkId: 'swift-6.3.3-RELEASE_wasm',
			fingerprint
		}),
		...manifestOverrides
	};
	await writeFileEnsuringDir(
		path.join(baseDir, 'runtime-manifest.v1.json'),
		`${JSON.stringify(manifest, null, 2)}\n`
	);
	if (!omitBuildInfo) {
		const buildInfoSource = await readFile(path.join(baseDir, 'runtime-build.json'), 'utf8');
		const buildInfo = JSON.parse(buildInfoSource);
		await writeFileEnsuringDir(
			path.join(baseDir, SWIFT_SYNC_RECEIPT_FILE),
			`${JSON.stringify(
				{
					format: SWIFT_SYNC_RECEIPT_FORMAT,
					sourceDir: path.resolve(baseDir, '..', '..', 'runtimes', 'wasm-swift', 'dist'),
					targetDir: path.resolve(baseDir),
					versionModulePath: path.resolve(
						baseDir,
						'..',
						'..',
						'src',
						'lib',
						'playground',
						'wasmSwiftVersion.ts'
					),
					fingerprint: manifest.fingerprint,
					swiftVersion: manifest.swiftVersion,
					wasmSdkId: manifest.wasmSdkId,
					runtimeContract: buildInfo.runtimeContract,
					runtimeBuildSha256: sha256(buildInfoSource)
				},
				null,
				2
			)}\n`
		);
	}
	if (gzipOnlyWasm) await gzipOnlyWasmFiles(baseDir);
	return fingerprint;
}

async function makeTempRepo({
	registered = false,
	coreRegistered = registered,
	pageRegistered = registered,
	supportMatrixRegistered = registered,
	assetVersion = 'manual',
	withBundle = false,
	runnerWorkerSource = VALID_RUNNER_WORKER_SOURCE,
	runtimeFileOverrides = {},
	gzipOnlyWasm = false,
	omitBuildInfo = false,
	buildInfoOverrides = {},
	manifestOverrides = {}
} = {}) {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-'));
	const bundleDir = path.join(repoDir, 'static', 'wasm-swift');
	let fingerprint = '';
	if (withBundle) {
		fingerprint = await writeBundle(bundleDir, {
			runnerWorkerSource,
			runtimeFileOverrides,
			gzipOnlyWasm,
			omitBuildInfo,
			buildInfoOverrides,
			manifestOverrides
		});
		assetVersion = assetVersion === '<fingerprint>' ? fingerprint : assetVersion;
	}
	const coreLanguagesPath = path.join(repoDir, 'packages', 'core', 'src', 'languages.ts');
	const playgroundIndexPath = path.join(repoDir, 'src', 'lib', 'playground', 'index.ts');
	const pageLanguageRegistryPath = path.join(repoDir, 'src', 'routes', 'language-registry.ts');
	const supportMatrixPath = path.join(repoDir, 'scripts', 'support-matrix.mjs');
	const swiftVersionModulePath = path.join(
		repoDir,
		'src',
		'lib',
		'playground',
		'wasmSwiftVersion.ts'
	);
	await writeFileEnsuringDir(
		coreLanguagesPath,
		coreRegistered
			? `export type WasmIdleLanguageId = 'CPP' | 'SWIFT';\nexport const supportedLanguageIds = ['CPP', 'SWIFT'];\nexport const DEFAULT_DEFERRED_PROGRESS_LANGUAGES = new Set<WasmIdleLanguageId>(['SWIFT']);\n`
			: `export type WasmIdleLanguageId = 'CPP';\nexport const supportedLanguageIds = ['CPP'];\nexport const DEFAULT_DEFERRED_PROGRESS_LANGUAGES = new Set<WasmIdleLanguageId>([]);\n`
	);
	await writeFileEnsuringDir(
		playgroundIndexPath,
		registered
			? `const sandboxRoutes = [{ aliases: ['SWIFT'], load: async () => { const { default: Swift } = await import('$lib/playground/swift'); return new Swift(); } }];\nexport const supportedLanguages = ['CPP', 'SWIFT'];\n`
			: `const sandboxRoutes = [{ aliases: ['CPP'], load: async () => ({}) }];\nexport const supportedLanguages = ['CPP'];\n`
	);
	await writeFileEnsuringDir(
		pageLanguageRegistryPath,
		pageRegistered
			? `type MonacoLanguageContributionLoader = () => Promise<unknown>;\nexport type PlaygroundLanguage = 'CPP' | 'SWIFT';\nexport const playgroundLanguages: PlaygroundLanguage[] = ['CPP', 'SWIFT'];\nexport const languageLabels: Record<PlaygroundLanguage, string> = { CPP: 'C++', SWIFT: 'Swift' };\nexport const editorLanguages: Record<PlaygroundLanguage, string> = { CPP: 'cpp', SWIFT: 'swift' };\nexport const argsHelpLanguages = new Set<PlaygroundLanguage>(['SWIFT']);\nexport const compilerDiagnosticLanguages = new Set<PlaygroundLanguage>(['SWIFT']);\nexport const diagnosticMarkerLanguages = new Set(['swift']);\nexport const monacoLanguageContributionLoaders: Record<string, MonacoLanguageContributionLoader> = { swift: () => import('monaco-editor/esm/vs/basic-languages/swift/swift.contribution.js') };\n`
			: `export type PlaygroundLanguage = 'CPP';\nexport const playgroundLanguages: PlaygroundLanguage[] = ['CPP'];\nexport const languageLabels: Record<PlaygroundLanguage, string> = { CPP: 'C++' };\nexport const editorLanguages: Record<PlaygroundLanguage, string> = { CPP: 'cpp' };\n`
	);
	await writeFileEnsuringDir(
		supportMatrixPath,
		supportMatrixRegistered
			? `export const supportMatrixRows = [{ language: 'Swift', ids: ['SWIFT'], stdin: 'Yes', browserTest: { file: 'src/lib/playground/swift.playwright.test.ts', env: 'WASM_IDLE_RUN_REAL_BROWSER_SWIFT' } }];\nexport const blockedCandidateRows = [];\n`
			: `export const supportMatrixRows = [{ ids: ['CPP'] }];\nexport const blockedCandidateRows = [{ candidateIds: ['SWIFT'] }];\n`
	);
	await writeFileEnsuringDir(
		swiftVersionModulePath,
		`export const WASM_SWIFT_ASSET_VERSION = '${assetVersion}';\n`
	);
	return {
		repoDir,
		bundleDir,
		coreLanguagesPath,
		playgroundIndexPath,
		pageLanguageRegistryPath,
		supportMatrixPath,
		swiftVersionModulePath,
		fingerprint
	};
}

test('detects Swift registration and asset version source snippets', () => {
	assert.equal(
		coreRegistersSwift(
			"export type WasmIdleLanguageId = 'CPP' | 'SWIFT'; export const supportedLanguageIds = ['CPP', 'SWIFT']; export const DEFAULT_DEFERRED_PROGRESS_LANGUAGES = new Set<WasmIdleLanguageId>(['SWIFT']);"
		),
		true
	);
	assert.equal(
		coreRegistersSwift(`
export type WasmIdleLanguageId =
	| 'CPP'
	| 'SWIFT';
export const supportedLanguageIds = [
	'CPP',
	'SWIFT'
];
export const DEFAULT_DEFERRED_PROGRESS_LANGUAGES = new Set<WasmIdleLanguageId>([
	'SWIFT'
]);
`),
		true
	);
	assert.equal(
		coreRegistersSwift(
			"export type WasmIdleLanguageId = 'CPP'; export const supportedLanguageIds = ['CPP', 'SWIFT']; export const DEFAULT_DEFERRED_PROGRESS_LANGUAGES = new Set<WasmIdleLanguageId>(['SWIFT']);"
		),
		false
	);
	assert.equal(
		coreRegistersSwift(
			"export type WasmIdleLanguageId = 'CPP';\nconst comment = 'SWIFT';\nexport const supportedLanguageIds = ['CPP', 'SWIFT'];\nexport const DEFAULT_DEFERRED_PROGRESS_LANGUAGES = new Set<WasmIdleLanguageId>(['SWIFT']);"
		),
		false
	);
	assert.equal(
		coreRegistersSwift(
			"export type WasmIdleLanguageId = 'CPP' | 'SWIFT'; export const supportedLanguageIds = ['CPP']; export const DEFAULT_DEFERRED_PROGRESS_LANGUAGES = new Set<WasmIdleLanguageId>(['SWIFT']);"
		),
		false
	);
	assert.equal(
		coreRegistersSwift(
			"export type WasmIdleLanguageId = 'CPP' | 'SWIFT'; export const supportedLanguageIds = ['CPP', 'SWIFT']; export const DEFAULT_DEFERRED_PROGRESS_LANGUAGES = new Set<WasmIdleLanguageId>([]);"
		),
		false
	);
	assert.equal(
		sourceRegistersSwift(
			"const sandboxRoutes = [{ aliases: ['SWIFT'], load: async () => { const { default: Swift } = await import('$lib/playground/swift'); return new Swift(); } }]; export const supportedLanguages = ['CPP', 'SWIFT'];"
		),
		true
	);
	assert.equal(sourceRegistersSwift("export const supportedLanguages = ['CPP', 'SWIFT'];"), false);
	assert.equal(
		sourceRegistersSwift(
			"const sandboxRoutes = [{ aliases: ['SWIFT'], load: async () => ({}) }]; export const supportedLanguages = ['CPP', 'SWIFT'];"
		),
		false
	);
	assert.equal(sourceRegistersSwift("export const supportedLanguages = ['CPP'];"), false);
	assert.equal(
		pageRegistryRegistersSwift(
			"export type PlaygroundLanguage = 'CPP' | 'SWIFT'; export const playgroundLanguages: PlaygroundLanguage[] = ['CPP', 'SWIFT']; export const languageLabels: Record<PlaygroundLanguage, string> = { CPP: 'C++', SWIFT: 'Swift' }; export const editorLanguages: Record<PlaygroundLanguage, string> = { CPP: 'cpp', SWIFT: 'swift' }; export const argsHelpLanguages = new Set<PlaygroundLanguage>(['SWIFT']); export const compilerDiagnosticLanguages = new Set<PlaygroundLanguage>(['SWIFT']); export const diagnosticMarkerLanguages = new Set(['swift']); export const monacoLanguageContributionLoaders: Record<string, MonacoLanguageContributionLoader> = { swift: () => import('monaco-editor/esm/vs/basic-languages/swift/swift.contribution.js') };"
		),
		true
	);
	assert.equal(
		pageRegistryRegistersSwift(
			"export type PlaygroundLanguage = 'CPP' | 'SWIFT'; export const playgroundLanguages: PlaygroundLanguage[] = ['CPP', 'SWIFT'];"
		),
		false
	);
	assert.equal(
		pageRegistryRegistersSwift(
			"export type PlaygroundLanguage = 'CPP' | 'SWIFT'; export const playgroundLanguages: PlaygroundLanguage[] = ['CPP', 'SWIFT']; export const languageLabels: Record<PlaygroundLanguage, string> = { CPP: 'C++', SWIFT: 'Swift' }; export const editorLanguages: Record<PlaygroundLanguage, string> = { CPP: 'cpp', SWIFT: 'swift' }; export const argsHelpLanguages = new Set<PlaygroundLanguage>(['SWIFT']); export const compilerDiagnosticLanguages = new Set<PlaygroundLanguage>(['SWIFT']); export const diagnosticMarkerLanguages = new Set(['swift']); export const monacoLanguageContributionLoaders: Record<string, MonacoLanguageContributionLoader> = {};"
		),
		false
	);
	assert.equal(
		pageRegistryRegistersSwift(
			"export type PlaygroundLanguage = 'CPP'; export const playgroundLanguages: PlaygroundLanguage[] = ['CPP']; export const languageLabels: Record<PlaygroundLanguage, string> = { CPP: 'C++' }; export const editorLanguages: Record<PlaygroundLanguage, string> = { CPP: 'cpp' };"
		),
		false
	);
	assert.equal(
		supportMatrixRegistersSwift(
			"export const supportMatrixRows = [{ language: 'Swift', ids: ['SWIFT'], stdin: 'Yes', browserTest: { file: 'src/lib/playground/swift.playwright.test.ts', env: 'WASM_IDLE_RUN_REAL_BROWSER_SWIFT' } }]; export const blockedCandidateRows = [];"
		),
		true
	);
	assert.equal(
		supportMatrixRegistersSwift(
			"export const supportMatrixRows = [{ language: 'Swift', ids: ['SWIFT'], stdin: 'Blocked' }]; export const blockedCandidateRows = [];"
		),
		false
	);
	assert.equal(
		supportMatrixRegistersSwift(
			"export const supportMatrixRows = [{ ids: ['SWIFT'] }]; export const blockedCandidateRows = [{ candidateIds: ['SWIFT'] }];"
		),
		false
	);
	assert.equal(
		swiftAssetVersionFromSource("export const WASM_SWIFT_ASSET_VERSION = 'abc123';"),
		'abc123'
	);
});

test('parses and validates Swift readiness CLI arguments', () => {
	assert.deepEqual(
		parseSwiftReadinessArgs([
			'--',
			'--require-registered',
			'--require-build-plan-provenance',
			'--require-source-bootstrap-provenance',
			'--require-browser-build-command-provenance',
			'--require-browser-build-execution-provenance',
			'--require-browser-build-log-provenance',
			'--require-upstream-baseline-provenance',
			'--require-compressed-manifest',
			'--browser-contract',
			'--bundle-dir',
			'static/wasm-swift',
			'--timeout-ms',
			'10000'
		]),
		{
			requireRegistered: true,
			requireBuildPlanProvenance: true,
			requireSourceBootstrapProvenance: true,
			requireBrowserBuildCommandProvenance: true,
			requireBrowserBuildExecutionProvenance: true,
			requireBrowserBuildLogProvenance: true,
			requireBaselineProvenance: true,
			requireCompressedManifest: true,
			runBrowserContract: true,
			bundleDir: 'static/wasm-swift',
			timeoutMs: 10_000
		}
	);
	assert.throws(
		() => parseSwiftReadinessArgs(['--bundle-dir']),
		/--bundle-dir requires a value/u
	);
	assert.throws(
		() => parseSwiftReadinessArgs(['--timeout-ms']),
		/--timeout-ms requires a value/u
	);
	for (const timeout of ['0', '-1', '1.5', 'abc']) {
		assert.throws(
			() => parseSwiftReadinessArgs(['--timeout-ms', timeout]),
			/timeoutMs must be a positive safe integer/u
		);
	}
	assert.throws(() => parseSwiftReadinessArgs(['--unknown']), /Unknown option/u);
});

test('reports Swift readiness CLI argument errors without stack traces', async () => {
	const { spawnSync } = await import('node:child_process');
	const scriptPath = path.resolve(import.meta.dirname, 'readiness.mjs');
	const invalidOption = spawnSync(process.execPath, [scriptPath, '--unknown'], {
		encoding: 'utf8'
	});
	const invalidTimeout = spawnSync(
		process.execPath,
		[scriptPath, '--timeout-ms', 'not-a-number'],
		{ encoding: 'utf8' }
	);

	assert.notEqual(invalidOption.status, 0);
	assert.match(invalidOption.stderr, /Unknown option: --unknown/u);
	assert.doesNotMatch(invalidOption.stderr, /\n\s+at /u);
	assert.notEqual(invalidTimeout.status, 0);
	assert.match(
		invalidTimeout.stderr,
		/timeoutMs must be a positive safe integer when provided/u
	);
	assert.doesNotMatch(invalidTimeout.stderr, /\n\s+at /u);
});

test('reports missing bundle and manual asset version as not ready', async () => {
	const fixture = await makeTempRepo();
	try {
		const report = await checkSwiftReadiness(fixture);
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, false);
		assert.match(
			report.errors.join('\n'),
			/WASM_SWIFT_ASSET_VERSION is still manual|bundle directory was not found/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('requires SWIFT registration when requested', async () => {
	const fixture = await makeTempRepo({ withBundle: true, assetVersion: '<fingerprint>' });
	try {
		const report = await checkSwiftReadiness({ ...fixture, requireRegistered: true });
		assert.equal(report.ready, false);
		assert.match(report.errors.join('\n'), /packages\/core\/src\/languages\.ts/u);
		assert.match(report.errors.join('\n'), /src\/lib\/playground\/index\.ts/u);
		assert.match(report.errors.join('\n'), /src\/routes\/language-registry\.ts/u);
		assert.match(report.errors.join('\n'), /scripts\/support-matrix\.mjs/u);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('rejects partial Swift registration surfaces when registration is required', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		coreRegistered: true,
		pageRegistered: false,
		supportMatrixRegistered: true,
		withBundle: true,
		assetVersion: '<fingerprint>'
	});
	try {
		const report = await checkSwiftReadiness({ ...fixture, requireRegistered: true });
		assert.equal(report.ready, false);
		assert.equal(report.coreRegistered, true);
		assert.equal(report.playgroundRegistered, true);
		assert.equal(report.pageRegistered, false);
		assert.equal(report.supportMatrixRegistered, true);
		assert.match(report.errors.join('\n'), /src\/routes\/language-registry\.ts/u);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('rejects bundle fingerprint mismatches', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: 'badbadbadbadbadb'
	});
	try {
		const report = await checkSwiftReadiness(fixture);
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, true);
		assert.match(report.errors.join('\n'), /does not match manifest fingerprint/u);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('rejects bundles with invalid Swift runtime file signatures', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		runtimeFileOverrides: {
			'swiftc.wasm': 'not wasm'
		}
	});
	try {
		const report = await checkSwiftReadiness(fixture);
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, false);
		assert.match(
			report.errors.join('\n'),
			/swiftc\.wasm must start with the WebAssembly binary magic header/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('rejects bundles whose compiler wasm files lack Swift identity metadata', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		runtimeFileOverrides: {
			'swiftc.wasm': Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)
		}
	});
	try {
		const report = await checkSwiftReadiness(fixture);
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, false);
		assert.match(
			report.errors.join('\n'),
			/swiftc\.wasm must contain Swift compiler or SwiftPM identity metadata/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('rejects bundles whose runner worker does not match the playground contract', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		runnerWorkerSource: 'self.onmessage = () => {};\n'
	});
	try {
		const report = await checkSwiftReadiness(fixture);
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, true);
		assert.match(
			report.errors.join('\n'),
			/Swift runner-worker\.js does not match the playground contract/u
		);
		assert.match(report.errors.join('\n'), /runner-worker\.js must read stdin/u);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('rejects synced bundles without Swift runtime build metadata', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		omitBuildInfo: true
	});
	try {
		const report = await checkSwiftReadiness(fixture);
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, true);
		assert.match(report.errors.join('\n'), /runtime build metadata could not be read/u);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('rejects synced bundles without Swift runtime build provenance', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: { source: '   ' }
	});
	try {
		const report = await checkSwiftReadiness(fixture);
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, true);
		assert.match(report.errors.join('\n'), /source provenance is required/u);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('rejects synced bundles without a Swift sync receipt', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>'
	});
	try {
		await rm(path.join(fixture.bundleDir, SWIFT_SYNC_RECEIPT_FILE), { force: true });
		const report = await checkSwiftReadiness(fixture);
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, true);
		assert.match(report.errors.join('\n'), /Swift sync receipt could not be read/u);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('rejects synced bundles whose Swift sync receipt does not match the manifest', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>'
	});
	try {
		const receiptPath = path.join(fixture.bundleDir, SWIFT_SYNC_RECEIPT_FILE);
		const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
		await writeFileEnsuringDir(
			receiptPath,
			`${JSON.stringify({ ...receipt, fingerprint: 'badbadbadbadbadb' }, null, 2)}\n`
		);
		const report = await checkSwiftReadiness(fixture);
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, true);
		assert.match(report.errors.join('\n'), /sync receipt fingerprint .* does not match manifest/u);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('rejects synced bundles with stale Swift runtime contract metadata', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			runtimeContract: {
				format: 'wasm-swift-runtime-contract-v1',
				version: 1
			}
		}
	});
	try {
		const report = await checkSwiftReadiness(fixture);
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, true);
		assert.match(report.errors.join('\n'), /runtime-build\.json runtimeContract\.version must be 2/u);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('requires Swift upstream baseline provenance when requested', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>'
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBaselineProvenance: true
		});
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, true);
		assert.match(
			report.errors.join('\n'),
			/upstream baseline receipt provenance is required/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('requires Swift build plan provenance when requested', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>'
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBuildPlanProvenance: true
		});
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, true);
		assert.match(report.errors.join('\n'), /build plan provenance is required/u);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('accepts Swift build plan provenance when requested', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-plan-'));
	const planPath = path.join(repoDir, 'build-plan.json');
	const planBytes = Buffer.from(`${JSON.stringify(createValidBuildPlan(repoDir), null, 2)}\n`);
	await writeFileEnsuringDir(planPath, planBytes);
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			source: `unit test; build-plan=${planPath}; build-plan-sha256=${sha256(planBytes)}`
		}
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBuildPlanProvenance: true
		});
		assert.equal(report.ready, true);
		assert.deepEqual(report.errors, []);
		assert.deepEqual(report.provenance.buildPlan, {
			planPath,
			sourcePath: planPath,
			usedSnapshot: false
		});
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('accepts bundled Swift build plan snapshot when the external plan path is gone', async () => {
	const externalBuildDir = await mkdtemp(
		path.join(tmpdir(), 'wasm-idle-swift-readiness-plan-snapshot-source-')
	);
	const planPath = path.join(externalBuildDir, 'build-plan.json');
	const planBytes = Buffer.from(
		`${JSON.stringify(createValidBuildPlan(externalBuildDir), null, 2)}\n`
	);
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		runtimeFileOverrides: {
			[BUILD_PLAN_SNAPSHOT_FILE]: planBytes
		},
		buildInfoOverrides: {
			source: `unit test; build-plan=${planPath}; build-plan-sha256=${sha256(planBytes)}`
		}
	});
	try {
		await rm(externalBuildDir, { recursive: true, force: true });
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBuildPlanProvenance: true
		});
		assert.equal(report.ready, true);
		assert.deepEqual(report.errors, []);
		assert.deepEqual(report.provenance.buildPlan, {
			planPath,
			sourcePath: path.join(fixture.bundleDir, BUILD_PLAN_SNAPSHOT_FILE),
			usedSnapshot: true
		});
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(externalBuildDir, { recursive: true, force: true });
	}
});

test('accepts bundled Swift browser build log snapshot when the external log path is gone', async () => {
	const externalBuildDir = await mkdtemp(
		path.join(tmpdir(), 'wasm-idle-swift-readiness-build-log-snapshot-source-')
	);
	const logPath = path.join(externalBuildDir, 'browser-build.log');
	const logBytes = Buffer.from('browser build log\n');
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		runtimeFileOverrides: {
			[BROWSER_BUILD_LOG_SNAPSHOT_FILE]: logBytes
		},
		buildInfoOverrides: {
			source: `unit test; browser-build-log=${logPath}; browser-build-log-sha256=${sha256(logBytes)}`
		}
	});
	try {
		await rm(externalBuildDir, { recursive: true, force: true });
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBrowserBuildLogProvenance: true
		});
		assert.equal(report.ready, true);
		assert.deepEqual(report.errors, []);
		assert.deepEqual(report.provenance.browserBuildLog, {
			logPath,
			sourcePath: path.join(fixture.bundleDir, BROWSER_BUILD_LOG_SNAPSHOT_FILE),
			usedSnapshot: true
		});
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(externalBuildDir, { recursive: true, force: true });
	}
});

test('rejects Swift browser build log provenance when the digest mismatches', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-build-log-bad-'));
	const logPath = path.join(repoDir, 'browser-build.log');
	await writeFileEnsuringDir(logPath, 'wrong log\n');
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			source: `unit test; browser-build-log=${logPath}; browser-build-log-sha256=${'a'.repeat(64)}`
		}
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBrowserBuildLogProvenance: true
		});
		assert.equal(report.ready, false);
		assert.match(
			report.errors.join('\n'),
			/browser build log sha256 mismatch for .*browser-build\.log/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('accepts bundled Swift source bootstrap receipt snapshot when the external receipt is gone', async () => {
	const externalBuildDir = await mkdtemp(
		path.join(tmpdir(), 'wasm-idle-swift-readiness-bootstrap-snapshot-source-')
	);
	const bootstrapReceiptPath = path.join(externalBuildDir, 'source-bootstrap-receipt.json');
	const bootstrapReceipt = {
		format: 'wasm-idle-swift-source-bootstrap-receipt-v1',
		status: 'passed',
		sourceRoot: path.join(externalBuildDir, 'checkout'),
		swiftRepository: 'https://github.com/swiftlang/swift.git',
		swiftRef: 'swift-6.3.3-RELEASE',
		swiftCloneDepth: 1,
		swiftCloneFilter: 'blob:none',
		dependencyScheme: 'main',
		startedAt: '2026-01-01T00:00:00.000Z',
		finishedAt: '2026-01-01T00:00:01.000Z',
		checkout: { ok: true, missing: [] }
	};
	const bootstrapReceiptBytes = Buffer.from(
		`${JSON.stringify(bootstrapReceipt, null, 2)}\n`
	);
	await writeFileEnsuringDir(bootstrapReceiptPath, bootstrapReceiptBytes);
	const planPath = path.join(externalBuildDir, 'build-plan.json');
	const plan = {
		...createValidBuildPlan(externalBuildDir),
		checkoutRoot: bootstrapReceipt.sourceRoot,
		sourceBootstrap: {
			path: bootstrapReceiptPath,
			...bootstrapReceipt
		}
	};
	plan.browserCompilerBuild.execution.cwd = bootstrapReceipt.sourceRoot;
	const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
	await writeFileEnsuringDir(planPath, planBytes);
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		runtimeFileOverrides: {
			[BUILD_PLAN_SNAPSHOT_FILE]: planBytes,
			[SOURCE_BOOTSTRAP_RECEIPT_SNAPSHOT_FILE]: bootstrapReceiptBytes
		},
		buildInfoOverrides: {
			source: `unit test; build-plan=${planPath}; build-plan-sha256=${sha256(planBytes)}; source-bootstrap-receipt=${bootstrapReceiptPath}; source-bootstrap-sha256=${sha256(bootstrapReceiptBytes)}`
		}
	});
	try {
		await rm(externalBuildDir, { recursive: true, force: true });
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBuildPlanProvenance: true,
			requireSourceBootstrapProvenance: true
		});
		assert.equal(report.ready, true);
		assert.deepEqual(report.errors, []);
		assert.deepEqual(report.provenance.sourceBootstrapReceipt, {
			receiptPath: bootstrapReceiptPath,
			sourcePath: path.join(fixture.bundleDir, SOURCE_BOOTSTRAP_RECEIPT_SNAPSHOT_FILE),
			usedSnapshot: true
		});
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(externalBuildDir, { recursive: true, force: true });
	}
});

test('rejects bundled Swift build plan snapshots whose digest does not match provenance', async () => {
	const externalBuildDir = await mkdtemp(
		path.join(tmpdir(), 'wasm-idle-swift-readiness-plan-snapshot-bad-')
	);
	const planPath = path.join(externalBuildDir, 'build-plan.json');
	const planBytes = Buffer.from(
		`${JSON.stringify(createValidBuildPlan(externalBuildDir), null, 2)}\n`
	);
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		runtimeFileOverrides: {
			[BUILD_PLAN_SNAPSHOT_FILE]: Buffer.from('{"format":"tampered"}\n')
		},
		buildInfoOverrides: {
			source: `unit test; build-plan=${planPath}; build-plan-sha256=${sha256(planBytes)}`
		}
	});
	try {
		await rm(externalBuildDir, { recursive: true, force: true });
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBuildPlanProvenance: true
		});
		assert.equal(report.ready, false);
		assert.match(
			report.errors.join('\n'),
			/build plan sha256 mismatch for .*build-plan\.snapshot\.json/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(externalBuildDir, { recursive: true, force: true });
	}
});

test('rejects Swift build plan provenance without browser compiler contracts', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-stale-plan-'));
	const planPath = path.join(repoDir, 'build-plan.json');
	const stalePlan = createValidBuildPlan(repoDir);
	delete stalePlan.browserCompilerBuild;
	const planBytes = Buffer.from(`${JSON.stringify(stalePlan, null, 2)}\n`);
	await writeFileEnsuringDir(planPath, planBytes);
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			source: `unit test; build-plan=${planPath}; build-plan-sha256=${sha256(planBytes)}`
		}
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBuildPlanProvenance: true
		});
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, true);
		assert.match(
			report.errors.join('\n'),
			/runtime-build\.json build plan browserCompilerBuild\.requiredOutputs must be an array/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('rejects Swift build plan provenance without browser build command when required', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-plan-command-'));
	const planPath = path.join(repoDir, 'build-plan.json');
	const stalePlan = createValidBuildPlan(repoDir);
	delete stalePlan.browserCompilerBuild.command;
	const planBytes = Buffer.from(`${JSON.stringify(stalePlan, null, 2)}\n`);
	await writeFileEnsuringDir(planPath, planBytes);
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			source: `unit test; build-plan=${planPath}; build-plan-sha256=${sha256(planBytes)}`
		}
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBuildPlanProvenance: true,
			requireBrowserBuildCommandProvenance: true
		});
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, true);
		assert.match(
			report.errors.join('\n'),
			/runtime-build\.json build plan browserCompilerBuild\.command is required/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('rejects Swift build plan provenance without browser build execution when required', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-plan-execution-'));
	const planPath = path.join(repoDir, 'build-plan.json');
	const stalePlan = createValidBuildPlan(repoDir);
	delete stalePlan.browserCompilerBuild.execution;
	const planBytes = Buffer.from(`${JSON.stringify(stalePlan, null, 2)}\n`);
	await writeFileEnsuringDir(planPath, planBytes);
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			source: `unit test; build-plan=${planPath}; build-plan-sha256=${sha256(planBytes)}`
		}
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBuildPlanProvenance: true,
			requireBrowserBuildCommandProvenance: true,
			requireBrowserBuildExecutionProvenance: true
		});
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, true);
		assert.match(
			report.errors.join('\n'),
			/runtime-build\.json build plan browserCompilerBuild\.execution provenance is required/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('rejects Swift build plan provenance without source bootstrap provenance when required', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-plan-bootstrap-'));
	const planPath = path.join(repoDir, 'build-plan.json');
	const planBytes = Buffer.from(`${JSON.stringify(createValidBuildPlan(repoDir), null, 2)}\n`);
	await writeFileEnsuringDir(planPath, planBytes);
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			source: `unit test; build-plan=${planPath}; build-plan-sha256=${sha256(planBytes)}`
		}
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBuildPlanProvenance: true,
			requireBrowserBuildCommandProvenance: true,
			requireSourceBootstrapProvenance: true
		});
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, true);
		assert.match(
			report.errors.join('\n'),
			/runtime-build\.json build plan sourceBootstrap provenance is required/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('rejects malformed Swift build plan provenance JSON with context', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-bad-plan-json-'));
	const planPath = path.join(repoDir, 'build-plan.json');
	const planBytes = Buffer.from('{"format":\n');
	await writeFileEnsuringDir(planPath, planBytes);
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			source: `unit test; build-plan=${planPath}; build-plan-sha256=${sha256(planBytes)}`
		}
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBuildPlanProvenance: true
		});
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, true);
		assert.match(
			report.errors.join('\n'),
			/runtime-build\.json build plan could not be parsed at .*build-plan\.json/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('accepts Swift upstream baseline provenance when requested', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-baseline-'));
	const { receiptPath, receiptDigest } = await writeBaselineReceipt(repoDir);
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			source:
				`unit test; upstream-baseline-buildbot_linux_crosscompile_wasm-receipt=${receiptPath}; upstream-baseline-buildbot_linux_crosscompile_wasm-sha256=${receiptDigest}`
		}
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBaselineProvenance: true
		});
		assert.equal(report.ready, true);
		assert.deepEqual(report.errors, []);
		assert.deepEqual(report.provenance.baselineReceipts, [
			{
				preset: 'buildbot_linux_crosscompile_wasm',
				receiptPath,
				sourcePath: receiptPath,
				usedSnapshot: false
			}
		]);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('accepts bundled Swift upstream baseline receipt snapshot when the external receipt is gone', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-baseline-snapshot-'));
	const { receiptPath, receiptDigest } = await writeBaselineReceipt(repoDir);
	const receiptBytes = await readFile(receiptPath);
	const preset = 'buildbot_linux_crosscompile_wasm';
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		runtimeFileOverrides: {
			[swiftBaselineReceiptSnapshotFile(preset)]: receiptBytes
		},
		buildInfoOverrides: {
			source:
				`unit test; upstream-baseline-${preset}-receipt=${receiptPath}; upstream-baseline-${preset}-sha256=${receiptDigest}`
		}
	});
	try {
		await rm(repoDir, { recursive: true, force: true });
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBaselineProvenance: true
		});
		assert.equal(report.ready, true);
		assert.deepEqual(report.errors, []);
		assert.deepEqual(report.provenance.baselineReceipts, [
			{
				preset,
				receiptPath,
				sourcePath: path.join(fixture.bundleDir, swiftBaselineReceiptSnapshotFile(preset)),
				usedSnapshot: true
			}
		]);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('rejects bundled Swift upstream baseline receipt snapshots whose digest does not match provenance', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-baseline-snapshot-bad-'));
	const { receiptPath, receiptDigest } = await writeBaselineReceipt(repoDir);
	const preset = 'buildbot_linux_crosscompile_wasm';
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		runtimeFileOverrides: {
			[swiftBaselineReceiptSnapshotFile(preset)]: Buffer.from('{"format":"tampered"}\n')
		},
		buildInfoOverrides: {
			source:
				`unit test; upstream-baseline-${preset}-receipt=${receiptPath}; upstream-baseline-${preset}-sha256=${receiptDigest}`
		}
	});
	try {
		await rm(repoDir, { recursive: true, force: true });
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBaselineProvenance: true
		});
		assert.equal(report.ready, false);
		assert.match(
			report.errors.join('\n'),
			/upstream baseline receipt sha256 mismatch for .*upstream-baseline-buildbot_linux_crosscompile_wasm\.snapshot\.json/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('rejects Swift upstream baseline receipts whose planPath differs from build plan provenance', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-baseline-plan-match-'));
	const planPath = path.join(repoDir, 'build-plan.json');
	const otherPlanPath = path.join(repoDir, 'other-build-plan.json');
	const planBytes = Buffer.from(`${JSON.stringify(createValidBuildPlan(repoDir), null, 2)}\n`);
	await writeFileEnsuringDir(planPath, planBytes);
	const { receiptPath, receiptDigest } = await writeBaselineReceipt(repoDir, {
		planPath: otherPlanPath
	});
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			source:
				`unit test; build-plan=${planPath}; build-plan-sha256=${sha256(planBytes)}; upstream-baseline-buildbot_linux_crosscompile_wasm-receipt=${receiptPath}; upstream-baseline-buildbot_linux_crosscompile_wasm-sha256=${receiptDigest}`
		}
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBuildPlanProvenance: true,
			requireBaselineProvenance: true
		});
		assert.equal(report.ready, false);
		assert.match(
			report.errors.join('\n'),
			/upstream baseline receipt planPath .*other-build-plan\.json does not match build plan provenance .*build-plan\.json/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('rejects Swift upstream baseline receipts whose command differs from build plan provenance', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-baseline-command-match-'));
	const planPath = path.join(repoDir, 'build-plan.json');
	const plan = {
		...createValidBuildPlan(repoDir),
		upstreamWasmBaseline: {
			presets: ['buildbot_linux_crosscompile_wasm'],
			commands: [
				['swift/utils/build-script', '--preset', 'buildbot_linux_crosscompile_wasm']
			]
		}
	};
	const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
	await writeFileEnsuringDir(planPath, planBytes);
	const { receiptPath, receiptDigest } = await writeBaselineReceipt(repoDir, {
		planPath,
		command: ['swift/utils/build-script', '--preset', 'other_wasm_preset']
	});
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			source:
				`unit test; build-plan=${planPath}; build-plan-sha256=${sha256(planBytes)}; upstream-baseline-buildbot_linux_crosscompile_wasm-receipt=${receiptPath}; upstream-baseline-buildbot_linux_crosscompile_wasm-sha256=${receiptDigest}`
		}
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBuildPlanProvenance: true,
			requireBaselineProvenance: true
		});
		assert.equal(report.ready, false);
		assert.match(
			report.errors.join('\n'),
			/upstream baseline receipt command does not match build plan command for buildbot_linux_crosscompile_wasm/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('rejects Swift upstream baseline provenance when the receipt digest mismatches', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-baseline-digest-'));
	const { receiptPath } = await writeBaselineReceipt(repoDir);
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			source:
				`unit test; upstream-baseline-buildbot_linux_crosscompile_wasm-receipt=${receiptPath}; upstream-baseline-buildbot_linux_crosscompile_wasm-sha256=${'a'.repeat(64)}`
		}
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBaselineProvenance: true
		});
		assert.equal(report.ready, false);
		assert.match(report.errors.join('\n'), /upstream baseline receipt sha256 mismatch/u);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('rejects malformed Swift upstream baseline receipt JSON with context', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-baseline-json-'));
	const receiptPath = path.join(repoDir, 'baseline-receipt.json');
	const receiptBytes = Buffer.from('{"format":\n');
	await writeFileEnsuringDir(receiptPath, receiptBytes);
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			source:
				`unit test; upstream-baseline-buildbot_linux_crosscompile_wasm-receipt=${receiptPath}; upstream-baseline-buildbot_linux_crosscompile_wasm-sha256=${sha256(receiptBytes)}`
		}
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBaselineProvenance: true
		});
		assert.equal(report.ready, false);
		assert.match(
			report.errors.join('\n'),
			/runtime-build\.json upstream baseline receipt could not be parsed at .*baseline-receipt\.json/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('rejects Swift upstream baseline receipts with invalid format', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-baseline-format-'));
	const { receiptPath, receiptDigest } = await writeBaselineReceipt(repoDir, {
		format: 'not-a-swift-baseline-receipt'
	});
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			source:
				`unit test; upstream-baseline-buildbot_linux_crosscompile_wasm-receipt=${receiptPath}; upstream-baseline-buildbot_linux_crosscompile_wasm-sha256=${receiptDigest}`
		}
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBaselineProvenance: true
		});
		assert.equal(report.ready, false);
		assert.match(
			report.errors.join('\n'),
			/runtime-build\.json upstream baseline receipt format is invalid/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('rejects Swift upstream baseline receipts whose preset does not match provenance key', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-baseline-preset-'));
	const { receiptPath, receiptDigest } = await writeBaselineReceipt(repoDir, {
		preset: 'other_wasm_preset'
	});
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			source:
				`unit test; upstream-baseline-buildbot_linux_crosscompile_wasm-receipt=${receiptPath}; upstream-baseline-buildbot_linux_crosscompile_wasm-sha256=${receiptDigest}`
		}
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBaselineProvenance: true
		});
		assert.equal(report.ready, false);
		assert.match(
			report.errors.join('\n'),
			/upstream baseline receipt preset other_wasm_preset does not match buildbot_linux_crosscompile_wasm/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('rejects Swift upstream baseline receipts without a preset', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-baseline-missing-preset-'));
	const { receiptPath, receiptDigest } = await writeBaselineReceipt(repoDir, {
		preset: undefined
	});
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			source:
				`unit test; upstream-baseline-buildbot_linux_crosscompile_wasm-receipt=${receiptPath}; upstream-baseline-buildbot_linux_crosscompile_wasm-sha256=${receiptDigest}`
		}
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBaselineProvenance: true
		});
		assert.equal(report.ready, false);
		assert.match(
			report.errors.join('\n'),
			/upstream baseline receipt preset missing does not match buildbot_linux_crosscompile_wasm/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('rejects Swift upstream baseline receipts with invalid plan and command metadata', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-baseline-shape-'));
	const { receiptPath, receiptDigest } = await writeBaselineReceipt(repoDir, {
		planPath: 'relative-build-plan.json',
		command: [],
		cwd: 'relative-checkout'
	});
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			source:
				`unit test; upstream-baseline-buildbot_linux_crosscompile_wasm-receipt=${receiptPath}; upstream-baseline-buildbot_linux_crosscompile_wasm-sha256=${receiptDigest}`
		}
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBaselineProvenance: true
		});
		assert.equal(report.ready, false);
		assert.match(
			report.errors.join('\n'),
			/upstream baseline receipt planPath must be absolute for buildbot_linux_crosscompile_wasm/u
		);
		assert.match(
			report.errors.join('\n'),
			/upstream baseline receipt command must be a non-empty string array for buildbot_linux_crosscompile_wasm/u
		);
		assert.match(
			report.errors.join('\n'),
			/upstream baseline receipt cwd must be absolute for buildbot_linux_crosscompile_wasm/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('rejects Swift upstream baseline provenance unless the receipt passed', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-baseline-status-'));
	const { receiptPath, receiptDigest } = await writeBaselineReceipt(repoDir, { status: 'dry-run' });
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			source:
				`unit test; upstream-baseline-buildbot_linux_crosscompile_wasm-receipt=${receiptPath}; upstream-baseline-buildbot_linux_crosscompile_wasm-sha256=${receiptDigest}`
		}
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBaselineProvenance: true
		});
		assert.equal(report.ready, false);
		assert.match(report.errors.join('\n'), /upstream baseline receipt status must be passed/u);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('rejects passed Swift upstream baseline receipts with nonzero exit code', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-baseline-exit-code-'));
	const { receiptPath, receiptDigest } = await writeBaselineReceipt(repoDir, { exitCode: 1 });
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			source:
				`unit test; upstream-baseline-buildbot_linux_crosscompile_wasm-receipt=${receiptPath}; upstream-baseline-buildbot_linux_crosscompile_wasm-sha256=${receiptDigest}`
		}
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBaselineProvenance: true
		});
		assert.equal(report.ready, false);
		assert.match(
			report.errors.join('\n'),
			/upstream baseline receipt exitCode must be 0 for buildbot_linux_crosscompile_wasm/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('rejects passed Swift upstream baseline receipts with invalid timestamps', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-baseline-timestamps-'));
	const { receiptPath, receiptDigest } = await writeBaselineReceipt(repoDir, {
		startedAt: 'not-a-date',
		finishedAt: undefined
	});
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			source:
				`unit test; upstream-baseline-buildbot_linux_crosscompile_wasm-receipt=${receiptPath}; upstream-baseline-buildbot_linux_crosscompile_wasm-sha256=${receiptDigest}`
		}
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBaselineProvenance: true
		});
		assert.equal(report.ready, false);
		assert.match(
			report.errors.join('\n'),
			/upstream baseline receipt startedAt must be an ISO timestamp/u
		);
		assert.match(
			report.errors.join('\n'),
			/upstream baseline receipt finishedAt must be an ISO timestamp/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('rejects passed Swift upstream baseline receipts whose finish precedes start', async () => {
	const repoDir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-readiness-baseline-time-order-'));
	const { receiptPath, receiptDigest } = await writeBaselineReceipt(repoDir, {
		startedAt: '2026-01-01T00:00:02.000Z',
		finishedAt: '2026-01-01T00:00:01.000Z'
	});
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			source:
				`unit test; upstream-baseline-buildbot_linux_crosscompile_wasm-receipt=${receiptPath}; upstream-baseline-buildbot_linux_crosscompile_wasm-sha256=${receiptDigest}`
		}
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireBaselineProvenance: true
		});
		assert.equal(report.ready, false);
		assert.match(
			report.errors.join('\n'),
			/upstream baseline receipt finishedAt must not be before startedAt/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test('rejects synced bundles when runtime build metadata does not match manifest', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			swiftVersion: '6.3.4',
			wasmSdkId: 'swift-6.3.4-RELEASE_wasm'
		}
	});
	try {
		const report = await checkSwiftReadiness(fixture);
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, true);
		assert.match(report.errors.join('\n'), /swiftVersion 6\.3\.4 does not match manifest/u);
		assert.match(report.errors.join('\n'), /wasmSdkId swift-6\.3\.4-RELEASE_wasm does not match manifest/u);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('rejects synced bundles with stale Swift runtime contract metadata in manifest', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		manifestOverrides: {
			runtimeContract: {
				format: 'wasm-swift-runtime-contract-v1',
				version: 1
			}
		}
	});
	try {
		const report = await checkSwiftReadiness(fixture);
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, false);
		assert.match(report.errors.join('\n'), /runtimeContract\.version must be 2/u);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('rejects synced bundles with inconsistent Swift SDK provenance metadata', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			wasmSdkUrl:
				'https://download.swift.org/swift-6.3.3-release/wasm-sdk/swift-6.3.3-RELEASE/other_wasm.artifactbundle.tar.gz',
			wasmSdkChecksum: 'd'.repeat(64)
		}
	});
	try {
		const report = await checkSwiftReadiness(fixture);
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, true);
		assert.match(
			report.errors.join('\n'),
			/wasmSdkUrl artifact name must match wasmSdkId/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('rejects synced bundles when SDK checksum metadata does not match sdk archive bytes', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			wasmSdkUrl:
				'https://download.swift.org/swift-6.3.3-release/wasm-sdk/swift-6.3.3-RELEASE/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
			wasmSdkChecksum: 'd'.repeat(64)
		}
	});
	try {
		const report = await checkSwiftReadiness(fixture);
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, true);
		assert.match(
			report.errors.join('\n'),
			/runtime-build\.json wasmSdkChecksum [a-f0-9]{64} does not match sdk\.tar\.gz sha256/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('accepts synced bundles when SDK checksum metadata matches sdk archive bytes', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		buildInfoOverrides: {
			wasmSdkUrl:
				'https://download.swift.org/swift-6.3.3-release/wasm-sdk/swift-6.3.3-RELEASE/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz',
			wasmSdkChecksum: sha256(VALID_SDK_ARCHIVE_BYTES)
		}
	});
	try {
		const report = await checkSwiftReadiness(fixture);
		assert.equal(report.ready, true);
		assert.equal(report.manifestValidated, true);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('marks a validated bundle ready before the expensive browser contract gate', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>'
	});
	try {
		const report = await checkSwiftReadiness({ ...fixture, requireRegistered: true });
		assert.equal(report.ready, true);
		assert.equal(report.registered, true);
		assert.equal(report.assetVersion, fixture.fingerprint);
		assert.equal(report.manifestValidated, true);
		assert.equal(report.browserContractValidated, false);
		assert.deepEqual(report.errors, []);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('marks an unregistered candidate bundle ready when registration is not required', async () => {
	const fixture = await makeTempRepo({
		withBundle: true,
		assetVersion: '<fingerprint>'
	});
	try {
		const report = await checkSwiftReadiness(fixture);
		assert.equal(report.ready, true);
		assert.equal(report.registered, false);
		assert.equal(report.assetVersion, fixture.fingerprint);
		assert.equal(report.manifestValidated, true);
		assert.equal(report.browserContractValidated, false);
		assert.deepEqual(report.errors, []);
		assert.deepEqual(report.warnings, []);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('warns when Swift is registered before the strict registration gate is requested', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>'
	});
	try {
		const report = await checkSwiftReadiness(fixture);
		assert.equal(report.ready, true);
		assert.equal(report.registered, true);
		assert.deepEqual(report.errors, []);
		assert.deepEqual(report.warnings, [
			'SWIFT is already registered; readiness must stay green before shipping.'
		]);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('marks a registered bundle ready when the browser contract passes', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		runnerWorkerSource: CONTRACT_RUNNER_WORKER_SOURCE
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			runBrowserContract: true,
			timeoutMs: 10_000
		});
		assert.equal(report.ready, true);
		assert.equal(report.manifestValidated, true);
		assert.equal(report.browserContractValidated, true);
		assert.deepEqual(report.errors, []);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('marks a registered gzip-only compiler bundle ready when the browser contract passes', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		runnerWorkerSource: CONTRACT_RUNNER_FETCHES_COMPILER_WORKER_SOURCE,
		gzipOnlyWasm: true
	});
	try {
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			runBrowserContract: true,
			timeoutMs: 10_000
		});
		assert.equal(report.ready, true);
		assert.equal(report.manifestValidated, true);
		assert.equal(report.browserContractValidated, true);
		assert.deepEqual(report.errors, []);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('requires compressed Swift compiler assets to be listed in the static compressed manifest', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		gzipOnlyWasm: true
	});
	try {
		let report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireCompressedManifest: true
		});
		assert.equal(report.ready, false);
		assert.equal(report.manifestValidated, true);
		assert.equal(report.compressedManifestValidated, false);
		assert.match(
			report.errors.join('\n'),
			/Swift compressed runtime asset manifest could not be read/u
		);

		await writeCompressedAssetManifest(fixture.bundleDir);
		report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireCompressedManifest: true
		});
		assert.equal(report.ready, true);
		assert.equal(report.manifestValidated, true);
		assert.equal(report.compressedManifestValidated, true);
		assert.deepEqual(report.errors, []);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});

test('rejects stale Swift compressed manifest entries during readiness', async () => {
	const fixture = await makeTempRepo({
		registered: true,
		withBundle: true,
		assetVersion: '<fingerprint>',
		gzipOnlyWasm: true
	});
	try {
		await writeCompressedAssetManifest(fixture.bundleDir, {
			assets: ['wasm-swift/swiftc.wasm', 'wasm-swift/old-swiftpm.wasm'],
			sizes: {
				'wasm-swift/swiftc.wasm': 1,
				'wasm-swift/old-swiftpm.wasm': 2
			}
		});
		const report = await checkSwiftReadiness({
			...fixture,
			requireRegistered: true,
			requireCompressedManifest: true
		});
		assert.equal(report.ready, false);
		assert.equal(report.compressedManifestValidated, false);
		assert.match(
			report.errors.join('\n'),
			/wasm-swift\/swiftpm\.wasm is missing|wasm-swift\/swiftc\.wasm size/u
		);
	} finally {
		await rm(fixture.repoDir, { recursive: true, force: true });
	}
});
