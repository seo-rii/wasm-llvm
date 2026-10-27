import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identity } from '../clang-browser/cross/package.mjs';
import { verifyInventory, verifyRuntimeLibraryIdentities, checkWasm, verifySimdQualification, verifyVectorAbiQualification, verifyLongDoubleQualification, verifyInt128Qualification, verifyWideScalarQualificationOptions } from './package.mjs';
import { cases, disabledCases } from './simd-fixtures.mjs';
import { cases as int128Cases } from './int128-fixtures.mjs';

function binary128ProofFixture(simd = false) {
	const fixture = {
		id: 'long-double-probe-o0', interop: true, printscan: true, stdin: '1.25\n', stdout: '113 1.25\n',
		request: { language: 'c', standard: 'gnu11', optimization: '0', simd, code: 'main source', defines: ['ONLINE_JUDGE=1'], sources: ['provider.c'], files: [{ path: 'provider.c', contents: 'provider source' }] },
		signatures: { probe: { params: ['i32', 'i64', 'i64'], results: [] } }
	};
	const names = { gcc: 'cc1', gccCpp: 'cc1plus', clang: 'clang', assembler: 'wat2wasm', inspector: 'wasm-objdump', linker: 'wasm-ld', node: 'node' };
	const expected = {
		gccCommit: 'a'.repeat(40), targetSource: { 'tf.md': identity(Buffer.from('target')) }, recipes: { fixtures: identity(Buffer.from('fixtures')) },
		tools: Object.fromEntries(Object.entries(names).map(([key, name]) => [key, identity(Buffer.from(name))])),
		runtime: { printscan: identity(Buffer.from('printscan')) },
		headers: {
			libc: { 'stdio.h': identity(Buffer.from('stdio')) },
			clangLibc: { 'wasm32-wasi/stdio.h': identity(Buffer.from('clang stdio')) },
			clangResource: { 'stddef.h': identity(Buffer.from('clang stddef')) }
		}
	};
	const report = { kind: 'gcc-wasi-long-double-qualification', status: 'passed', inputsUnchanged: true, compilerHost: 'native', outputTarget: 'wasm32-wasi', ...structuredClone(expected), selectedCases: [fixture.id], directions: ['gcc-gcc', 'gcc-clang', 'clang-gcc', 'clang-clang'] };
	for (const [key, name] of Object.entries(names)) report.tools[key].path = `/verified/tools/${name}`;
	report.runtime.printscan.path = '/sysroot/lib/wasm32-wasi/libc-printscan-long-double.a';
	report.cases = report.directions.map(direction => {
		const families = direction.split('-');
		const common = ['-O0', '-std=gnu11', simd ? '-msimd128' : '-mno-simd128', '-D__GCC_WASI_SINGLE_THREAD__=1', '-DONLINE_JUDGE=1'];
		const commands = families.flatMap(family => {
			const keys = family === 'gcc' ? ['gcc', 'assembler', 'inspector'] : ['clang', 'clang', 'inspector'];
			return keys.map((key, index) => ({
				command: report.tools[key].path,
				argv: family === 'clang' && index < 2 ? [...common, ...(index === 0 ? ['-S', '-emit-llvm'] : ['-c'])] : index === 0 ? [...common] : [],
				status: 0, signal: null, stdout: '', stderr: ''
			}));
		});
		commands.push({ command: report.tools.linker.path, argv: ['--fatal-warnings', report.runtime.printscan.path, '-lc'], status: 0, signal: null }, { command: report.tools.node.path, argv: [], status: 0, signal: null, stdout: fixture.stdout, stderr: '' });
		return { id: `${fixture.id}-${direction}`, fixture: fixture.id, direction, status: 'passed', optimization: '0', stdin: fixture.stdin, stdout: fixture.stdout, stderr: '', commands,
			units: families.map((compiler, index) => ({ compiler, source: identity(Buffer.from(index ? 'provider source' : fixture.request.code)) })),
			abi: { memories: [{ shared: false }], exports: { _start: { params: [], results: [] }, ...fixture.signatures } }, imports: [], exports: [{ name: 'memory', kind: 'memory' }, { name: '_start', kind: 'function' }] };
	});
	report.counts = { total: 4, passed: 4, failed: 0 };
	return { fixture, expected, report };
}

