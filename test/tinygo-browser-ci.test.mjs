import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const workflowPath = '.github/workflows/tinygo-browser-producer.yml';

test('manual TinyGo producer rebuilds and accepts the source-locked upstream toolchain', async () => {
	const workflow = await readFile(workflowPath, 'utf8');

	assert.match(workflow, /workflow_dispatch:/u);
	assert.match(workflow, /timeout-minutes: 360/u);
	assert.match(workflow, /2be7242b6a4d59fe89fb43f7d1e7333dc9b307a2/u);
	assert.match(workflow, /108a95cb26df6d5011366312dde0639b08d753cf/u);
	assert.match(workflow, /185673ef46a59528c40d0fdc220c6735606c0ebc/u);
	assert.match(workflow, /wasi-sdk-33\.0-x86_64-linux\.tar\.gz/u);
	assert.match(workflow, /v0\.0\.1-go1\.26\.10\.linux-amd64\.zip/u);
	assert.match(
		workflow,
		/Verify native TinyGo bootstrap inputs[\s\S]*TINYGOROOT="\$TINYGO_SOURCE"[\s\S]*"\$TINYGO_WASI_SDK\/bin\/wasm-ld" --version[\s\S]*Build source-locked LLVM host for WASI/u
	);
	assert.match(workflow, /uses: actions\/cache\/restore@v4/u);
	assert.match(workflow, /uses: actions\/cache\/save@v4/u);
	assert.match(workflow, /key: tinygo-llvm-wasi-v3-/u);
	assert.doesNotMatch(workflow, /tinygo-llvm-wasi-v1-/u);
	const cacheKeyLine = workflow
		.split('\n')
		.find((line) => line.includes('key: tinygo-llvm-wasi-v3-'));
	assert.ok(cacheKeyLine);
	assert.doesNotMatch(cacheKeyLine, /sources\.lock\.json/u);
	assert.match(
		workflow,
		/name: Build source-locked LLVM host for WASI\s+if: steps\.tinygo-llvm-cache\.outputs\.cache-hit != 'true'/u
	);
	assert.match(workflow, /if: steps\.tinygo-llvm-cache\.outputs\.cache-hit != 'true'/u);
	assert.match(workflow, /TINYGO_LLVM_BUILD/u);
	assert.match(workflow, /build-llvm-wasi\.mjs[\s\S]*--execute/u);
	assert.match(
		workflow,
		/build-browser-compiler\.mjs[\s\S]*--native-wasm-ld "\$TINYGO_WASI_SDK\/bin\/wasm-ld"[\s\S]*--execute/u
	);
	assert.match(workflow, /--native-tinygo-root "\$TINYGO_SOURCE"/u);
	assert.match(workflow, /--clang-resource-dir "\$TINYGO_NATIVE_ROOT\/lib\/clang"/u);
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
