import assert from 'node:assert/strict';
import test from 'node:test';

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
