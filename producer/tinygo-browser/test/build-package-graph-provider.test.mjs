import assert from 'node:assert/strict';
import test from 'node:test';

import {
	TINYGO_PACKAGE_GRAPH_FIELDS,
	TINYGO_PACKAGE_GRAPH_TAGS,
	canonicalizePackageGraph,
	createPackageGraphProviderPlan,
	parseConcatenatedPackageJSON,
	parsePackageGraphProviderArgs
} from '../scripts/build-package-graph-provider.mjs';

const contract = {
	goToolchain: {
		module: 'golang.org/toolchain',
		version: 'go1.26.10',
		archiveFilename: 'v0.0.1-go1.26.10.linux-amd64.zip',
		archiveBytes: 82_904_480,
		archiveSha256: 'f64ecb0807852be2c98899561c45288a9ad57f4e88f3cd002ffabeccbd03bfe1'
	}
};

test('pins list-only cmd/go fields and the complete TinyGo wasip1 tag profile', () => {
	const options = parsePackageGraphProviderArgs([
		'--go-toolchain-archive',
		'/tmp/go.zip',
		'--root-archive',
		'/tmp/root.tar.gz',
		'--fixture',
		'/tmp/fixture',
		'--artifact-dir',
		'/tmp/artifacts',
		'--build-dir',
		'/tmp/build',
		'--receipt',
		'/tmp/receipt.json',
		'--execute'
	]);
	const plan = createPackageGraphProviderPlan(options, contract);
	assert.equal(plan.format, 'wasm-llvm-tinygo-package-graph-provider-v2');
	assert.equal(plan.status, 'building');
	assert.equal(plan.upstream.entrypoint, 'cmd/go');
	assert.deepEqual(plan.protocol.arguments, [
		`-json=${TINYGO_PACKAGE_GRAPH_FIELDS.join(',')}`,
		'-deps',
		'-e',
		'-mod=readonly',
		`-tags=${TINYGO_PACKAGE_GRAPH_TAGS.join(' ')}`,
		'.'
	]);
	assert.deepEqual(plan.protocol.argumentsByModuleMode.vendor, [
		`-json=${TINYGO_PACKAGE_GRAPH_FIELDS.join(',')}`,
		'-deps',
		'-e',
		'-mod=vendor',
		`-tags=${TINYGO_PACKAGE_GRAPH_TAGS.join(' ')}`,
		'.'
	]);
	assert.deepEqual(plan.protocol.moduleModes, ['readonly', 'vendor']);
	assert.equal(TINYGO_PACKAGE_GRAPH_TAGS.at(-1), 'go1.26');
	assert.ok(
		TINYGO_PACKAGE_GRAPH_TAGS.includes('tinygo.unwind.asyncify'),
		'TinyGo 0.43 requires its unwind tag to select all three runtime panic source files'
	);
	assert.ok(plan.upstream.identityPackages.includes('cmd/go/internal/list'));
	assert.equal(plan.protocol.environment.GOPROXY, 'off');
	assert.equal(plan.protocol.environment.GOTOOLCHAIN, 'local');
});

test('parses concatenated go list JSON and normalizes only declared preopen paths', () => {
	const source = `${JSON.stringify({
		Dir: '/host/root/src/fmt',
		ImportPath: 'fmt',
		Root: '/host/root'
	})}\n${JSON.stringify({
		Dir: '/host/workspace',
		ImportPath: 'example.com/app',
		Module: { Dir: '/host/workspace', GoMod: '/host/workspace/go.mod' }
	})}\n`;
	const packages = parseConcatenatedPackageJSON(source);
	assert.equal(packages.length, 2);
	assert.deepEqual(
		canonicalizePackageGraph(packages, [
			{ from: '/host/root', to: '/tinygo-root' },
			{ from: '/host/workspace', to: '/workspace' }
		]),
		[
			{ Dir: '/tinygo-root/src/fmt', ImportPath: 'fmt', Root: '/tinygo-root' },
			{
				Dir: '/workspace',
				ImportPath: 'example.com/app',
				Module: { Dir: '/workspace', GoMod: '/workspace/go.mod' }
			}
		]
	);
	assert.throws(() => parseConcatenatedPackageJSON('{"Dir":"/broken"'), /truncated/u);
});

test('rejects unknown, duplicate, and missing build options', () => {
	assert.throws(() => parsePackageGraphProviderArgs(['--unknown', '/tmp/x']), /unknown option/u);
	assert.throws(
		() =>
			parsePackageGraphProviderArgs([
				'--go-toolchain-archive',
				'/tmp/a',
				'--go-toolchain-archive',
				'/tmp/b'
			]),
		/duplicate option/u
	);
	assert.throws(() => parsePackageGraphProviderArgs([]), /--go-toolchain-archive is required/u);
});
