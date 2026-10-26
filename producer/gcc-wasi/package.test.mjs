import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identity } from '../clang-browser/cross/package.mjs';
import { verifyInventory, checkWasm, verifySimdQualification } from './package.mjs';
import { cases, disabledCases } from './simd-fixtures.mjs';

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

test('SIMD capability requires the complete suite from the packaged native compiler', () => {
	const expected = {
		gccCommit: 'a'.repeat(40), compilerSha256: 'b'.repeat(64),
		fixture: identity(Buffer.from('fixture')), testRecipe: identity(Buffer.from('recipe')),
		assembler: identity(Buffer.from('assembler')), linker: identity(Buffer.from('linker')),
		runtime: { 'libc.a': identity(Buffer.from('runtime')) }
	};
	const report = {
		kind: 'gcc-wasi-native-simd-qualification', status: 'passed',
		gccCommit: expected.gccCommit, compiler: { sha256: expected.compilerSha256 },
		fixture: expected.fixture, testRecipe: expected.testRecipe, assembler: expected.assembler,
		linker: expected.linker, runtime: expected.runtime,
		cases: [...cases, ...disabledCases].map((test) => ({
			id: test.id, status: 'passed', source: identity(Buffer.from(test.request.code)),
			stdout: test.stdout, wasm: { bytes: 9, sha256: 'c'.repeat(64) },
			commands: ['cc1', 'wat2wasm', 'wasm-objdump', 'wasm-ld', 'node'].map((command, index) => ({
				command, argv: index === 0 ? [test.request.simd ? '-msimd128' : '-mno-simd128'] : [],
				status: 0, signal: null, stdout: index === 4 ? test.stdout : '', stderr: ''
			})), imports: [], exports: [{ name: 'memory', kind: 'memory' }, { name: '_start', kind: 'function' }]
		})),
		disabledDiagnostic: { status: 1, stderr: 'error: SIMD128 is disabled' },
		defaultDiagnostic: { status: 1, stderr: 'error: SIMD128 is disabled' }
	};
	verifySimdQualification(report, expected);
	assert.throws(() => verifySimdQualification({ ...report, compiler: { sha256: 'c'.repeat(64) } }, expected), /another GCC binary/);
	assert.throws(() => verifySimdQualification({ ...report, cases: report.cases.slice(1) }, expected), /incomplete/);
	assert.throws(() => verifySimdQualification({ ...report, cases: [...report.cases.slice(1), report.cases[1]] }, expected), /incomplete/);
	assert.throws(() => verifySimdQualification({ ...report, fixture: identity(Buffer.from('modified')) }, expected), /fixture changed/);
	assert.throws(() => verifySimdQualification({ ...report, disabledDiagnostic: { status: 0, stderr: 'SIMD128 is disabled' } }, expected), /disabled-profile/);
	const changed = structuredClone(report);
	changed.cases[0].source = identity(Buffer.from('a different program'));
	assert.throws(() => verifySimdQualification(changed, expected), /source differs/);
	for (const field of ['commands', 'wasm', 'stdout']) {
		const missing = structuredClone(report);
		delete missing.cases[0][field];
		assert.throws(() => verifySimdQualification(missing, expected));
	}
	const wrongOutput = structuredClone(report);
	wrongOutput.cases[0].stdout = 'WRONG OUTPUT\n';
	assert.throws(() => verifySimdQualification(wrongOutput, expected), /output differs/);
	assert.throws(() => verifySimdQualification({ ...report, linker: identity(Buffer.from('different linker')) }, expected), /linker changed/);
	assert.throws(() => verifySimdQualification({ ...report, runtime: {} }, expected), /runtime differs/);
});
