import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/swift-browser-producer.yml', import.meta.url), 'utf8');
function runBlock(name) {
	const step = workflow.split(`- name: ${name}\n`)[1]?.split('\n            - ')[0];
	assert.ok(step, name);
	return step.split('run: |\n')[1].split('\n').map((line) => line.replace(/^ {18}/u, '')).join('\n');
}

test('workflow passes shell metacharacters literally to the CLI argument parser', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'swift-inputs-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const capture = path.join(root, 'args.json');
	const sentinel = path.join(root, 'executed');
	const hostile = `spaces ' " $(touch ${sentinel}) \`touch ${sentinel}\` ; \\ end`;
	await writeFile(path.join(root, 'pnpm'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.ARG_CAPTURE, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
	const inputs = [...workflow.matchAll(/^            (SWIFT_INPUT_\w+):/gmu)].map((match) => match[1]);
	const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, ARG_CAPTURE: capture, GITHUB_SERVER_URL: 'https://example.com', GITHUB_REPOSITORY: 'fixture/repo', GITHUB_RUN_ID: '1',
		WASM_SWIFT_SOURCE_ROOT: root, WASM_SWIFT_BOOTSTRAP_RECEIPT: path.join(root, 'receipt.json'),
		WASM_SWIFT_BUILD_DIR: root, WASM_SWIFT_RAW_RUNTIME_DIR: root, WASM_SWIFT_BUILD_PLAN: 'plan.json',
		WASM_SWIFT_BROWSER_BUILD_LOG: 'build.log', WASM_SWIFT_WORKFLOW_PREFLIGHT_RECEIPT: 'preflight.json',
		...Object.fromEntries(inputs.map((name) => [name, hostile])) };
	for (const name of ['Preflight workflow inputs', 'Bootstrap Swift source checkout', 'Write browser compiler build plan and run build command', 'Package runtime from build plan', 'Export runtime archive']) {
		const script = runBlock(name);
		assert.doesNotMatch(script, /\$\{\{\s*inputs\./u);
		execFileSync('bash', ['-euo', 'pipefail', '-c', script], { env });
		const args = JSON.parse(await readFile(capture));
		assert.ok(args.includes(hostile), name);
		await assert.rejects(access(sentinel));
	}
});

test('workflow path export rejects newline injection before writing any environment data', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'swift-paths-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const destination = path.join(root, 'env');
	await writeFile(destination, 'PREVIOUS=ok\n');
	const script = new URL('../producer/swift-browser/scripts/workflow-paths.mjs', import.meta.url);
	const env = { ...process.env, RUNNER_TEMP: root, GITHUB_ENV: destination, SWIFT_INPUT_CHECKOUT_ROOT: 'path\nINJECTED=true' };
	assert.throws(() => execFileSync(process.execPath, [script.pathname], { env, stdio: 'pipe' }), /Invalid workflow path/);
	assert.equal(await readFile(destination, 'utf8'), 'PREVIOUS=ok\n');
	env.SWIFT_INPUT_CHECKOUT_ROOT = "path with spaces ' $(literal)";
	execFileSync(process.execPath, [script.pathname], { env });
	assert.ok((await readFile(destination, 'utf8')).includes(`WASM_SWIFT_SOURCE_ROOT=${env.SWIFT_INPUT_CHECKOUT_ROOT}\n`));
});
