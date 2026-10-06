import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	median,
	parseArgs,
	sizeReport
} from '../producer/clang-browser/scripts/benchmark-compiler.mjs';

const sizes = (clangRaw, clangGzip, lldRaw, lldGzip) => ({
	clang: { raw: clangRaw, gzip: clangGzip },
	lld: { raw: lldRaw, gzip: lldGzip }
});

test('applies the size budget to raw and gzip bytes of every module', () => {
	const baseline = sizes(1000, 400, 500, 200);
	assert.equal(sizeReport(baseline, sizes(1100, 440, 500, 200), 10).withinBudget, true);
	assert.equal(sizeReport(baseline, sizes(1101, 400, 500, 200), 10).withinBudget, false);
	assert.equal(sizeReport(baseline, sizes(1000, 441, 500, 200), 10).withinBudget, false);
	assert.equal(sizeReport(baseline, sizes(1000, 400, 551, 200), 10).withinBudget, false);
	assert.deepEqual(sizeReport(baseline, sizes(1050, 380, 500, 200), 10).modules.clang, {
		raw: { bytes: 1050, growthPercent: 5 },
		gzip: { bytes: 380, growthPercent: -5 }
	});
});

test('parses candidates and rejects incomplete benchmark arguments', () => {
	const options = parseArgs([
		'--sysroot',
		'sysroot.tar.zip',
		'--baseline',
		'base',
		'--candidate',
		'os=out/os/compiler',
		'--candidate',
		'hot=a=b',
		'--runs',
		'3',
		'--enforce'
	]);
	assert.deepEqual(options.candidates, [
		{ name: 'os', dir: 'out/os/compiler' },
		{ name: 'hot', dir: 'a=b' }
	]);
	assert.equal(options.runs, 3);
	assert.equal(options.enforce, true);
	assert.equal(options.maxGrowth, 10);
	assert.throws(
		() => parseArgs(['--sysroot', 's', '--baseline', 'b']),
		/at least one --candidate/
	);
	assert.throws(() => parseArgs(['--candidate', 'missing-dir']), /<name>=<dir>/);
	assert.throws(
		() => parseArgs(['--sysroot', 's', '--baseline', 'b', '--candidate', 'x=y', '--runs', '1']),
		/at least 2/
	);
});

test('reports the middle value for odd and even run counts', () => {
	assert.equal(median([5, 1, 3]), 3);
	assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('rejects duplicate report labels and candidates without a directory', () => {
	const args = ['--sysroot', 's', '--baseline', 'b'];
	assert.throws(() => parseArgs([...args, '--candidate', 'x=']), /directory/);
	assert.throws(() => parseArgs([...args, '--candidate', 'baseline=x']), /duplicate.*baseline/i);
	assert.throws(
		() => parseArgs([...args, '--candidate', 'x=a', '--candidate', 'x=b']),
		/duplicate.*x/i
	);
});

test('keeps candidate workspaces inside scratch even when a report label is ..', async () => {
	const temporary = await mkdtemp(path.join(os.tmpdir(), 'clang-benchmark-workspace-test-'));
	try {
		const input = path.join(temporary, 'input');
		await mkdir(input);
		// These compile successfully but lack WASI exports, stopping the benchmark after workspace
		// setup. The scratch directory must be cleaned without leaving fixtures in its parent.
		const emptyModule = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
		await writeFile(path.join(input, 'clang'), emptyModule);
		await writeFile(path.join(input, 'lld'), emptyModule);
		const script = fileURLToPath(
			new URL('../producer/clang-browser/scripts/benchmark-compiler.mjs', import.meta.url)
		);
		const result = spawnSync(
			process.execPath,
			[script, '--sysroot', input, '--baseline', input, '--candidate', `..=${input}`, '--runs', '2'],
			{ env: { ...process.env, TMPDIR: temporary }, encoding: 'utf8' }
		);
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /instance\.exports\.memory/);
		assert.deepEqual(await readdir(temporary), ['input']);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
