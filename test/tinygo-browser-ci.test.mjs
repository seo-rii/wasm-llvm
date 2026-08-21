import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const workflowPath = '.github/workflows/tinygo-browser-producer.yml';

test('manual TinyGo producer rebuilds and accepts the source-locked upstream toolchain', async () => {
	const workflow = await readFile(workflowPath, 'utf8');

	assert.match(workflow, /workflow_dispatch:/u);
	assert.match(workflow, /timeout-minutes: 720/u);
	assert.match(workflow, /670759811adc85df52f410d7306788fabfc6242d/u);
	assert.match(workflow, /db9f1182f5f2a64ea496752899626578d2b313a7/u);
	assert.match(workflow, /b8f170971e747fec20a03b25a4490f627140709a/u);
	assert.match(workflow, /wasi-sdk-33\.0-x86_64-linux\.tar\.gz/u);
	assert.match(workflow, /v0\.0\.1-go1\.24\.6\.linux-amd64\.zip/u);
	assert.match(workflow, /uses: actions\/cache@v4/u);
	assert.match(workflow, /TINYGO_LLVM_BUILD/u);
	assert.match(workflow, /build-llvm-wasi\.mjs[\s\S]*--execute/u);
	assert.match(
		workflow,
		/build-browser-compiler\.mjs[\s\S]*--native-wasm-ld "\$TINYGO_WASI_SDK\/bin\/wasm-ld"[\s\S]*--execute/u
	);
	assert.match(workflow, /build-package-graph-provider\.mjs[\s\S]*--execute/u);
	assert.match(workflow, /accept-browser-compiler\.mjs/u);
	assert.match(workflow, /verify-artifacts\.mjs/u);
});

test('TinyGo producer publishes only the verified browser consumer inputs', async () => {
	const workflow = await readFile(workflowPath, 'utf8');

	assert.match(workflow, /uses: actions\/upload-artifact@v4/u);
	for (const artifact of [
		'tinygo-compiler.wasm',
		'tinygoroot.tar.gz',
		'producer-receipt.json',
		'tinygo-package-graph.wasm',
		'package-graph-provider-receipt.json',
		'lld.wasm',
		'tinygo-source-receipt.json'
	]) {
		assert.match(workflow, new RegExp(artifact.replaceAll('.', '\\.'), 'u'));
	}
	assert.match(workflow, /retention-days: 14/u);
});
