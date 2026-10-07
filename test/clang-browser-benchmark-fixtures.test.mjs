import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { EXPECTED_OUTPUT, SOURCES } from '../producer/clang-browser/scripts/benchmark-compiler.mjs';
import { prepareBrowserBenchmark } from '../producer/clang-browser/scripts/prepare-browser-benchmark.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'clang-browser-benchmark-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const directory of ['assets', 'raw', 'clangd']) await mkdir(path.join(root, directory));
	const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
	const gz = gzipSync(wasm, { level: 6 });
	for (const name of ['clang', 'lld']) {
		await writeFile(path.join(root, 'raw', name), wasm);
		await writeFile(path.join(root, 'assets', `${name}.wasm.gz`), gz);
	}
	await writeFile(path.join(root, 'assets', 'memfs.wasm.gz'), gz);
	await writeFile(
		path.join(root, 'assets', 'sysroot.tar.gz'),
		gzipSync(Buffer.from('sysroot fixture'))
	);
	await writeFile(path.join(root, 'raw', 'compiler-build.json'), '{"optimization":"Oz"}');
	await writeFile(path.join(root, 'clangd', 'clangd.js'), 'export default function clangd() {}');
	await writeFile(path.join(root, 'clangd', 'clangd.wasm'), wasm);
	const tree = {
		schemaVersion: 1,
		version: 'test',
		targetTriple: 'wasm32-wasi',
		resourceDir: '/lib/clang/22',
		files: {
			'/usr/include/wasm32-wasi/stdio.h': 'C fixture',
			'/usr/include/c++/v1/vector': 'C++ fixture',
			'/lib/clang/22/include/stddef.h': 'resource fixture'
		}
	};
	await writeFile(
		path.join(root, 'clangd', 'clangd.headers.json.gz'),
		gzipSync(Buffer.from(JSON.stringify(tree)))
	);
	await writeFile(
		path.join(root, 'runtime-manifest.json'),
		'{"manifestVersion":1,"version":"fixture"}'
	);
	const config = {
		runtimeManifest: 'runtime-manifest.json',
		compilerAssets: 'assets',
		compiler: {
			baseline: { compressedDirectory: 'assets' },
			'raw-oz': { rawDirectory: 'raw' }
		},
		clangd: {
			separated: {
				directory: 'clangd',
				implementation: 'current',
				rawWasm: 'clangd.wasm',
				headers: 'clangd.headers.json.gz'
			}
		}
	};
	return { root, config, wasm, gz, tree };
}

test('retains shipped compressed bytes and derives candidate receipts and identical workloads', async (t) => {
	const { root, config, wasm, gz } = await fixture(t);
	const out = path.join(root, 'out');
	const report = await prepareBrowserBenchmark(config, out, root);
	assert.deepEqual(await readFile(report.files['baseline/clang/bin/clang.wasm.gz']), gz);
	const receipt = report.compiler['raw-oz'].receipts['bin/clang.wasm.gz'];
	assert.equal(receipt.uncompressedSha256, sha256(wasm));
	assert.equal(receipt.uncompressedBytes, wasm.length);
	assert.equal(receipt.sha256, sha256(gzipSync(wasm, { level: 9 })));
	assert.deepEqual(report.compiler.baseline.workloads, report.compiler['raw-oz'].workloads);
	for (const workload of report.compiler.baseline.workloads) {
		assert.equal(workload.source, SOURCES[workload.name]);
		assert.equal(workload.expected, EXPECTED_OUTPUT[workload.name]);
	}
	assert.equal(report.compiler['raw-oz'].provenance[0].receipt.optimization, 'Oz');
	assert.equal(report.clangd.separated.headers, 'clangd.headers.json.gz');
	assert.equal(
		report.clangd.separated.integrity['clangd.wasm.gz'].uncompressedSha256,
		sha256(wasm)
	);
	assert.deepEqual(JSON.parse(await readFile(path.join(out, 'fixtures.json'), 'utf8')), report);
});

test('rejects escaping fixture names, conflicting raw/compressed inputs and incomplete header trees', async (t) => {
	const { root, config, tree } = await fixture(t);
	const out = path.join(root, 'out');
	await assert.rejects(
		prepareBrowserBenchmark(
			{ ...config, compiler: { '../escape': { rawDirectory: 'raw' } } },
			out,
			root
		),
		/Invalid fixture name/
	);
	await assert.rejects(
		prepareBrowserBenchmark(
			{
				...config,
				compiler: {
					conflict: { rawDirectory: 'raw', compressedDirectory: 'assets' }
				}
			},
			out,
			root
		),
		/exactly one/
	);
	delete tree.files['/usr/include/c++/v1/vector'];
	await writeFile(
		path.join(root, 'clangd', 'clangd.headers.json.gz'),
		gzipSync(Buffer.from(JSON.stringify(tree)))
	);
	await assert.rejects(
		prepareBrowserBenchmark(config, out, root),
		/Required clangd asset header is missing/
	);
});

test('includes manifest-selected supplemental sysroot bytes and receipts for every compiler variant', async (t) => {
	const { root, config } = await fixture(t);
	const asset = 'libc-printscan-long-double.a.gz';
	const bytes = gzipSync(Buffer.from('supplemental archive fixture'), { level: 6 });
	await writeFile(path.join(root, asset), bytes);
	await writeFile(
		path.join(root, 'runtime-manifest.json'),
		JSON.stringify({ compiler: { sysroot: { printscanLongDouble: { asset } } } })
	);
	const report = await prepareBrowserBenchmark(config, path.join(root, 'out'), root);
	for (const name of Object.keys(config.compiler)) {
		assert.deepEqual(await readFile(report.files[`${name}/clang/${asset}`]), bytes);
		assert.equal(
			report.compiler[name].manifest.compiler.sysroot.printscanLongDouble.asset,
			asset
		);
		assert.equal(report.compiler[name].receipts[asset].sha256, sha256(bytes));
		assert.equal(
			report.compiler[name].receipts[asset].uncompressedSha256,
			sha256(Buffer.from('supplemental archive fixture'))
		);
	}
	await writeFile(
		path.join(root, 'runtime-manifest.json'),
		JSON.stringify({
			compiler: { sysroot: { printscanLongDouble: { asset: '../escape.gz' } } }
		})
	);
	await assert.rejects(
		prepareBrowserBenchmark(config, path.join(root, 'out'), root),
		/Invalid supplemental sysroot asset path/
	);
});
