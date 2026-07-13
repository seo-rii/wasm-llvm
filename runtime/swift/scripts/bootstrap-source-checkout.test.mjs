import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
	bootstrapSwiftSourceCheckout,
	createSwiftSourceBootstrapPlan,
	inspectBootstrapDiskSpace,
	parseBootstrapSourceCheckoutArgs
} from './bootstrap-source-checkout.mjs';

test('parses Swift source bootstrap arguments', () => {
	assert.deepEqual(parseBootstrapSourceCheckoutArgs(['--help']), { help: true });
	assert.deepEqual(parseBootstrapSourceCheckoutArgs([]), {
		sourceRoot: path.resolve(import.meta.dirname, '..', 'source-checkout'),
		planPath: null,
		swiftRepository: 'https://github.com/swiftlang/swift.git',
		swiftRef: 'main',
		swiftLocalBranch: null,
		swiftCloneDepth: null,
		swiftCloneFilter: null,
		dependencyScheme: 'main',
		receiptPath: null,
		requiredTools: ['git', 'python3'],
		allowExisting: false,
		allowMissingTools: false,
		allowInsufficientDisk: false,
		minFreeGiB: 80,
		execute: false
	});
	assert.deepEqual(
		parseBootstrapSourceCheckoutArgs([
			'--source-root',
			'sources',
			'--plan-path',
			'plan.json',
			'--swift-repository',
			'https://github.com/swiftlang/swift.git',
			'--swift-ref',
			'swift-wasm-6.3-RELEASE',
			'--swift-local-branch',
			'release/6.3',
			'--swift-clone-depth',
			'1',
			'--swift-clone-filter',
			'blob:none',
			'--dependency-scheme',
			'release/6.3',
			'--receipt',
			'receipt.json',
			'--require-tool',
			'cmake',
			'--allow-existing',
			'--allow-missing-tools',
			'--allow-insufficient-disk',
			'--min-free-gib',
			'24',
			'--execute'
		]),
		{
			sourceRoot: path.resolve('sources'),
			planPath: path.resolve('plan.json'),
			swiftRepository: 'https://github.com/swiftlang/swift.git',
			swiftRef: 'swift-wasm-6.3-RELEASE',
			swiftLocalBranch: 'release/6.3',
			swiftCloneDepth: 1,
			swiftCloneFilter: 'blob:none',
			dependencyScheme: 'release/6.3',
			receiptPath: path.resolve('receipt.json'),
			requiredTools: ['git', 'python3', 'cmake'],
			allowExisting: true,
			allowMissingTools: true,
			allowInsufficientDisk: true,
			minFreeGiB: 24,
			execute: true
		}
	);
	assert.throws(() => parseBootstrapSourceCheckoutArgs(['--source-root']), /--source-root requires a value/u);
	assert.throws(
		() => parseBootstrapSourceCheckoutArgs(['--swift-clone-depth', '0']),
		/positive integer/u
	);
	assert.throws(
		() => parseBootstrapSourceCheckoutArgs(['--swift-local-branch']),
		/--swift-local-branch requires a value/u
	);
	assert.throws(() => parseBootstrapSourceCheckoutArgs(['--receipt']), /--receipt requires a value/u);
	assert.throws(() => parseBootstrapSourceCheckoutArgs(['--min-free-gib', '-1']), /non-negative/u);
	assert.throws(() => parseBootstrapSourceCheckoutArgs(['--unknown']), /Unknown option: --unknown/u);
});

test('checks free disk space before executing the large Swift checkout', async () => {
	const result = await inspectBootstrapDiskSpace(path.join(tmpdir(), 'wasm-idle-swift-disk-check'), {
		minFreeGiB: 0
	});
	assert.equal(result.ok, true);
	assert.equal(result.minFreeGiB, 0);
	assert.equal(result.requiredFreeBytes, 0);
	assert.equal(typeof result.freeBytes, 'number');

	await assert.rejects(
		() => inspectBootstrapDiskSpace(tmpdir(), { minFreeGiB: -1 }),
		/non-negative/u
	);
});

