import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
	parseRunUpstreamBaselineArgs,
	runSwiftUpstreamBaselineBuild,
	selectSwiftUpstreamBaselineCommand
} from './run-upstream-baseline.mjs';

async function writePlan(filePath, overrides = {}) {
	const checkoutRoot = overrides.checkoutRoot ?? path.join(path.dirname(filePath), 'checkout');
	const buildDir = overrides.buildDir ?? path.join(path.dirname(filePath), 'build');
	await mkdir(path.dirname(filePath), { recursive: true });
	const plan = {
		format: 'wasm-idle-swift-browser-compiler-build-plan-v1',
		checkoutRoot,
		buildDir,
		upstreamWasmBaseline: {
			presets: ['buildbot_linux_crosscompile_wasm', 'wasm_stdlib'],
			commands: [
				[path.join(checkoutRoot, 'swift', 'utils', 'build-script'), '--preset', 'buildbot_linux_crosscompile_wasm'],
				[path.join(checkoutRoot, 'swift', 'utils', 'build-script'), '--preset', 'wasm_stdlib']
			]
		},
		...overrides
	};
	await writeFile(filePath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
	return plan;
}

test('parses Swift upstream baseline runner arguments', () => {
	assert.deepEqual(parseRunUpstreamBaselineArgs(['--help']), { help: true });
	assert.deepEqual(
		parseRunUpstreamBaselineArgs([
			'--plan',
			'plan.json',
			'--preset',
			'wasm_stdlib',
			'--receipt',
			'receipt.json',
			'--dry-run',
			'--preset-substitution',
			'install_destdir=/tmp/install',
			'--preset-file',
			'custom.ini',
			'--allow-unplanned-preset',
			'--no-write-plan',
			'--allow-insufficient-disk',
			'--min-free-gib',
			'12'
		]),
		{
			planPath: path.resolve('plan.json'),
			preset: 'wasm_stdlib',
			receiptPath: path.resolve('receipt.json'),
			dryRun: true,
			writePlan: false,
			allowInsufficientDisk: true,
			minFreeGiB: 12,
			presetSubstitutions: ['install_destdir=/tmp/install'],
			presetFiles: [path.resolve('custom.ini')],
			allowUnplannedPreset: true
		}
	);
	assert.throws(() => parseRunUpstreamBaselineArgs(['--plan']), /--plan requires a value/u);
	assert.throws(() => parseRunUpstreamBaselineArgs(['--min-free-gib', '-1']), /non-negative/u);
	assert.throws(
		() => parseRunUpstreamBaselineArgs(['--preset-substitution', 'bad']),
		/name=value/u
	);
	assert.throws(() => parseRunUpstreamBaselineArgs(['--preset-file']), /--preset-file requires a value/u);
	assert.throws(() => parseRunUpstreamBaselineArgs(['--unknown']), /Unknown option: --unknown/u);
});

test('selects a Swift upstream baseline command from a build plan', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-baseline-select-'));
	try {
		const plan = await writePlan(path.join(dir, 'plan.json'));
		assert.deepEqual(selectSwiftUpstreamBaselineCommand(plan, 'wasm_stdlib'), [
			path.join(plan.checkoutRoot, 'swift', 'utils', 'build-script'),
			'--preset',
			'wasm_stdlib'
		]);
		assert.throws(
			() => selectSwiftUpstreamBaselineCommand(plan, 'missing'),
			/preset was not found/u
		);
		assert.throws(
			() => selectSwiftUpstreamBaselineCommand({ ...plan, buildDir: 'relative' }),
			/buildDir must be an absolute path/u
		);
		assert.throws(
			() =>
				selectSwiftUpstreamBaselineCommand({
					...plan,
					upstreamWasmBaseline: { presets: ['wasm_stdlib'], commands: [['']] }
				}, 'wasm_stdlib'),
			/command is invalid/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('selects an unplanned Swift upstream baseline preset from a preset file when allowed', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-baseline-unplanned-'));
	try {
		const plan = await writePlan(path.join(dir, 'plan.json'));
		const presetFile = path.join(dir, 'custom.ini');
		assert.deepEqual(
			selectSwiftUpstreamBaselineCommand(plan, 'buildbot_linux_crosscompile_wasm_no_lldb', {
				presetFiles: [presetFile],
				allowUnplannedPreset: true
			}),
			[
				path.join(plan.checkoutRoot, 'swift', 'utils', 'build-script'),
				'--preset-file',
				presetFile,
				'--preset',
				'buildbot_linux_crosscompile_wasm_no_lldb'
			]
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('runs a Swift upstream baseline command and writes a receipt', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-baseline-run-'));
	try {
		const planPath = path.join(dir, 'plan.json');
		const plan = await writePlan(planPath);
		const calls = [];
		const result = await runSwiftUpstreamBaselineBuild({
			planPath,
			preset: 'wasm_stdlib',
			presetFiles: [path.join(dir, 'custom.ini')],
			inspectDiskSpace: async (targetDir, { minFreeGiB }) => ({
				probePath: dir,
				freeBytes: 100 * 1024 * 1024 * 1024,
				requiredFreeBytes: minFreeGiB * 1024 * 1024 * 1024,
				minFreeGiB,
				ok: targetDir === plan.buildDir
			}),
			run: async (command, args, options) => {
				calls.push({ command, args, options });
				return { exitCode: 0 };
			}
		});

		assert.deepEqual(calls, [
			{
				command: path.join(plan.checkoutRoot, 'swift', 'utils', 'build-script'),
				args: [
					'--preset-file',
					path.join(dir, 'custom.ini'),
					'--preset',
					'wasm_stdlib',
					`install_destdir=${path.join(plan.buildDir, 'upstream-baseline-wasm_stdlib', 'install')}`,
					`installable_package=${path.join(
						plan.buildDir,
						'upstream-baseline-wasm_stdlib',
						'wasm_stdlib.tar.gz'
					)}`
				],
				options: { cwd: plan.checkoutRoot }
			}
		]);
		assert.equal(
			result.receiptPath,
			path.join(plan.buildDir, 'wasm-idle-swift-upstream-baseline-wasm_stdlib.json')
		);
		assert.equal(result.receipt.status, 'passed');
		assert.equal(result.receipt.exitCode, 0);
		assert.equal(result.receipt.terminationSignal, null);
		assert.equal(result.receipt.errorMessage, null);
		assert.deepEqual(result.receipt.command, [
			path.join(plan.checkoutRoot, 'swift', 'utils', 'build-script'),
			'--preset-file',
			path.join(dir, 'custom.ini'),
			'--preset',
			'wasm_stdlib',
			`install_destdir=${path.join(plan.buildDir, 'upstream-baseline-wasm_stdlib', 'install')}`,
			`installable_package=${path.join(
				plan.buildDir,
				'upstream-baseline-wasm_stdlib',
				'wasm_stdlib.tar.gz'
			)}`
		]);
		assert.match(result.receipt.note, /not evidence that browser swiftc\.wasm/u);
		assert.deepEqual(JSON.parse(await readFile(result.receiptPath, 'utf8')), result.receipt);
		assert.match(result.receiptDigest, /^[a-f0-9]{64}$/u);
		assert.equal(result.planUpdated, true);
		assert.deepEqual(JSON.parse(await readFile(planPath, 'utf8')).upstreamWasmBaseline.receipts, [
			{
				preset: 'wasm_stdlib',
				path: result.receiptPath,
				sha256: result.receiptDigest,
				status: 'passed'
			}
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('writes a failed Swift upstream baseline receipt before rejecting', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-baseline-fail-'));
	try {
		const planPath = path.join(dir, 'plan.json');
		await writePlan(planPath);
		await assert.rejects(
			() =>
				runSwiftUpstreamBaselineBuild({
					planPath,
					preset: 'wasm_stdlib',
					inspectDiskSpace: async () => ({
						probePath: dir,
						freeBytes: 100 * 1024 * 1024 * 1024,
						requiredFreeBytes: 80 * 1024 * 1024 * 1024,
						minFreeGiB: 80,
						ok: true
					}),
					run: async () => {
						const error = new Error('boom');
						error.exitCode = 137;
						error.signal = 'SIGKILL';
						throw error;
					}
				}),
			/failed/u
		);
		const receiptPath = path.join(planPath, '..', 'build', 'wasm-idle-swift-upstream-baseline-wasm_stdlib.json');
		const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
		const updatedPlan = JSON.parse(await readFile(planPath, 'utf8'));
		assert.equal(receipt.status, 'failed');
		assert.equal(receipt.exitCode, 137);
		assert.equal(receipt.terminationSignal, 'SIGKILL');
		assert.equal(receipt.errorMessage, 'boom');
		assert.match(updatedPlan.upstreamWasmBaseline.receipts[0].sha256, /^[a-f0-9]{64}$/u);
		assert.deepEqual(updatedPlan.upstreamWasmBaseline.receipts, [
			{
				preset: 'wasm_stdlib',
				path: receiptPath,
				sha256: updatedPlan.upstreamWasmBaseline.receipts[0].sha256,
				status: 'failed'
			}
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('rejects Swift upstream baseline execution when the workspace is too small', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-baseline-disk-'));
	try {
		const planPath = path.join(dir, 'plan.json');
		await writePlan(planPath);
		await assert.rejects(
			() =>
				runSwiftUpstreamBaselineBuild({
					planPath,
					inspectDiskSpace: async () => ({
						probePath: dir,
						freeBytes: 7 * 1024 * 1024 * 1024,
						requiredFreeBytes: 80 * 1024 * 1024 * 1024,
						minFreeGiB: 80,
						ok: false
					}),
					run: async () => {
						throw new Error('should not run');
					}
				}),
			/requires at least 80 GiB free/u
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('supports Swift upstream baseline dry-run receipts without executing commands', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'wasm-idle-swift-baseline-dry-run-'));
	try {
		const planPath = path.join(dir, 'plan.json');
		await writePlan(planPath);
		const result = await runSwiftUpstreamBaselineBuild({
			planPath,
			dryRun: true,
			writePlan: false,
			run: async () => {
				throw new Error('should not run');
			}
		});

		assert.equal(result.receipt.status, 'dry-run');
		assert.equal(result.receipt.exitCode, null);
		assert.equal(result.receipt.terminationSignal, null);
		assert.equal(result.receipt.errorMessage, null);
		assert.equal(result.planUpdated, false);
		assert.equal(JSON.parse(await readFile(planPath, 'utf8')).upstreamWasmBaseline.receipts, undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
