import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('CI gates pinned LLDB and WAMR browser producer contracts', async () => {
	const workflow = await fs.readFile('.github/workflows/lldb-browser.yml', 'utf8');

	assert.match(workflow, /pull_request:/);
	assert.match(workflow, /branches: \[main\]/);
	assert.match(
		workflow,
		/node --test producer\/lldb-browser\/test\/producer\.test\.mjs producer\/wamr-browser\/test\/producer\.test\.mjs test\/debug-runtime-source\.test\.mjs test\/lldb-browser-ci\.test\.mjs/
	);
	assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
});

test('manual CI can rebuild and upload the pinned LLDB browser product', async () => {
	const workflow = await fs.readFile('.github/workflows/lldb-browser.yml', 'utf8');

	assert.match(workflow, /build_product:/);
	assert.match(
		workflow,
		/if: github\.event_name == 'workflow_dispatch' && inputs\.build_product/
	);
	assert.match(workflow, /node producer\/lldb-browser\/scripts\/prepare\.mjs/);
	assert.match(workflow, /node producer\/lldb-browser\/scripts\/build\.mjs/);
	assert.match(workflow, /uses: actions\/upload-artifact@v4/);
	assert.match(workflow, /artifacts\/lldb-browser/);
});

test('contract pushes cannot cancel an in-flight manual LLDB product build', async () => {
	const workflow = await fs.readFile('.github/workflows/lldb-browser.yml', 'utf8');

	assert.match(
		workflow,
		/build-product:\s+if:.*?\s+concurrency:\s+group: lldb-browser-product-\$\{\{ github\.ref \}\}\s+cancel-in-progress: false/su
	);
	assert.match(
		workflow,
		/producer-contracts:\s+concurrency:\s+group: lldb-browser-contracts-\$\{\{ github\.ref \}\}\s+cancel-in-progress: true/su
	);
});
