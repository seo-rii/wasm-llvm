import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { probeCgoModuleLink } from '../scripts/probe-cgo-module-link.mjs';

const temporary = [];
afterEach(async () => {
	await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(warningPhase = '', acceptInvalidAbi = false) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'tinygo-cgo-module-link-'));
	temporary.push(root);
	await mkdir(path.join(root, 'builder'));
	await mkdir(path.join(root, 'bin'));
	const patch = await readFile(new URL('../patches/tinygo-wasi-adapter.patch', import.meta.url), 'utf8');
	const section = patch.split('diff --git a/builder/cgo_target.go b/builder/cgo_target.go\n')[1].split('\ndiff --git ')[0];
	const helper = section.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).map((line) => line.slice(1)).join('\n') + '\n';
	await writeFile(path.join(root, 'builder', 'cgo_target.go'), helper);
	await writeFile(path.join(root, 'builder', 'build.go'), 'normalizeCGoHeaderTarget(mod, headerMod)\nllvm.LinkModules(mod, headerMod)\n');
	await writeFile(path.join(root, 'libLLVM.so'), 'native-library-fixture');
	await writeFile(path.join(root, 'bin', 'cc'), 'host-compiler-fixture');
	await chmod(path.join(root, 'bin', 'cc'), 0o755);
	const names = ['legacy-destination', 'canonical-destination', 'same-legacy', 'same-canonical', 'preview2', 'wasm64', 'unknown-vendor', 'different-layout', 'empty-header-layout', 'empty-destination-layout'];
	const calls = [];
	const run = async (command, args, options) => {
		const name = path.basename(options.stderrPath, '.stderr');
		calls.push(name);
		let stdout = '';
		let stderr = name === 'baseline' ? 'warning: Linking two modules of different target triples\n' : '';
		if (name === warningPhase) stderr = 'warning: preserved compiler diagnostic\n';
		if (name === 'clang') await writeFile(args.at(-1), 'bitcode-fixture');
		if (name === 'compile') await writeFile(args[args.indexOf('-o') + 1], 'executable-fixture');
		if (name === 'baseline' || name === 'normalize') {
			stdout = JSON.stringify({ mode: name, llvmVersion: '22.1.0', cases: names.map((item, index) => ({
				case: item, result: index < 4 || (acceptInvalidAbi && index === 4) ? 'linked-and-verified' : 'rejected-before-link', globalValue: 42
			})) });
		}
		await writeFile(options.stdoutPath, stdout);
		await writeFile(options.stderrPath, stderr);
		return { exitCode: 0, signal: null };
	};
	return { root, calls, run, options: {
		nativeTinyGo: '/native/tinygo', nativeLlvmLibrary: path.join(root, 'libLLVM.so'),
		sourceRoot: root, goRoot: '/pinned/go', buildDir: root,
		expectedDataLayout: 'exact-layout', environment: { PATH: path.join(root, 'bin') }
	} };
}

test('records separate compiler diagnostics and exact-helper native-link results', async () => {
	const item = await fixture();
	const receipt = await probeCgoModuleLink(item.options, { run: item.run });
	assert.equal(receipt.status, 'passed');
	assert.deepEqual(item.calls, ['cc-version', 'clang', 'compile', 'baseline', 'normalize']);
	assert.ok(receipt.commands.filter((command) => command.name !== 'baseline').every((command) => command.stderr.bytes === 0));
	assert.ok(receipt.commands.find((command) => command.name === 'baseline').stderr.bytes > 0);
	assert.equal(receipt.execution.cases.length, 10);
	const original = await readFile(path.join(item.root, 'builder', 'cgo_target.go'), 'utf8');
	assert.equal(await readFile(path.join(item.root, 'cgo-module-link-probe', 'normalization.go'), 'utf8'), original.replace(/^package builder$/mu, 'package main'));
});

test('rejects and preserves stderr even when compilation or normalization exits zero', async () => {
	for (const phase of ['clang', 'compile', 'normalize']) {
		const item = await fixture(phase);
		await assert.rejects(probeCgoModuleLink(item.options, { run: item.run }), /emitted stderr/u);
		assert.equal(item.calls.at(-1), phase);
		const saved = JSON.parse(await readFile(path.join(item.root, 'cgo-module-link-probe', 'receipt.json'), 'utf8'));
		assert.equal(saved.status, 'failed');
		assert.ok(saved.commands.at(-1).stderr.bytes > 0);
		assert.match(await readFile(saved.commands.at(-1).stderr.path, 'utf8'), /preserved compiler diagnostic/u);
	}
});

test('rejects a native result that accepts a non-Preview1 ABI', async () => {
	const item = await fixture('', true);
	await assert.rejects(probeCgoModuleLink(item.options, { run: item.run }), /rejected-before-link/u);
});