function int128ProofFixture() {
	const { expected } = binary128ProofFixture();
	expected.targetSource = { 'wasm-cg.cc': identity(Buffer.from('TI target')) };
	expected.recipes = Object.fromEntries(['fixtures', 'harness', 'inspector'].map(name => [name, identity(Buffer.from(`int128 ${name}`))]));
	expected.runtime = Object.fromEntries(['crt1-command.o', 'libc.a', 'libm.a', 'builtins', 'gnuCpp', 'gnuAbi', 'clangCpp', 'clangAbi'].map(name => [name, identity(Buffer.from(name))]));
	expected.headers.gcc = { 'stddef.h': identity(Buffer.from('GCC stddef')) };
	expected.headers.gnuCpp = { vector: identity(Buffer.from('GNU vector')) };
	const report = {
		...structuredClone(expected), kind: 'gcc-wasi-int128-qualification', status: 'passed', inputsUnchanged: true,
		compilerHost: 'native', outputTarget: 'wasm32-wasi', selectedCases: int128Cases.map(fixture => fixture.id),
		suiteSha256: identity(Buffer.from(JSON.stringify(int128Cases))).sha256,
		directions: ['gcc-gcc', 'gcc-clang', 'clang-gcc', 'clang-clang']
	};
	for (const [key, name] of Object.entries({ gcc: 'cc1', gccCpp: 'cc1plus', clang: 'clang', assembler: 'wat2wasm', inspector: 'wasm-objdump', linker: 'wasm-ld', node: 'node' }))
		report.tools[key].path = `/verified/tools/${name}`;
	report.cases = int128Cases.flatMap(fixture => report.directions
		.filter(direction => fixture.interop || direction === 'gcc-gcc' || direction === 'clang-clang')
		.map(direction => {
			const families = direction.split('-');
			const sources = [fixture.request.code, ...(fixture.request.sources || []).map(name => fixture.request.files.find(file => file.path === name).contents)];
			const common = [`-O${fixture.request.optimization}`, `-std=${fixture.request.standard}`, fixture.request.simd ? '-msimd128' : '-mno-simd128', '-D__GCC_WASI_SINGLE_THREAD__=1', '-DONLINE_JUDGE=1'];
			const commands = [];
			const units = sources.map((source, index) => {
				const family = families[index === 0 ? 0 : 1];
				const frontend = fixture.request.language === 'cpp' ? 'gccCpp' : 'gcc';
				const tools = family === 'gcc' ? [frontend, 'assembler', 'inspector'] : ['clang', 'clang', 'inspector'];
				for (const [step, tool] of tools.entries()) commands.push({
					command: report.tools[tool].path,
					argv: family === 'clang' && step < 2 ? [...common, ...(step === 0 ? ['-S', '-emit-llvm'] : ['-c'])] : step === 0 ? [...common] : [],
					status: 0, signal: null, stdout: '', stderr: ''
				});
				return { compiler: family, source: identity(Buffer.from(source)) };
			});
			commands.push({ command: report.tools.linker.path, argv: ['--fatal-warnings', '-lc'], status: 0, signal: null },
				{ command: report.tools.node.path, argv: [], status: 0, signal: null, stdout: fixture.stdout, stderr: '' });
			return {
				id: `${fixture.id}-${direction}`, fixture: fixture.id, fixtureSha256: identity(Buffer.from(JSON.stringify(fixture))).sha256,
				direction, optimization: fixture.request.optimization, status: 'passed', stdin: fixture.stdin,
				stdout: fixture.stdout, stderr: '', units, commands,
				abi: { memories: [{ shared: false }], exports: { _start: { params: [], results: [] }, ...fixture.signatures } },
				imports: [], exports: [{ name: 'memory', kind: 'memory' }, { name: '_start', kind: 'function' }]
			};
		}));
	report.counts = { total: report.cases.length, passed: report.cases.length, failed: 0 };
	return { fixtures: int128Cases, expected, report };
}

test('locked binary128 and int128 backends require complete native proof and a qualified GNU runtime', () => {
	const old = { path: 'patches/0008-binary128-long-double.patch' };
	const integer = { path: 'patches/0009-int128.patch' };
	verifyWideScalarQualificationOptions([], {}); // Existing profiles without either patch keep optional proofs.
	verifyWideScalarQualificationOptions([old], { longDoubleQualification: 'TF.json', nativeLinker: 'wasm-ld', libstdcxx: 'GNU' });
	const complete = { longDoubleQualification: 'TF.json', int128Qualification: 'TI.json', nativeLinker: 'wasm-ld', libstdcxx: 'GNU' };
	verifyWideScalarQualificationOptions([old, integer], complete);
	assert.throws(() => verifyWideScalarQualificationOptions([old], {}), /requires --long-double-qualification/);
	assert.throws(() => verifyWideScalarQualificationOptions([integer], {}), /requires --int128-qualification/);
	for (const field of ['longDoubleQualification', 'int128Qualification', 'nativeLinker', 'libstdcxx']) {
		const changed = { ...complete }; delete changed[field];
		assert.throws(() => verifyWideScalarQualificationOptions([old, integer], changed));
	}
});

