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
		version: 'go1.24.6',
		archiveFilename: 'v0.0.1-go1.24.6.linux-amd64.zip',
		archiveBytes: 82_904_480,
		archiveSha256: 'e7f0fd16d1b06c716162a0938744bb7ebf7edbc3248d42432271a1b5c1fde1ce'
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
	assert.equal(TINYGO_PACKAGE_GRAPH_TAGS.at(-1), 'go1.24');
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
