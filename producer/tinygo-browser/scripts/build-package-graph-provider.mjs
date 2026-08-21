#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	access,
	mkdir,
	mkdtemp,
	open,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { WASI } from 'node:wasi';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { sha256 } from './source-contract.mjs';

const execFileAsync = promisify(execFile);
const THIS_FILE = fileURLToPath(import.meta.url);
const PRODUCER_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const RECEIPT_FORMAT = 'wasm-llvm-tinygo-package-graph-provider-v2';
const PROVIDER_FILENAME = 'tinygo-package-graph.wasm';
const SOURCE_LOCK_PATH = path.join(PRODUCER_ROOT, 'package-graph.lock.json');
const PROVIDER_IDENTITY = [
	'go/build',
	'go/build/constraint',
	'cmd/go/internal/list',
	'cmd/go/internal/load',
	'cmd/go/internal/modload'
];
const ACCEPTANCE_FIXTURE_SOURCES = [
	'go.mod',
	'greeting.txt',
	'main.go',
	'message/message.go',
	'message/platform_other.go',
	'message/platform_tinygo.go'
];
export const TINYGO_PACKAGE_GRAPH_FIELDS = [
	'Dir',
	'ImportPath',
	'Name',
	'Root',
	'Module',
	'Goroot',
	'Standard',
	'DepOnly',
	'GoFiles',
	'CgoFiles',
	'CFiles',
	'CXXFiles',
	'SFiles',
	'CgoCXXFLAGS',
	'CgoLDFLAGS',
	'EmbedFiles',
	'Imports',
	'ImportMap',
	'Error'
];
export const TINYGO_PACKAGE_GRAPH_TAGS = [
	'tinygo.wasm',
	'tinygo',
	'purego',
	'osusergo',
	'math_big_pure_go',
	'gc.precise',
	'scheduler.asyncify',
	'serial.none',
	'tinygo.unicore',
	...Array.from({ length: 24 }, (_, index) => `go1.${index + 1}`)
];
const REQUIRED_FLAGS = new Map([
	['--go-toolchain-archive', 'goToolchainArchive'],
	['--root-archive', 'rootArchive'],
	['--fixture', 'fixture'],
	['--artifact-dir', 'artifactDir'],
	['--build-dir', 'buildDir'],
	['--receipt', 'receipt']
]);

function packageGraphArguments(moduleMode = 'readonly') {
	return [
		`-json=${TINYGO_PACKAGE_GRAPH_FIELDS.join(',')}`,
		'-deps',
		'-e',
		`-mod=${moduleMode}`,
		`-tags=${TINYGO_PACKAGE_GRAPH_TAGS.join(' ')}`,
		'.'
	];
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function run(command, args, options = {}) {
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
		});
		let stdout = '';
		let stderr = '';
		if (options.capture) {
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stdout.on('data', (chunk) => {
				stdout += chunk;
			});
			child.stderr.on('data', (chunk) => {
				stderr += chunk;
			});
		}
		child.once('error', reject);
		child.once('close', (exitCode, signal) =>
			resolve({ exitCode, signal, stdout, stderr })
		);
	});
}

async function evidence(filePath, publishedPath = filePath) {
	const bytes = await readFile(filePath);
	return {
		path: publishedPath,
		bytes: bytes.byteLength,
		sha256: sha256(bytes)
	};
}

