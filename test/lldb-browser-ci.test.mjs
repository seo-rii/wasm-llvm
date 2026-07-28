import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('CI gates pinned LLDB and WAMR browser producer contracts', async () => {
	const workflow = await fs.readFile('.github/workflows/lldb-browser.yml', 'utf8');

	assert.match(workflow, /pull_request:/);
	assert.match(workflow, /branches: \[main\]/);
	assert.match(
		workflow,
		/node --test producer\/lldb-browser\/test\/producer\.test\.mjs producer\/wamr-browser\/test\/producer\.test\.mjs test\/lldb-browser-ci\.test\.mjs/
	);
	assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
});
