import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { recordTools, verifyBootstrapFile } from '../scripts/verify-bootstrap.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const pins = JSON.parse(await fs.readFile(new URL('../config/bootstrap-toolchains.json', import.meta.url), 'utf8'));
async function temporary(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tinygo-bootstrap-test-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	return root;
}

test('bootstrap verification rejects corrupt and partial downloads before extraction', async (t) => {
	const root = await temporary(t);
	const archive = path.join(root, 'archive');
	const expected = Buffer.from('expected archive');
	const pin = { url: 'https://example.invalid/archive', sha256: sha256(expected) };
	for (const bytes of [Buffer.alloc(0), expected.subarray(0, 4), Buffer.from('altered archive')]) {
		await fs.writeFile(archive, bytes);
		await assert.rejects(verifyBootstrapFile(archive, pin), /refusing to execute or extract/);
	}
	await fs.writeFile(archive, expected);
	assert.deepEqual(await verifyBootstrapFile(archive, pin), { ...pin, bytes: expected.length });
});

test('bootstrap receipt records executable bytes and actual version output', async (t) => {
	const root = await temporary(t);
	const executable = path.join(root, 'fake tool');
	const script = '#!/bin/sh\nprintf "test-tool 1.0\\n"\n';
	await fs.writeFile(executable, script, { mode: 0o755 });
	const receipt = { inputs: {}, tools: {} };
	await assert.rejects(recordTools(receipt, [['llvmTablegen', executable]]), /Missing verified bootstrap input/);
	for (const name of ['llvmInstaller', 'wasiSdk', 'tinygo', 'go']) receipt.inputs[name] = pins[name];
	await recordTools(receipt, [['llvmTablegen', executable]]);
	assert.deepEqual(receipt.tools.llvmTablegen, { bytes: Buffer.byteLength(script), sha256: sha256(script), version: 'test-tool 1.0' });
});

test('workflow verifies every downloaded executable/archive before first use and keys cache by tool identity', async () => {
	const workflow = await fs.readFile('.github/workflows/tinygo-browser-producer.yml', 'utf8');
	for (const [pin, usage] of [
		['llvmInstaller', 'sudo "$RUNNER_TEMP/llvm.sh" 22'],
		['wasiSdk', 'tar -xzf "$TINYGO_WORK/wasi-sdk.tar.gz"'],
		['tinygo', 'tar -xzf "$TINYGO_WORK/tinygo.tar.gz"'],
		['go', 'unzip -q "$TINYGO_GO_ARCHIVE"']
	]) {
		const verification = workflow.indexOf(`                    ${pin} "`);
		assert.ok(verification > 0 && verification < workflow.indexOf(usage), `${pin} must be verified before use`);
		assert.ok(workflow.includes(pins[pin].url), `${pin} download URL must match its pin`);
	}
	assert.match(workflow, /key: tinygo-llvm-wasi-v3-.*TINYGO_BOOTSTRAP_SHA256/);
	assert.match(workflow, /bootstrap-receipt\.json/);
});

test('bootstrap inputs and recorded native tools match the producer source lock', async () => {
	const sources = JSON.parse(await fs.readFile(new URL('../sources.lock.json', import.meta.url), 'utf8'));
	const workflow = await fs.readFile('.github/workflows/tinygo-browser-producer.yml', 'utf8');
	assert.equal(pins.go.url, `https://proxy.golang.org/${sources.goToolchain.module}/@v/${sources.goToolchain.archiveFilename}`);
	assert.equal(pins.go.sha256, sources.goToolchain.archiveSha256);
	assert.equal(pins.tinygo.url, `https://github.com/tinygo-org/tinygo/releases/download/${sources.tinygo.ref}/tinygo${sources.tinygo.version}.linux-amd64.tar.gz`);
	for (const [name, binary] of [['llvmTablegen', 'llvm-tblgen'], ['clangTablegen', 'clang-tblgen']]) {
		assert.ok(workflow.includes(`"${name}=$TINYGO_NATIVE_TABLEGEN/bin/${binary}"`));
	}
	assert.ok(workflow.includes('--native-tool-dir "$TINYGO_NATIVE_TABLEGEN/bin"'));
	const sourceCheckout = workflow.indexOf(`git -C "$TINYGO_LLVM_SOURCE" checkout --detach`);
	const nativeBuild = workflow.indexOf('cmake --build "$TINYGO_NATIVE_TABLEGEN" --target llvm-tblgen clang-tblgen');
	const forkProbe = workflow.indexOf('-gen-riscv-espv-builtin-codegen');
	const toolReceipt = workflow.indexOf('--record-tools');
	const crossBuild = workflow.indexOf('name: Build source-locked LLVM host for WASI');
	assert.ok(sourceCheckout > 0 && sourceCheckout < nativeBuild);
	assert.ok(nativeBuild < forkProbe && forkProbe < toolReceipt && toolReceipt < crossBuild);
	assert.ok(workflow.includes('-S "$TINYGO_LLVM_SOURCE/llvm" -B "$TINYGO_NATIVE_TABLEGEN"'));
});
