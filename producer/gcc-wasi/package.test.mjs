import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identity } from '../clang-browser/cross/package.mjs';
import { verifyInventory, checkWasm } from './package.mjs';

test('build receipt rejects modified, missing, extra, and duplicate compiler inputs', () => {
	const file = { path: 'cc1.wasm', bytes: Buffer.from('compiler bytes') };
	const receipt = [{ path: file.path, ...identity(file.bytes) }];
	verifyInventory([file], receipt, 'test compiler');
	assert.throws(() => verifyInventory([{ ...file, bytes: Buffer.from('modified bytes') }], receipt, 'test compiler'));
	assert.throws(() => verifyInventory([], receipt, 'test compiler'));
	assert.throws(() => verifyInventory([file, { ...file, path: 'unexpected.mjs' }], receipt, 'test compiler'));
	assert.throws(() => verifyInventory([file, file], [receipt[0], receipt[0]], 'test compiler'), /duplicate receipt path/);
});

test('legacy WABT size receipts normalize without weakening path/hash checks', () => {
	const bytes = Buffer.from('assembler bytes');
	const expected = { 'as.wasm': { size: bytes.length, sha256: identity(bytes).sha256 } };
	verifyInventory([{ path: 'as.wasm', bytes }], expected, 'assembler');
	assert.throws(() => verifyInventory([{ path: '../as.wasm', bytes }], { '../as.wasm': expected['as.wasm'] }, 'assembler'), /Unsafe bundle path/);
});

test('ELF and malformed Wasm cannot become executable compiler assets', () => {
	assert.throws(() => checkWasm(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]), 'cc1', true), /expected WebAssembly/);
	assert.throws(() => checkWasm(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 255]), 'cc1', true), /invalid executable Wasm/);
	assert.throws(() => checkWasm(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), 'cc1', true), /no exported memory/);
});
