import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identity } from '../clang-browser/cross/package.mjs';
import { verifyInventory, checkWasm, verifySimdQualification, verifyVectorAbiQualification } from './package.mjs';
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
		runtime: { 'libc.a': identity(Buffer.from('runtime')) }, targetSource: { 'wasm.md': identity(Buffer.from('target source')) }
	};
	const report = {
		kind: 'gcc-wasi-native-simd-qualification', status: 'passed',
		gccCommit: expected.gccCommit, compiler: { sha256: expected.compilerSha256 },
		fixture: expected.fixture, testRecipe: expected.testRecipe, assembler: expected.assembler,
		linker: expected.linker, runtime: expected.runtime, targetSource: expected.targetSource,
		cases: [...cases, ...disabledCases].map((test) => ({
			id: test.id, status: 'passed', source: identity(Buffer.from(test.request.code)),
			stdout: test.stdout, wasm: { bytes: 9, sha256: 'c'.repeat(64) },
			commands: ['cc1', 'wat2wasm', 'wasm-objdump', 'wasm-ld', 'node'].map((command, index) => ({
				command, argv: index === 0 ? [`-O${test.request.optimization}`, `-std=${test.request.standard}`, test.request.simd ? '-msimd128' : '-mno-simd128'] : index === 3 ? ['--fatal-warnings'] : [],
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
	assert.throws(() => verifySimdQualification({ ...report, targetSource: {} }, expected), /backend sources differ/);
	for (const option of ['-O3', '-std=c99', '-mno-simd128']) {
		const changed = structuredClone(report);
		changed.cases[0].commands[0].argv.push(option);
		assert.throws(() => verifySimdQualification(changed, expected), /differs from fixture/);
	}
	const otherRunner = structuredClone(report);
	otherRunner.cases[0].commands.at(-1).command = '/usr/bin/printf';
	assert.throws(() => verifySimdQualification(otherRunner, expected));
	const linkerWarnings = structuredClone(report);
	linkerWarnings.cases[0].commands[3].argv = [];
	assert.throws(() => verifySimdQualification(linkerWarnings, expected), /reject signature warnings/);
	const cppFixture = { ...cases[0], request: { ...cases[0].request, language: 'cpp' } };
	const extendedExpected = { ...expected, kind: 'gcc-wasi-native-simd-extended-qualification', fixtures: [cppFixture], compilerCppSha256: 'd'.repeat(64) };
	const extended = { ...structuredClone(report), kind: extendedExpected.kind, compilerCpp: { sha256: extendedExpected.compilerCppSha256 }, cases: [structuredClone(report.cases[0])] };
	extended.cases[0].commands[0].command = 'cc1plus';
	verifySimdQualification(extended, extendedExpected);
	assert.throws(() => verifySimdQualification({ ...extended, compilerCpp: { sha256: 'e'.repeat(64) } }, extendedExpected), /another C\+\+ compiler/);
	assert.throws(() => verifySimdQualification(extended, expected), /strictly equal/);
});

test('vector ABI qualification binds both optimization levels, mixed compilers, signatures and runtime', () => {
	const fixture = {
		id: 'vector-direct', request: { language: 'c', standard: 'gnu11', simd: true, code: 'int main(void) { return 0; }', sources: ['provider.c'], files: [{ path: 'provider.c', contents: 'int provider(void) { return 1; }' }] },
		stdout: 'vector ABI ok\n', signatures: { provider: { params: ['v128'], results: ['v128'] } }
	};
	const disabled = { ...fixture, id: 'vector-disabled', request: { ...fixture.request, simd: false }, signatures: { provider: { params: ['i32', 'i32'], results: [] } } };
	const fixtures = [fixture, disabled];
	const expected = { gccCommit: 'a'.repeat(40), tools: { gcc: 'b'.repeat(64), gccCpp: 'c'.repeat(64), clang: 'd'.repeat(64) }, fixture: identity(Buffer.from('fixtures')), testRecipe: identity(Buffer.from('recipe')), inspectionRecipe: identity(Buffer.from('inspection recipe')), runtime: { 'libc.a': identity(Buffer.from('libc')) }, targetSource: { 'wasm.md': identity(Buffer.from('target source')) } };
	const report = {
		kind: 'gcc-wasi-vector-abi-interop', status: 'passed', inputsUnchanged: true, compilerHost: 'native', outputTarget: 'wasm32-wasi', gccCommit: expected.gccCommit,
		tools: Object.fromEntries(Object.entries(expected.tools).map(([name, sha256]) => [name, { sha256 }])), fixtures: expected.fixture, harness: expected.testRecipe, inspectionRecipe: expected.inspectionRecipe, runtime: expected.runtime, targetSource: expected.targetSource,
		cases: fixtures.flatMap(value => ['0', '2'].flatMap(optimization => (value.request.simd ? ['gcc-gcc', 'gcc-clang', 'clang-gcc', 'clang-clang'] : ['gcc-gcc']).map(direction => {
			const commands = [];
			const units = [value.request.code, value.request.files[0].contents].map((source, index) => {
				const compiler = direction.split('-')[index];
				for (const command of compiler === 'gcc' ? ['cc1', 'wat2wasm', 'wasm-objdump'] : ['clang', 'wasm-objdump'])
					commands.push({ command, argv: [`-O${optimization}`, '-std=gnu11', value.request.simd ? '-msimd128' : '-mno-simd128'], status: 0, signal: null });
				return { compiler, source: identity(Buffer.from(source)) };
			});
			commands.push({ command: 'wasm-ld', argv: ['--fatal-warnings'], status: 0, signal: null }, { command: 'node', argv: [], status: 0, signal: null, stdout: value.stdout, stderr: '' });
			return { id: `${value.id}-o${optimization}-${direction}`, fixture: value.id, optimization, direction, simd: value.request.simd, status: 'passed', stdout: value.stdout, units, commands,
				program: { bytes: 9, sha256: 'e'.repeat(64) }, imports: [], exports: [{ name: '_start', kind: 'function' }, { name: 'memory', kind: 'memory' }], abi: { exports: { _start: { params: [], results: [] }, ...value.signatures }, memories: [{ shared: false }] } };
		})))
	};
	report.counts = { total: report.cases.length, passed: report.cases.length, failed: 0 };
	verifyVectorAbiQualification(report, expected, fixtures);
	for (const edit of [
		changed => changed.cases.pop(),
		changed => { changed.tools.gccCpp.sha256 = 'f'.repeat(64); },
		changed => { changed.cases[0].abi.exports.provider = { params: ['i32', 'i32'], results: [] }; },
		changed => { changed.cases[1].units[1].compiler = 'gcc'; },
		changed => { changed.cases[0].commands.at(-1).stdout = 'wrong\n'; },
		changed => { changed.cases[0].commands.at(-2).argv = []; },
		changed => { changed.cases[0].commands[0].argv.push('-mno-simd128'); },
		changed => { changed.cases[0].commands[0].argv.push('-O0'); },
		changed => { changed.runtime['libc.a'] = identity(Buffer.from('other runtime')); },
		changed => { changed.targetSource = {}; },
		changed => { changed.inputsUnchanged = false; }
	]) {
		const changed = structuredClone(report); edit(changed);
		assert.throws(() => verifyVectorAbiQualification(changed, expected, fixtures));
	}
});