test('int128 rejects absent or partial native proof rather than advertising a capability (synthetic receipts)', () => {
	const { fixtures, expected, report } = int128ProofFixture();
	assert.equal(fixtures.length, 42);
	assert.deepEqual(report.counts, { total: 116, passed: 116, failed: 0 });
	verifyInt128Qualification(report, expected, fixtures);
	assert.throws(() => verifyInt128Qualification(undefined, expected, fixtures), /requires native qualification proof/);
	for (const mutate of [
		r => { r.counts = { total: 42, passed: 42, failed: 0 }; r.cases = r.cases.filter(test => test.direction === 'gcc-gcc'); },
		r => { r.cases.pop(); },
		r => { r.cases[0] = structuredClone(r.cases[1]); },
		r => { r.selectedCases.pop(); },
		r => { r.directions.pop(); },
		r => { r.status = 'failed'; },
		r => { r.inputsUnchanged = false; },
		r => { r.suiteSha256 = 'f'.repeat(64); },
		r => { r.cases[0].fixtureSha256 = 'e'.repeat(64); }
	]) {
		const changed = structuredClone(report); mutate(changed);
		assert.throws(() => verifyInt128Qualification(changed, expected, fixtures));
	}
});

test('int128 binds source, current compiler/runtime/headers and exact ABI (synthetic receipts)', () => {
	const { fixtures, expected, report } = int128ProofFixture();
	for (const mutate of [
		r => { r.tools.gcc.sha256 = 'b'.repeat(64); },
		r => { r.tools.gccCpp.sha256 = 'c'.repeat(64); },
		r => { r.tools.node.sha256 = 'd'.repeat(64); },
		r => { r.runtime.builtins.sha256 = 'e'.repeat(64); },
		r => { r.runtime.gnuCpp.sha256 = 'e'.repeat(64); },
		r => { r.headers.gnuCpp.vector.sha256 = 'e'.repeat(64); },
		r => { r.headers.clangResource['stddef.h'].sha256 = 'e'.repeat(64); },
		r => { r.targetSource = {}; },
		r => { r.recipes.harness.sha256 = 'e'.repeat(64); },
		r => { r.cases[0].units[0].source.sha256 = 'e'.repeat(64); },
		r => { r.cases.find(test => test.fixture === 'int128-abi-scalar-o0').abi.exports.ti_modify = { params: ['f64'], results: ['f64'] }; },
		r => { r.cases[0].abi.memories[0].shared = true; },
		r => { r.cases[0].imports.push({ module: 'env', kind: 'function', name: 'foreign' }); },
		r => { r.cases[0].exports.shift(); },
		r => { r.cases[0].stdout = 'wrong output\n'; }
	]) {
		const changed = structuredClone(report); mutate(changed);
		assert.throws(() => verifyInt128Qualification(changed, expected, fixtures));
	}
});

test('int128 checks GCC and both Clang invocations, macros, SIMD flags and executed tool paths (synthetic receipts)', () => {
	const { fixtures, expected, report } = int128ProofFixture();
	for (const family of ['gcc', 'clang']) {
		for (const mutate of [
			argv => argv.push('-O3'),
			argv => argv.push('-std=gnu99'),
			argv => argv.push('-msimd128'),
			argv => argv.push('-DONLINE_JUDGE=0'),
			argv => argv.splice(argv.indexOf('-DONLINE_JUDGE=1'), 1)
		]) {
			const changed = structuredClone(report);
			const test = changed.cases.find(entry => entry.fixture === 'int128-abi-scalar-o0' && entry.direction === `${family}-${family}`);
			mutate(test.commands[family === 'clang' ? 1 : 0].argv);
			assert.throws(() => verifyInt128Qualification(changed, expected, fixtures));
		}
	}
	for (const mutate of [
		r => { r.cases[0].commands[0].command = '/other/cc1'; },
		r => { r.cases.find(test => test.direction === 'clang-clang').commands[1].command = '/other/clang'; },
		r => { r.cases[0].commands.at(-2).argv = ['-lc']; },
		r => { r.cases[0].commands.at(-1).stdout = 'wrong\n'; },
		r => { r.cases[0].commands[0].status = 1; },
		r => { r.cases[0].commands[0].signal = 'SIGTERM'; }
	]) {
		const changed = structuredClone(report); mutate(changed);
		assert.throws(() => verifyInt128Qualification(changed, expected, fixtures));
	}
});