export function parsePackageGraphProviderArgs(argv) {
	const options = { execute: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--execute') {
			options.execute = true;
			continue;
		}
		if (argument === '--help' || argument === '-h') return { help: true };
		const property = REQUIRED_FLAGS.get(argument);
		if (!property) throw new Error(`unknown option: ${argument}`);
		const value = argv[index + 1];
		if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path`);
		if (options[property]) throw new Error(`duplicate option: ${argument}`);
		options[property] = path.resolve(value);
		index += 1;
	}
	for (const [flag, property] of REQUIRED_FLAGS) {
		if (!options[property]) throw new Error(`${flag} is required`);
	}
	return options;
}

export function createPackageGraphProviderPlan(options, contract) {
	const toolchain = contract.goToolchain;
	return {
		schemaVersion: 1,
		format: RECEIPT_FORMAT,
		producerId: 'wasm-llvm/tinygo-browser/package-graph',
		status: options.execute ? 'building' : 'planned',
		upstream: {
			sourceLock: 'package-graph.lock.json',
			module: toolchain.module,
			version: toolchain.version,
			archiveFilename: toolchain.archiveFilename,
			archiveBytes: toolchain.archiveBytes,
			archiveSha256: toolchain.archiveSha256,
			entrypoint: 'cmd/go',
			identityPackages: PROVIDER_IDENTITY,
			identitySources: []
		},
		build: {
			host: 'linux-amd64',
			target: 'wasip1/wasm',
			cgoEnabled: false,
			trimpath: true,
			buildVCS: false,
			buildID: '',
			imports: []
		},
		protocol: {
			command: 'list',
			arguments: packageGraphArguments(),
			argumentsByModuleMode: {
				readonly: packageGraphArguments('readonly'),
				vendor: packageGraphArguments('vendor')
			},
			moduleModes: ['readonly', 'vendor'],
			environment: {
				GOOS: 'wasip1',
				GOARCH: 'wasm',
				CGO_ENABLED: '1',
				GOTOOLCHAIN: 'local',
				GOPROXY: 'off',
				GOSUMDB: 'off',
				GOVCS: 'off',
				GOENV: 'off'
			},
			stdout: 'concatenated-go-list-json',
			maxBytes: 64 * 1024 * 1024,
			maxPackages: 16_384
		},
		acceptance: null,
		assets: []
	};
}

export function parseConcatenatedPackageJSON(source) {
	const values = [];
	let index = 0;
	while (index < source.length) {
		while (/\s/u.test(source[index] ?? '')) index += 1;
		if (index >= source.length) break;
		assert(source[index] === '{', `package JSON value ${values.length} is not an object`);
		const start = index;
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (; index < source.length; index += 1) {
			const character = source[index];
			if (inString) {
				if (escaped) escaped = false;
				else if (character === '\\') escaped = true;
				else if (character === '"') inString = false;
				continue;
			}
			if (character === '"') inString = true;
			else if (character === '{') depth += 1;
			else if (character === '}') {
				depth -= 1;
				if (depth === 0) {
					index += 1;
					values.push(JSON.parse(source.slice(start, index)));
					break;
				}
			}
		}
		assert(depth === 0 && !inString, 'package JSON is truncated');
	}
	return values;
}

export function canonicalizePackageGraph(value, mappings) {
	if (typeof value === 'string') {
		for (const mapping of mappings) {
			if (value === mapping.from) return mapping.to;
			if (value.startsWith(`${mapping.from}/`)) {
				return `${mapping.to}${value.slice(mapping.from.length)}`;
			}
			if (value === `_${mapping.from}`) return `_${mapping.to}`;
			if (value.startsWith(`_${mapping.from}/`)) {
				return `_${mapping.to}${value.slice(mapping.from.length + 1)}`;
			}
		}
		return value;
	}
	if (Array.isArray(value)) return value.map((entry) => canonicalizePackageGraph(entry, mappings));
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				canonicalizePackageGraph(entry, mappings)
			])
		);
	}
	return value;
}

async function runWasiProvider({ provider, root, fixture, work, output, stderr }) {
	const stdoutFile = await open(output, 'wx+');
	const stderrFile = await open(stderr, 'wx+');
	try {
		const wasi = new WASI({
			version: 'preview1',
			returnOnExit: true,
			args: ['go', 'list', ...packageGraphArguments()],
			env: {
				GO111MODULE: 'on',
				GOROOT: '/tinygo-root',
				GOOS: 'wasip1',
				GOARCH: 'wasm',
				CGO_ENABLED: '1',
				GOTOOLCHAIN: 'local',
				GOPROXY: 'off',
				GOSUMDB: 'off',
				GOVCS: 'off',
				GOENV: 'off',
				GOCACHE: '/work/cache',
				HOME: '/work/home',
				TMPDIR: '/work/tmp',
				PWD: '/workspace'
			},
			preopens: {
				'/tinygo-root': root,
				'/workspace': fixture,
				'/work': work
			},
			stdout: stdoutFile.fd,
			stderr: stderrFile.fd
		});
		const module = await WebAssembly.compile(await readFile(provider));
		const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
		const exitCode = wasi.start(instance);
		assert(exitCode === 0, `WASI package-graph provider exited with ${exitCode}`);
	} finally {
		await Promise.all([stdoutFile.close(), stderrFile.close()]);
	}
	const stderrBytes = await readFile(stderr);
	assert(stderrBytes.byteLength === 0, `WASI package-graph provider wrote stderr: ${stderrBytes.toString('utf8')}`);
}

async function main() {
	const options = parsePackageGraphProviderArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(`Usage: node scripts/build-package-graph-provider.mjs \\\n+  --go-toolchain-archive <go.zip> --root-archive <tinygoroot.tar.gz> \\\n+  --fixture <module-dir> --artifact-dir <dir> --build-dir <dir> --receipt <json> [--execute]\n`);
		return;
	}
	const contract = JSON.parse(await readFile(SOURCE_LOCK_PATH, 'utf8'));
	assert(
		contract?.schemaVersion === 1 &&
			contract?.format === 'wasm-llvm-tinygo-package-graph-source-lock-v1' &&
			contract?.entrypoint === 'cmd/go',
		'invalid package-graph source lock'
	);
	const archive = await evidence(options.goToolchainArchive);
	assert(
		archive.bytes === contract.goToolchain.archiveBytes &&
			archive.sha256 === contract.goToolchain.archiveSha256,
		'Go toolchain archive differs from package-graph.lock.json'
	);
	const fixtureGoMod = await readFile(path.join(options.fixture, 'go.mod'), 'utf8');
	assert(/^module example\.com\/tinygo-browser\/graphfixture$/mu.test(fixtureGoMod), 'unexpected package-graph acceptance fixture module');
	const receipt = createPackageGraphProviderPlan(options, contract);
	if (!options.execute) {
		await mkdir(path.dirname(options.receipt), { recursive: true });
		await writeFile(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
		process.stdout.write(`planned: ${options.receipt}\n`);
		return;
	}
	for (const [candidate, label] of [
		[options.artifactDir, 'artifact directory'],
		[options.buildDir, 'build directory'],
		[options.receipt, 'receipt']
	]) {
		await access(candidate).then(
			() => {
				throw new Error(`refusing to replace existing ${label} ${candidate}`);
			},
			(error) => {
				if (error?.code !== 'ENOENT') throw error;
			}
		);
	}
	await Promise.all([
		mkdir(options.buildDir, { recursive: true }),
		mkdir(path.dirname(options.artifactDir), { recursive: true }),
		mkdir(path.dirname(options.receipt), { recursive: true })
	]);
	const temporaryArtifacts = await mkdtemp(
		path.join(path.dirname(options.artifactDir), `.${path.basename(options.artifactDir)}.tmp-`)
	);
	try {
		const toolchainExtract = path.join(options.buildDir, 'go-toolchain');
		const root = path.join(options.buildDir, 'tinygo-root');
		const work = path.join(options.buildDir, 'work');
		await Promise.all([
			mkdir(toolchainExtract, { recursive: true }),
			mkdir(root, { recursive: true }),
			mkdir(path.join(work, 'cache'), { recursive: true }),
			mkdir(path.join(work, 'home'), { recursive: true }),
			mkdir(path.join(work, 'tmp'), { recursive: true })
		]);
		for (const [command, args] of [
			['unzip', ['-q', options.goToolchainArchive, '-d', toolchainExtract]],
			['tar', ['-xzf', options.rootArchive, '-C', root]]
		]) {
			const result = await run(command, args, { capture: true });
			assert(result.exitCode === 0, `${command} failed: ${result.stderr}${result.stdout}`);
		}
		const goRoot = path.join(toolchainExtract, contract.goToolchain.archiveRoot);
		const versionText = await readFile(path.join(goRoot, 'VERSION'), 'utf8');
		assert(versionText.split(/\r?\n/u)[0] === contract.goToolchain.version, 'extracted Go VERSION differs from source lock');
		receipt.upstream.identitySources = await Promise.all(
			contract.identitySources.map(async (lockedSource) => {
				const actual = await evidence(path.join(goRoot, lockedSource.path), lockedSource.path);
				assert(actual.sha256 === lockedSource.sha256, `${lockedSource.path} differs from package-graph source lock`);
				return actual;
			})
		);
		const patch = await evidence(path.join(PRODUCER_ROOT, contract.patch.path), contract.patch.path);
		assert(patch.sha256 === contract.patch.sha256, 'package-graph WASI patch differs from source lock');
		const patchResult = await run('git', ['apply', path.join(PRODUCER_ROOT, contract.patch.path)], {
			cwd: goRoot,
			capture: true
		});
		assert(patchResult.exitCode === 0, `package-graph WASI patch failed: ${patchResult.stderr}${patchResult.stdout}`);
		receipt.upstream.patch = { ...patch, status: 'applied' };

		const providerPath = path.join(temporaryArtifacts, PROVIDER_FILENAME);
		const buildEnvironment = {
			...process.env,
			GO111MODULE: 'off',
			GOROOT: goRoot,
			GOOS: 'wasip1',
			GOARCH: 'wasm',
			CGO_ENABLED: '0',
			GOTOOLCHAIN: 'local',
			GOENV: 'off',
			GOCACHE: path.join(options.buildDir, 'provider-cache'),
			GOPATH: path.join(options.buildDir, 'provider-gopath'),
			HOME: path.join(options.buildDir, 'provider-home')
		};
		await Promise.all([
			mkdir(buildEnvironment.GOCACHE, { recursive: true }),
			mkdir(buildEnvironment.GOPATH, { recursive: true }),
			mkdir(buildEnvironment.HOME, { recursive: true })
		]);
		const buildResult = await run(
			path.join(goRoot, 'bin', 'go'),
			['build', '-trimpath', '-buildvcs=false', '-ldflags=-buildid=', '-o', providerPath, 'cmd/go'],
			{ cwd: goRoot, env: buildEnvironment, capture: true }
		);
		assert(buildResult.exitCode === 0, `Go cmd/go WASI build failed: ${buildResult.stderr}${buildResult.stdout}`);
		const providerBytes = await readFile(providerPath);
		const providerModule = await WebAssembly.compile(providerBytes);
		receipt.build.imports = WebAssembly.Module.imports(providerModule);
		assert(
			receipt.build.imports.every((entry) => entry.module === 'wasi_snapshot_preview1'),
			'package-graph provider imports a non-WASI module'
		);
		const providerText = providerBytes.toString('latin1');
		for (const identity of PROVIDER_IDENTITY) {
			assert(providerText.includes(identity), `package-graph provider is missing upstream identity ${identity}`);
		}

		const wasiOutput = path.join(options.buildDir, 'wasi-package-list.json');
		const wasiStderr = path.join(options.buildDir, 'wasi-stderr.txt');
		await runWasiProvider({
			provider: providerPath,
			root,
			fixture: options.fixture,
			work,
			output: wasiOutput,
			stderr: wasiStderr
		});
		const nativeEnvironment = {
			...process.env,
			GO111MODULE: 'on',
			GOROOT: root,
			GOOS: 'wasip1',
			GOARCH: 'wasm',
			CGO_ENABLED: '1',
			GOTOOLCHAIN: 'local',
			GOPROXY: 'off',
			GOSUMDB: 'off',
			GOVCS: 'off',
			GOENV: 'off',
			GOCACHE: path.join(work, 'native-cache'),
			GOPATH: path.join(work, 'native-gopath'),
			HOME: path.join(work, 'native-home'),
			TMPDIR: path.join(work, 'tmp')
		};
		await Promise.all([
			mkdir(nativeEnvironment.GOCACHE, { recursive: true }),
			mkdir(nativeEnvironment.GOPATH, { recursive: true }),
			mkdir(nativeEnvironment.HOME, { recursive: true })
		]);
		const native = await execFileAsync(
			path.join(goRoot, 'bin', 'go'),
			['list', ...receipt.protocol.arguments],
			{ cwd: options.fixture, env: nativeEnvironment, maxBuffer: receipt.protocol.maxBytes }
		);
		assert(native.stderr === '', `native pinned go list wrote stderr: ${native.stderr}`);
		const wasiBytes = await readFile(wasiOutput);
		assert(wasiBytes.byteLength <= receipt.protocol.maxBytes, 'WASI package graph exceeds protocol byte limit');
		const wasiPackages = parseConcatenatedPackageJSON(wasiBytes.toString('utf8'));
		const nativePackages = parseConcatenatedPackageJSON(native.stdout);
		assert(wasiPackages.length <= receipt.protocol.maxPackages, 'WASI package graph exceeds protocol package limit');
		const canonicalNative = canonicalizePackageGraph(nativePackages, [
			{ from: await realpath(root), to: '/tinygo-root' },
			{ from: await realpath(options.fixture), to: '/workspace' }
		]);
		assert(
			JSON.stringify(wasiPackages) === JSON.stringify(canonicalNative),
			'WASI cmd/go package graph differs from the same pinned native cmd/go graph'
		);
		const fixturePackage = wasiPackages.find(
			(pkg) => pkg.ImportPath === 'example.com/tinygo-browser/graphfixture'
		);
		const localDependency = wasiPackages.find(
			(pkg) => pkg.ImportPath === 'example.com/tinygo-browser/graphfixture/message'
		);
		assert(fixturePackage?.EmbedFiles?.includes('greeting.txt'), 'acceptance graph omitted go:embed file');
		assert(localDependency?.GoFiles?.includes('platform_tinygo.go'), 'acceptance graph omitted tinygo.wasm build-tag file');
		assert(!localDependency?.GoFiles?.includes('platform_other.go'), 'acceptance graph selected the wrong build-tag file');

		receipt.acceptance = {
			status: 'passed',
			fixture: path.relative(PRODUCER_ROOT, options.fixture).replaceAll(path.sep, '/'),
			comparison: 'same-pinned-native-cmd-go-exact-json',
			packageCount: wasiPackages.length,
			packageJSON: await evidence(wasiOutput, 'acceptance/package-list.json'),
			fixtureSources: await Promise.all(
				ACCEPTANCE_FIXTURE_SOURCES.map(async (sourcePath) =>
					await evidence(path.join(options.fixture, sourcePath), sourcePath)
				)
			),
			requiredFeatures: ['local-module-package', 'tinygo.wasm-build-tag', 'go:embed']
		};
		receipt.assets = [await evidence(providerPath, PROVIDER_FILENAME)];
		receipt.status = 'passed';
		await writeFile(
			path.join(temporaryArtifacts, 'package-graph-provider-receipt.json'),
			`${JSON.stringify(receipt, null, 2)}\n`,
			{ flag: 'wx' }
		);
		await rename(temporaryArtifacts, options.artifactDir);
		await writeFile(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
		process.stdout.write(`passed: ${options.receipt}\n`);
	} catch (error) {
		await rm(temporaryArtifacts, { recursive: true, force: true });
		throw error;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.stack ?? error.message : String(error));
		process.exitCode = 1;
	});
}
