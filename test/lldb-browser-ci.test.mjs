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

test('scheduled and manual CI run the pinned native C and DAP baselines', async () => {
	const workflow = await fs.readFile('.github/workflows/lldb-browser.yml', 'utf8');

	assert.match(workflow, /schedule:\s+- cron: '17 4 \* \* 1'/u);
	assert.match(workflow, /native_baseline:/u);
	assert.match(
		workflow,
		/native-baseline:\s+if: github\.event_name == 'schedule' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.native_baseline\)/su
	);
	assert.match(
		workflow,
		/LLVM_ARCHIVE_SHA256: df0e1ecf16caf3489a272a5eea4eec9b0d82878f6477fa309504f918a0006384/u
	);
	assert.match(
		workflow,
		/WASI_SDK_SHA256: 0ba8b5bfaeb2adf3f29bab5841d76cf5318ab8e1642ea195f88baba1abd47bce/u
	);
	assert.match(
		workflow,
		/WAMR_COMMIT: 25bd7eb63e828e4bd242cc9b38d260b4b31c6605/u
	);
	assert.match(
		workflow,
		/C_FIXTURE_SHA256: 226c0c142d2430d107927fef8aadd672bb8ed6b3ae1744c539e792bb8475bec3/u
	);
	assert.match(workflow, /actions\/cache@v4/u);
	assert.match(workflow, /bin\/lldb" --version.*22\.1\.8/su);
	assert.match(workflow, /-fdebug-compilation-dir=\/workspace/u);
	assert.match(workflow, /-ffile-prefix-map=.*=\/workspace/u);
	assert.match(workflow, /llvm-dwarfdump" --verify/u);
	assert.match(
		workflow,
		/llvm-dwarfdump" --debug-info.*grep --fixed-strings "\/workspace\/main\.c"/su
	);
	assert.match(
		workflow,
		/echo "\$C_FIXTURE_SHA256  \$PROGRAM_PATH" \| sha256sum --check/u
	);
	assert.match(workflow, /run-native-baseline\.mjs/u);
	assert.match(workflow, /run-native-dap-baseline\.mjs/u);
	assert.doesNotMatch(
		workflow,
		/native-baseline:[\s\S]*?continue-on-error:\s*true/u
	);
});