test('writes a Swift source bootstrap plan without executing clone commands', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-source-plan-'));
	try {
		const sourceRoot = path.join(dir, 'sources');
		const planPath = path.join(dir, 'bootstrap-plan.json');
		const calls = [];
		const result = await createSwiftSourceBootstrapPlan({
			sourceRoot,
			planPath,
			swiftRef: 'main',
			swiftCloneDepth: 1,
			swiftCloneFilter: 'blob:none',
			requiredTools: ['git', 'python3'],
			run: async (command, args) => {
				calls.push([command, args]);
				return { stdout: `${command} version\n`, stderr: '' };
			}
		});

		assert.equal(result.planPath, planPath);
		assert.deepEqual(calls, [
			['git', ['--version']],
			['python3', ['--version']]
		]);
		assert.deepEqual(result.plan.commands.cloneSwift, [
			'git',
			'clone',
			'--branch',
			'main',
			'--depth',
			'1',
			'--filter',
			'blob:none',
			'https://github.com/swiftlang/swift.git',
			path.join(sourceRoot, 'swift')
		]);
		assert.deepEqual(result.plan.commands.updateCheckout, [
			path.join(sourceRoot, 'swift', 'utils', 'update-checkout'),
			'--clone',
			'--scheme',
			'main'
		]);
		assert.ok(
			result.plan.nextCommands.some((command) =>
				command.includes('build:wasm-swift-browser-compiler') &&
				command.includes('--browser-build-command') &&
				command.includes('runner-worker.js swiftc.wasm swiftpm.wasm')
			)
		);
		assert.equal(result.plan.swiftCloneDepth, 1);
		assert.equal(result.plan.swiftCloneFilter, 'blob:none');
		assert.deepEqual(JSON.parse(await readFile(planPath, 'utf8')), result.plan);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects unsafe source bootstrap inputs before writing a plan', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-source-invalid-'));
	try {
		await assert.rejects(
			() =>
				createSwiftSourceBootstrapPlan({
					sourceRoot: dir,
					swiftRepository: 'git@github.com:swiftlang/swift.git',
					run: async () => ({ stdout: '', stderr: '' })
				}),
			/swiftRepository must be an HTTPS GitHub clone URL/u
		);
		await assert.rejects(
			() =>
				createSwiftSourceBootstrapPlan({
					sourceRoot: dir,
					swiftRef: '',
					run: async () => ({ stdout: '', stderr: '' })
				}),
			/swiftRef is required/u
		);
		await assert.rejects(
			() =>
				createSwiftSourceBootstrapPlan({
					sourceRoot: dir,
					swiftCloneDepth: 0,
					run: async () => ({ stdout: '', stderr: '' })
				}),
			/swiftCloneDepth must be a positive integer/u
		);
		await assert.rejects(
			() =>
				createSwiftSourceBootstrapPlan({
					sourceRoot: dir,
					swiftCloneFilter: '../bad',
					run: async () => ({ stdout: '', stderr: '' })
				}),
			/swiftCloneFilter must be a non-empty git clone filter expression/u
		);
		await assert.rejects(
			() =>
				createSwiftSourceBootstrapPlan({
					sourceRoot: dir,
					swiftLocalBranch: '../release/6.3',
					run: async () => ({ stdout: '', stderr: '' })
				}),
			/swiftLocalBranch must be a safe git branch name/u
		);
		await assert.rejects(
			() =>
				createSwiftSourceBootstrapPlan({
					sourceRoot: dir,
					requiredTools: ['git', 'missing-tool'],
					run: async (command) => {
						if (command === 'missing-tool') throw new Error('not found');
						return { stdout: `${command} version\n`, stderr: '' };
					}
				}),
			/bootstrap tools are missing: missing-tool/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('guards existing Swift checkouts unless reuse is explicit', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-source-existing-'));
	try {
		await mkdir(path.join(dir, 'swift'), { recursive: true });
		await assert.rejects(
			() =>
				createSwiftSourceBootstrapPlan({
					sourceRoot: dir,
					run: async () => ({ stdout: 'tool version\n', stderr: '' })
				}),
			/already exists/u
		);
		const result = await createSwiftSourceBootstrapPlan({
			sourceRoot: dir,
			allowExisting: true,
			run: async () => ({ stdout: 'tool version\n', stderr: '' })
		});
		assert.equal(result.plan.sourceRoot, dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('executes planned clone and dependency checkout only when requested', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-source-execute-'));
	try {
		const sourceRoot = path.join(dir, 'sources');
		const receiptPath = path.join(dir, 'bootstrap-receipt.json');
		const executed = [];
		const result = await bootstrapSwiftSourceCheckout({
			sourceRoot,
			swiftCloneDepth: 1,
			swiftCloneFilter: 'blob:none',
			swiftLocalBranch: 'release/6.3',
			receiptPath,
			execute: true,
			minFreeGiB: 80,
			inspectDiskSpace: async (requestedSourceRoot, { minFreeGiB }) => ({
				probePath: dir,
				freeBytes: 100 * 1024 * 1024 * 1024,
				requiredFreeBytes: minFreeGiB * 1024 * 1024 * 1024,
				minFreeGiB,
				ok: requestedSourceRoot === sourceRoot
			}),
			run: async (command, args) => {
				executed.push([command, args]);
				if (command === 'git' && args[0] === 'clone') {
					await mkdir(path.join(sourceRoot, 'swift', 'utils'), { recursive: true });
					await writeFile(path.join(sourceRoot, 'swift', 'utils', 'update-checkout'), '');
					await writeFile(path.join(sourceRoot, 'swift', 'utils', 'build-script'), '');
					await writeFile(path.join(sourceRoot, 'swift', 'CMakeLists.txt'), '');
					await mkdir(path.join(sourceRoot, 'llvm-project', 'llvm'), { recursive: true });
					await writeFile(path.join(sourceRoot, 'llvm-project', 'llvm', 'CMakeLists.txt'), '');
					await mkdir(path.join(sourceRoot, 'swiftpm'), { recursive: true });
					await writeFile(path.join(sourceRoot, 'swiftpm', 'Package.swift'), '');
				}
				return { stdout: `${command} version\n`, stderr: '' };
			}
		});

		assert.deepEqual(executed, [
			['git', ['--version']],
			['python3', ['--version']],
			[
				'git',
				[
					'clone',
					'--branch',
					'main',
					'--depth',
					'1',
					'--filter',
					'blob:none',
					'https://github.com/swiftlang/swift.git',
					path.join(sourceRoot, 'swift')
				]
			],
			['git', ['checkout', '-B', 'release/6.3', 'HEAD']],
			[path.join(sourceRoot, 'swift', 'utils', 'update-checkout'), ['--clone', '--scheme', 'main']]
		]);
		assert.equal(result.receiptPath, receiptPath);
		assert.equal(result.receipt.format, 'wasm-idle-swift-source-bootstrap-receipt-v1');
		assert.equal(result.receipt.status, 'passed');
		assert.match(result.receipt.startedAt, /^\d{4}-\d{2}-\d{2}T/u);
		assert.match(result.receipt.finishedAt, /^\d{4}-\d{2}-\d{2}T/u);
		assert.equal(result.receipt.sourceRoot, sourceRoot);
		assert.equal(result.receipt.swiftCloneDepth, 1);
		assert.equal(result.receipt.swiftCloneFilter, 'blob:none');
		assert.equal(result.receipt.swiftLocalBranch, 'release/6.3');
		assert.equal(result.receipt.disk.ok, true);
		assert.equal(result.receipt.checkout.ok, true);
		assert.deepEqual(result.receipt.checkout.missing, []);
		assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')), result.receipt);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects source checkout execution when expected checkout files are missing', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-source-incomplete-'));
	try {
		const sourceRoot = path.join(dir, 'sources');
		const receiptPath = path.join(dir, 'incomplete-bootstrap-receipt.json');
		await assert.rejects(
			() =>
				bootstrapSwiftSourceCheckout({
					sourceRoot,
					receiptPath,
					execute: true,
					minFreeGiB: 0,
					inspectDiskSpace: async () => ({
						probePath: dir,
						freeBytes: 100 * 1024 * 1024 * 1024,
						requiredFreeBytes: 0,
						minFreeGiB: 0,
						ok: true
					}),
					run: async (command, args) => {
						if (command === 'git' && args[0] === 'clone') {
							await mkdir(path.join(sourceRoot, 'swift', 'utils'), { recursive: true });
							await writeFile(path.join(sourceRoot, 'swift', 'utils', 'update-checkout'), '');
						}
						return { stdout: `${command} version\n`, stderr: '' };
					}
				}),
			/Swift source checkout is incomplete after bootstrap/u
		);
		const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
		assert.equal(receipt.status, 'failed');
		assert.equal(receipt.checkout.ok, false);
		assert.ok(receipt.checkout.missing.includes(path.join('swift', 'utils', 'build-script')));
		assert.ok(receipt.checkout.missing.includes(path.join('llvm-project', 'llvm', 'CMakeLists.txt')));
		assert.match(receipt.error, /source checkout is incomplete/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects source checkout execution when the workspace is too small', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-source-disk-'));
	try {
		const sourceRoot = path.join(dir, 'sources');
		const receiptPath = path.join(dir, 'failed-bootstrap-receipt.json');
		await assert.rejects(
			() =>
				bootstrapSwiftSourceCheckout({
					sourceRoot,
					receiptPath,
					execute: true,
					inspectDiskSpace: async () => ({
						probePath: dir,
						freeBytes: 7 * 1024 * 1024 * 1024,
						requiredFreeBytes: 80 * 1024 * 1024 * 1024,
						minFreeGiB: 80,
						ok: false
					}),
					run: async () => ({ stdout: 'tool version\n', stderr: '' })
				}),
			/requires at least 80 GiB free/u
		);
		const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
		assert.equal(receipt.format, 'wasm-idle-swift-source-bootstrap-receipt-v1');
		assert.equal(receipt.status, 'failed');
		assert.equal(receipt.sourceRoot, sourceRoot);
		assert.equal(receipt.disk.ok, false);
		assert.match(receipt.error, /requires at least 80 GiB free/u);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