test('binary128 capability rejects incomplete interop, changed inputs and invalid library ordering (synthetic receipts)', () => {
	const { fixture, expected, report } = binary128ProofFixture();
	verifyLongDoubleQualification(report, expected, [fixture]);
	for (const mutate of [
		r => r.cases.pop(),
		r => { r.inputsUnchanged = false; },
		r => { r.tools.gcc.sha256 = 'b'.repeat(64); },
		r => { r.runtime.printscan.sha256 = 'c'.repeat(64); },
		r => { r.headers.libc['stdio.h'].sha256 = 'd'.repeat(64); },
		r => { r.cases[0].abi.exports.probe = { params: ['f64'], results: ['f64'] }; },
		r => { r.cases[0].commands[0].argv[2] = '-msimd128'; },
		r => { r.cases[0].commands[0].argv.pop(); },
		r => { r.cases[0].commands.at(-2).argv.reverse(); },
		r => { r.cases[0].stdout = '53 1.25\n'; }
	]) {
		const changed = structuredClone(report); mutate(changed);
		assert.throws(() => verifyLongDoubleQualification(changed, expected, [fixture]));
	}
});

test('binary128 verifies both Clang invocations against the scalar or SIMD fixture', () => {
	for (const simd of [false, true]) {
		const { fixture, expected, report } = binary128ProofFixture(simd);
		verifyLongDoubleQualification(report, expected, [fixture]);
		for (const mutate of [
			argv => { argv[0] = '-O3'; },
			argv => { argv[1] = '-std=gnu99'; },
			argv => { argv[2] = simd ? '-mno-simd128' : '-msimd128'; },
			argv => { argv[4] = '-DONLINE_JUDGE=0'; },
			argv => { argv.push('-DONLINE_JUDGE=0'); },
			argv => { argv.splice(3, 1); },
			argv => { argv.pop(); }
		]) {
			// Test both the main and provider object compile, whose preceding IR
			// commands still retain the correct fixture profile.
			for (const index of [1, 4]) {
				const changed = structuredClone(report);
				mutate(changed.cases.find(test => test.direction === 'clang-clang').commands[index].argv);
				assert.throws(() => verifyLongDoubleQualification(changed, expected, [fixture]));
			}
		}
		const irMismatch = structuredClone(report);
		irMismatch.cases.find(test => test.direction === 'clang-clang').commands[0].argv.pop();
		assert.throws(() => verifyLongDoubleQualification(irMismatch, expected, [fixture]), /Clang compilation stage/);
	}
});

test('binary128 binds every executed tool path to its measured compiler or runtime', () => {
	const { fixture, expected, report } = binary128ProofFixture();
	const alias = structuredClone(report);
	alias.cases[0].commands[0].command = '/verified/../verified/tools/cc1';
	verifyLongDoubleQualification(alias, expected, [fixture]);
	for (const index of [0, 1, 2, 6, 7]) {
		const changed = structuredClone(report);
		changed.cases[0].commands[index].command = changed.cases[0].commands[index].command.replace('/verified/', '/unqualified/');
		assert.throws(() => verifyLongDoubleQualification(changed, expected, [fixture]), /executed tool differs/);
	}
	const clang = structuredClone(report);
	clang.cases.find(test => test.direction === 'clang-clang').commands[1].command = '/other/clang';
	assert.throws(() => verifyLongDoubleQualification(clang, expected, [fixture]), /executed tool differs/);
	const node = structuredClone(report);
	node.tools.node.sha256 = 'f'.repeat(64);
	assert.throws(() => verifyLongDoubleQualification(node, expected, [fixture]), /tools differs: node/);
	const unbound = structuredClone(expected);
	delete unbound.tools.node;
	assert.throws(() => verifyLongDoubleQualification(report, unbound, [fixture]), /no expected fingerprint: node/);
});

test('binary128 checks both Clang sysroot and resource headers against the reference SDK', () => {
	const { fixture, expected, report } = binary128ProofFixture();
	for (const name of ['clangLibc', 'clangResource']) {
		const changed = structuredClone(report);
		Object.values(changed.headers[name])[0].sha256 = 'f'.repeat(64);
		assert.throws(() => verifyLongDoubleQualification(changed, expected, [fixture]), /Binary128 headers differ/);
	}
});

test('locked runtime library bytes cannot be replaced by updating a self-consistent build receipt', () => {
	const name = 'libc-printscan-long-double.a';
	const original = { path: `lib/wasm32-wasi/${name}`, bytes: Buffer.from('locked printscan') };
	const locked = { [name]: identity(original.bytes) };
	verifyRuntimeLibraryIdentities([original], locked);
	verifyRuntimeLibraryIdentities([], undefined); // Older runtime locks have no extra pins.
	const changed = { ...original, bytes: Buffer.from('different printscan') };
	verifyInventory([changed], [{ path: changed.path, ...identity(changed.bytes) }], 'self-consistent receipt');
	assert.throws(() => verifyRuntimeLibraryIdentities([changed], locked), /differs from its lock/);
	assert.throws(() => verifyRuntimeLibraryIdentities([], locked), /Locked runtime library missing/);
});

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
