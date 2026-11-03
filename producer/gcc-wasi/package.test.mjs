import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identity } from '../clang-browser/cross/package.mjs';
import { verifyInventory, verifyRuntimeLibraryIdentities, checkWasm, verifySimdQualification, verifyVectorAbiQualification, verifyLongDoubleQualification, verifyInt128Qualification, verifyWideScalarQualificationOptions, verifyEmptyAbiQualification, verifyBitfieldQualification, verifyAnonymousBitfieldQualification, verifyAbiQualificationOptions, verifyTypedMathProbes } from './package.mjs';
import { cases, disabledCases } from './simd-fixtures.mjs';
import { cases as int128Cases } from './int128-fixtures.mjs';
import { cases as emptyAbiCases } from './empty-abi-fixtures.mjs';
import { cases as bitfieldCases } from './wide-integer-bitfields-fixtures.mjs';
import { cases as anonymousBitfieldCases } from './anonymous-bitfield-fixtures.mjs';
import { verifyBrowserHostProfile, typedMathProbeContract } from './package.mjs';
import { verifySaturatingSimdQualification, verifySaturatingSimdQualificationOptions } from './package.mjs';
import { verifyGnuFloat128Qualification } from './package.mjs';
import { cases as gnuFloat128Cases } from './gnu-float128-fixtures.mjs';
import { cases as saturatingCases, disabledCases as saturatingDisabledCases, diagnosticCases as saturatingDiagnosticCases } from './simd-saturating-fixtures.mjs';
import { verifySimdHeaderInstallation } from './simd-header-qualification.mjs';
import { verifySymbolAliasPrograms } from './package.mjs';
import { cases as symbolAliasCases } from './symbol-alias-fixtures.mjs';

test('packaged SIMD header is identical at every installation boundary and retains full GCC notices', () => {
	const source = Buffer.from('/* SPDX-License-Identifier: GPL-3.0-or-later WITH GCC-exception-3.1 */\n' + 'independent header\n'.repeat(1000));
	const licenses = { COPYING3: Buffer.alloc(35147, 'g'), 'COPYING.RUNTIME': Buffer.alloc(3324, 'r') };
	const inputs = () => ({ source, installed: Buffer.from(source), browser: Buffer.from(source), packaged: Buffer.from(source),
		licenses, packagedLicenses: Object.fromEntries(Object.entries(licenses).map(([name, bytes]) => [name, Buffer.from(bytes)])) });
	verifySimdHeaderInstallation(inputs());
	for (const stage of ['installed', 'browser', 'packaged']) {
		const changed = inputs(); changed[stage][0] ^= 1;
		assert.throws(() => verifySimdHeaderInstallation(changed), /Changed .* SIMD header/);
		const missing = inputs(); delete missing[stage];
		assert.throws(() => verifySimdHeaderInstallation(missing), /Missing .* SIMD header/);
	}
	for (const name of ['COPYING3', 'COPYING.RUNTIME']) {
		const missing = inputs(); delete missing.packagedLicenses[name];
		assert.throws(() => verifySimdHeaderInstallation(missing), /Missing packaged/);
		const shortened = inputs(); shortened.packagedLicenses[name] = shortened.packagedLicenses[name].subarray(0, 100);
		assert.throws(() => verifySimdHeaderInstallation(shortened), /Changed packaged/);
	}
});

import { verifyWabtAssemblerReceipt } from './package.mjs';

test('assembler receipt requires the exact patched WABT source and build recipes', () => {
	const lock = { repository: 'https://example.invalid/wabt', commit: '1'.repeat(40), version: '1.0.37',
		patches: [{ path: 'patches/wabt.patch', sha256: '2'.repeat(64) }], sourceDiffSha256: '3'.repeat(64),
		submodules: { 'third_party/picosha2': '4'.repeat(40) } };
	const recipes = Object.fromEntries(['build-wabt.sh', 'prepare-source.py', 'sources.lock.json']
		.map(name => [name, identity(Buffer.from(name))]));
	const receipt = { component: 'wabt', role: 'wasm-object-assembler', host: 'wasm32-emscripten',
		repository: lock.repository, commit: lock.commit, version: lock.version, inputsUnchanged: true,
		assemblerArguments: ['-r', '--enable-annotations'], recipes,
		source: { wabtCommit: lock.commit, patches: lock.patches, sourceDiffSha256: lock.sourceDiffSha256, submodules: lock.submodules } };
	verifyWabtAssemblerReceipt(receipt, lock, recipes);
	for (const mutate of [
		proof => { delete proof.source; },
		proof => { proof.source.patches = []; },
		proof => { proof.source.sourceDiffSha256 = '0'.repeat(64); },
		proof => { proof.source.wabtCommit = '0'.repeat(40); },
		proof => { proof.source.submodules['third_party/picosha2'] = '0'.repeat(40); },
		proof => { proof.commit = '0'.repeat(40); },
		proof => { proof.repository = 'https://example.invalid/other'; },
		proof => { proof.host = 'native'; },
		proof => { proof.inputsUnchanged = false; },
		proof => { proof.assemblerArguments = []; },
		proof => { proof.recipes['prepare-source.py'].sha256 = '0'.repeat(64); },
		proof => { delete proof.recipes['sources.lock.json']; }
	]) {
		const changed = structuredClone(receipt); mutate(changed);
		assert.throws(() => verifyWabtAssemblerReceipt(changed, lock, recipes));
	}
});

test('saturating patch requires current saturation and existing SIMD/vector qualification', () => {
	const patches = [{ path: 'patches/0013-simd-saturating-arithmetic.patch' }];
	const options = Object.fromEntries(['simdQualification', 'simdExtendedQualification', 'vectorAbiQualification', 'simdSaturatingQualification', 'nativeLinker'].map(name => [name, `/qualified/${name}`]));
	verifySaturatingSimdQualificationOptions(patches, options);
	verifySaturatingSimdQualificationOptions([], {});
	for (const key of Object.keys(options)) assert.throws(() => verifySaturatingSimdQualificationOptions(patches, { ...options, [key]: undefined }), /Saturating SIMD requires/);
});

test('saturating proof binds every builtin/profile, exact opcodes and disabled/type diagnostics (synthetic receipts)', () => {
	const toolPaths = Object.fromEntries(Object.entries({ gcc: 'cc1', gccCpp: 'cc1plus', assembler: 'wat2wasm', objdump: 'wasm-objdump', linker: 'wasm-ld', node: 'node', validator: 'wasm-validate' }).map(([key, name]) => [key, `/qualified/${name}`]));
	const tools = Object.fromEntries(Object.keys(toolPaths).map(name => [name, identity(Buffer.from(`measured ${name}`))]));
	const expected = {
		gccCommit: 'a'.repeat(40), compilerSha256: tools.gcc.sha256, compilerCppSha256: tools.gccCpp.sha256,
		fixture: identity(Buffer.from('current fixture')), testRecipe: identity(Buffer.from('current recipe')),
		assembler: tools.assembler, objdump: tools.objdump, linker: tools.linker, validator: tools.validator, node: tools.node,
		runtime: { 'libc.a': identity(Buffer.from('current libc')) }, targetSource: { 'simd.md': identity(Buffer.from('current patterns')) },
		sourceLock: identity(Buffer.from('current source lock')), gccSource: { patches: [{ path: 'patches/0013-simd-saturating-arithmetic.patch' }] },
		headers: { gcc: { 'stddef.h': identity(Buffer.from('gcc header')) }, target: { 'stdio.h': identity(Buffer.from('target header')) } }
	};
	const argv = (fixture, profile) => [`-O${fixture.request.optimization}`, `-std=${fixture.request.standard}`, ...(profile === 'default' ? [] : [profile === 'disabled' ? '-mno-simd128' : '-msimd128'])];
	const report = {
		...structuredClone(expected), kind: 'gcc-wasi-native-simd-saturating-qualification', status: 'passed', inputsUnchanged: true,
		compiler: tools.gcc, compilerCpp: tools.gccCpp, toolPaths,
		inputs: Object.fromEntries(Object.entries(toolPaths).map(([name, file]) => [file, tools[name]])),
		cases: [...saturatingCases, ...saturatingDisabledCases].map(fixture => {
			const instructions = fixture.request.simd ? fixture.requiredInstructions : ['i32.add'];
			const dump = instructions.map(opcode => `001000: fd 6f | ${opcode}`).join('\n');
			return {
				id: fixture.id, status: 'passed', source: identity(Buffer.from(fixture.request.code)), stdin: fixture.stdin, stdout: fixture.stdout,
				wasm: identity(Buffer.from('fake program identity')), object: identity(Buffer.from('fake object identity')), assembly: identity(Buffer.from('fake assembly identity')), instructions,
				commands: [fixture.request.language === 'cpp' ? toolPaths.gccCpp : toolPaths.gcc, toolPaths.assembler, toolPaths.objdump, toolPaths.linker, toolPaths.node].map((command, index) => ({
					command, argv: index === 0 ? argv(fixture, fixture.request.simd ? 'enabled' : 'disabled') : index === 3 ? ['--fatal-warnings'] : [],
					status: 0, signal: null, stdout: index === 2 ? dump : index === 4 ? fixture.stdout : '', stderr: ''
				})), imports: [], exports: [{ name: 'memory', kind: 'memory' }, { name: '_start', kind: 'function' }],
				simdDisabledValidation: { command: toolPaths.validator, argv: ['--disable-simd', `/qualified/${fixture.id}/main.wasm`], status: fixture.request.simd ? 1 : 0, signal: null, stdout: '', stderr: '' }
			};
		}),
		diagnostics: [...saturatingCases.flatMap(fixture => ['disabled', 'default'].map(profile => ({ fixture, profile }))), ...saturatingDiagnosticCases.map(fixture => ({ fixture, profile: 'enabled-invalid' }))].map(({ fixture, profile }) => ({
			id: `${fixture.id}-${profile}`, fixture: fixture.id, profile, source: identity(Buffer.from(fixture.request.code)), emittedSimd: false,
			command: { command: fixture.request.language === 'cpp' ? toolPaths.gccCpp : toolPaths.gcc, argv: argv(fixture, profile), status: 1, signal: null, stdout: '',
				stderr: profile === 'enabled-invalid' ? fixture.diagnosticPattern.split('|')[0] : 'error: SIMD128 is disabled' }
		})),
		disabledDiagnostic: { status: 1, stderr: 'SIMD128 is disabled' }, defaultDiagnostic: { status: 1, stderr: 'SIMD128 is disabled' }
	};
	verifySaturatingSimdQualification(report, expected);
	for (const mutate of [
		proof => { proof.kind = 'gcc-wasi-native-simd-qualification'; },
		proof => { proof.cases.pop(); },
		proof => { proof.diagnostics.pop(); },
		proof => { proof.diagnostics[0] = structuredClone(proof.diagnostics[1]); },
		proof => { proof.inputsUnchanged = false; },
		proof => { proof.compiler.sha256 = '0'.repeat(64); },
		proof => { proof.compilerCpp.sha256 = '0'.repeat(64); },
		proof => { proof.targetSource = {}; },
		proof => { proof.gccSource.patches = []; },
		proof => { proof.fixture.sha256 = '0'.repeat(64); },
		proof => { proof.testRecipe.sha256 = '0'.repeat(64); },
		proof => { proof.headers.gcc = {}; },
		proof => { proof.objdump.sha256 = '0'.repeat(64); },
		proof => { proof.toolPaths.gcc = '/unmeasured/cc1'; },
		proof => { delete proof.cases[0].object; },
		proof => { proof.cases[0].stdin = '0\n'; },
		proof => { proof.cases[0].instructions = []; proof.cases[0].commands[2].stdout = ''; },
		proof => { proof.cases[0].instructions = ['i8x16.sub_sat_s']; proof.cases[0].commands[2].stdout = '001000: fd 6f | i8x16.sub_sat_s'; },
		proof => { proof.cases[0].simdDisabledValidation.status = 0; },
		proof => { proof.cases[0].commands[0].argv.push('-mno-simd128'); },
		proof => { proof.diagnostics[0].command.argv.push('-msimd128'); },
		proof => { proof.diagnostics[1].command.argv.push('-mno-simd128'); },
		proof => { proof.diagnostics[0].command.stderr = 'unrelated error'; },
		proof => { proof.diagnostics[0].command.status = 0; },
		proof => { proof.diagnostics[0].emittedSimd = true; },
		proof => { proof.diagnostics.at(-1).source.sha256 = '0'.repeat(64); }
	]) {
		const changed = structuredClone(report); mutate(changed);
		assert.throws(() => verifySaturatingSimdQualification(changed, expected));
	}
});

test('browser package rejects failed preparation and unsupported gcov host profiles', () => {
	const specs = identity(Buffer.from('*cc1plus:\n\n'));
	const receipt = {
		hostUtilityProfile: { name: 'browser-frontends', gcov: false, gcovDump: false, gcovTool: false },
		bootstrap: { allGccBootstrapExitCode: 0, gcovHostTools: 'disabled', profile: 'browser-frontends' },
		nativeDriverSpecs: specs
	};
	verifyBrowserHostProfile(receipt, specs);
	for (const modify of [
		value => { delete value.hostUtilityProfile; },
		value => { delete value.bootstrap; },
		value => { delete value.nativeDriverSpecs; },
		value => { value.nativeDriverSpecs.sha256 = '0'.repeat(64); },
		value => { value.bootstrap.allGccBootstrapExitCode = 2; },
		value => { value.hostUtilityProfile.gcovTool = true; }
	]) {
		const changed = structuredClone(receipt); modify(changed);
		assert.throws(() => verifyBrowserHostProfile(changed, specs));
	}
});

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

function int128ProofFixture(fixtures = int128Cases, kind = 'gcc-wasi-int128-qualification') {
	const { expected } = binary128ProofFixture();
	expected.targetSource = { 'wasm-cg.cc': identity(Buffer.from('TI target')) };
	expected.recipes = Object.fromEntries(['fixtures', 'harness', 'inspector'].map(name => [name, identity(Buffer.from(`int128 ${name}`))]));
	expected.runtime = Object.fromEntries(['crt1-command.o', 'libc.a', 'libm.a', 'builtins', 'gnuCpp', 'gnuAbi', 'clangCpp', 'clangAbi'].map(name => [name, identity(Buffer.from(name))]));
	if (fixtures.some(fixture => fixture.printscan))
		expected.runtime.printscan = identity(Buffer.from('printscan'));
	expected.headers.gcc = { 'stddef.h': identity(Buffer.from('GCC stddef')) };
	expected.headers.gnuCpp = { vector: identity(Buffer.from('GNU vector')) };
	const report = {
		...structuredClone(expected), kind, status: 'passed', inputsUnchanged: true,
		compilerHost: 'native', outputTarget: 'wasm32-wasi', selectedCases: fixtures.map(fixture => fixture.id),
		suiteSha256: identity(Buffer.from(JSON.stringify(fixtures))).sha256,
		directions: ['gcc-gcc', 'gcc-clang', 'clang-gcc', 'clang-clang']
	};
	for (const [key, name] of Object.entries({ gcc: 'cc1', gccCpp: 'cc1plus', clang: 'clang', assembler: 'wat2wasm', inspector: 'wasm-objdump', linker: 'wasm-ld', node: 'node' }))
		report.tools[key].path = `/verified/tools/${name}`;
	if (report.runtime.printscan)
		report.runtime.printscan.path = '/sysroot/lib/wasm32-wasi/libc-printscan-long-double.a';
	report.skippedReferences = fixtures.flatMap(fixture => report.directions
		.filter(direction => fixture.interop || direction === 'gcc-gcc' || direction === 'clang-clang')
		.filter(direction => fixture.clang === false && direction.includes('clang'))
		.map(direction => ({ fixture: fixture.id, direction, reason: fixture.clangReason })));
	report.cases = fixtures.flatMap(fixture => report.directions
		.filter(direction => fixture.interop || direction === 'gcc-gcc' || direction === 'clang-clang')
		.filter(direction => fixture.clang !== false || !direction.includes('clang'))
		.map(direction => {
			const families = direction.split('-');
			const sources = [fixture.request.code, ...(fixture.request.sources || []).map(name => fixture.request.files.find(file => file.path === name).contents)];
			const common = [`-O${fixture.request.optimization}`, `-std=${fixture.request.standard}`, fixture.request.simd ? '-msimd128' : '-mno-simd128', '-D__GCC_WASI_SINGLE_THREAD__=1', ...(fixture.request.defines || []).map(value => `-D${value}`)];
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
				return { compiler: family, source: identity(Buffer.from(source)),
					...(fixture.id.startsWith('anonymous-bitfield-') || fixture.objectSignatures ? { signatures: structuredClone(fixture.signatures) } : {}) };
			});
			commands.push({ command: report.tools.linker.path, argv: ['--fatal-warnings', ...(fixture.printscan ? [report.runtime.printscan.path] : []), '-lc'], status: 0, signal: null },
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
	return { fixtures, expected, report };
}

test('ABI correction patches require complete current native proofs and a real linker', () => {
	const empty = { path: 'patches/0010-empty-record-abi.patch' };
	const bitfield = { path: 'patches/0011-bitfield-layout.patch' };
	verifyAbiQualificationOptions([], {});
	const complete = { emptyAbiQualification: 'empty.json', bitfieldQualification: 'bitfield.json', nativeLinker: 'wasm-ld' };
	verifyAbiQualificationOptions([empty, bitfield], complete);
	assert.throws(() => verifyAbiQualificationOptions([empty], {}), /requires --empty-abi-qualification/);
	assert.throws(() => verifyAbiQualificationOptions([bitfield], {}), /requires --bitfield-qualification/);
	for (const field of Object.keys(complete)) {
		const changed = { ...complete }; delete changed[field];
		assert.throws(() => verifyAbiQualificationOptions([empty, bitfield], changed));
	}
});

test('anonymous bitfield patch requires its own native proof without replacing existing ABI proofs', () => {
	const patches = ['0010-empty-record-abi', '0011-bitfield-layout', '0012-anonymous-bitfield-abi']
		.map(name => ({ path: `patches/${name}.patch` }));
	const complete = { emptyAbiQualification: 'empty.json', bitfieldQualification: 'bitfield.json',
		anonymousBitfieldQualification: 'anonymous.json', nativeLinker: 'wasm-ld' };
	verifyAbiQualificationOptions(patches, complete);
	for (const field of Object.keys(complete)) {
		const changed = { ...complete }; delete changed[field];
		assert.throws(() => verifyAbiQualificationOptions(patches, changed));
	}
	assert.throws(() => verifyAbiQualificationOptions([patches[2]], {}), /requires --anonymous-bitfield-qualification/);
	assert.throws(() => verifyAbiQualificationOptions([], { anonymousBitfieldQualification: 'anonymous.json' }),
		/--anonymous-bitfield-qualification requires --native-linker/);
	verifyAbiQualificationOptions(patches.slice(0, 2), {
		emptyAbiQualification: 'empty.json', bitfieldQualification: 'bitfield.json', nativeLinker: 'wasm-ld'
	});
});

for (const [label, fixtures, kind, verify] of [
	['Empty ABI', emptyAbiCases, 'gcc-wasi-empty-record-abi-qualification', verifyEmptyAbiQualification],
	['Bitfield', bitfieldCases, 'gcc-wasi-wide-integer-qualification', verifyBitfieldQualification],
	['Anonymous bitfield', anonymousBitfieldCases, 'gcc-wasi-wide-integer-qualification', verifyAnonymousBitfieldQualification]
]) test(`${label} rejects partial, stale and forged ABI/source/command proof (synthetic receipts)`, () => {
	const { expected, report } = int128ProofFixture(fixtures, kind);
	verify(report, expected, fixtures);
	for (const mutate of [
		proof => { proof.cases.pop(); },
		proof => { proof.selectedCases.pop(); },
		proof => { proof.suiteSha256 = '0'.repeat(64); },
		proof => { proof.cases[0].fixtureSha256 = '0'.repeat(64); },
		proof => { proof.tools.gcc.sha256 = '0'.repeat(64); },
		proof => { proof.targetSource['wasm-cg.cc'].sha256 = '0'.repeat(64); },
		proof => { proof.cases[0].units[0].source.sha256 = '0'.repeat(64); },
		proof => { proof.cases[0].commands[0].argv = proof.cases[0].commands[0].argv.filter(arg => !arg.startsWith('-D')); },
		proof => { proof.cases[0].commands[0].command = '/unverified/cc1'; },
		proof => { proof.cases[0].abi.memories[0].shared = true; },
		proof => { proof.cases[0].abi.exports._start.params = ['i32']; },
		proof => { proof.cases[0].stdout = 'unverified output'; }
	]) {
		const changed = structuredClone(report); mutate(changed);
		assert.throws(() => verify(changed, expected, fixtures));
	}
});

test('anonymous bitfield proof binds every optimization, compiler direction and object/program signature (synthetic receipts)', () => {
	const { expected, report } = int128ProofFixture(anonymousBitfieldCases, 'gcc-wasi-wide-integer-qualification');
	assert.equal(report.counts.total, anonymousBitfieldCases.length * 4);
	verifyAnonymousBitfieldQualification(report, expected, anonymousBitfieldCases);
	assert.throws(() => verifyAnonymousBitfieldQualification(undefined, expected, anonymousBitfieldCases), /requires native qualification proof/);
	for (const partialFixtures of [bitfieldCases, anonymousBitfieldCases.filter(fixture => fixture.request.optimization === '0')]) {
		const partial = int128ProofFixture(partialFixtures, 'gcc-wasi-wide-integer-qualification').report;
		assert.throws(() => verifyAnonymousBitfieldQualification(partial, expected, anonymousBitfieldCases), /fixture matrix changed/);
	}
	for (const mutate of [
		proof => { proof.cases[1] = structuredClone(proof.cases[0]); },
		proof => { proof.skippedReferences = [{ fixture: anonymousBitfieldCases[0].id, direction: 'clang-gcc' }]; },
		proof => { proof.directions = ['gcc-gcc']; proof.cases = proof.cases.filter(entry => entry.direction === 'gcc-gcc'); proof.counts = { total: proof.cases.length, passed: proof.cases.length, failed: 0 }; },
		proof => { delete proof.cases[0].units[0].signatures; },
		proof => { proof.cases[0].units[0].signatures.ab_make = { params: ['i32', 'i32'], results: [] }; },
		proof => { proof.cases[0].units[1].signatures.ab_make = { params: ['i32', 'i32'], results: [] }; },
		proof => { proof.cases[0].abi.exports.ab_make = { params: ['i32', 'i32'], results: [] }; },
		proof => { proof.cases[0].commands.at(-2).argv = ['-lc']; }
	]) {
		const changed = structuredClone(report); mutate(changed);
		assert.throws(() => verifyAnonymousBitfieldQualification(changed, expected, anonymousBitfieldCases));
	}
});

test('strong alias programs require all original sources and compiler directions (synthetic receipts)', () => {
	const { expected, report } = int128ProofFixture(symbolAliasCases, 'gcc-wasi-wide-integer-qualification');
	verifySymbolAliasPrograms(report, expected, symbolAliasCases);
	for (const mutate of [
		proof => { proof.counts.total = 104; },
		proof => { proof.suiteSha256 = '0'.repeat(64); },
		proof => { proof.cases[0].units[1].source.sha256 = '0'.repeat(64); },
		proof => { proof.cases[0].commands.at(-2).argv = ['-lc']; },
		proof => { proof.cases[0].commands.at(-1).stdout = '0\n'; },
		proof => { proof.skippedReferences = []; }
	]) {
		const changed = structuredClone(report); mutate(changed);
		assert.throws(() => verifySymbolAliasPrograms(changed, expected, symbolAliasCases));
	}
});

test('GNU float128 requires separate proof, a linker and the freshly qualified GNU runtime', () => {
	const patch = { path: 'patches/0014-gnu-float128.patch' };
	const options = { gnuFloat128Qualification: 'GNU-TF.json', nativeLinker: 'wasm-ld', libstdcxx: 'GNU' };
	verifyWideScalarQualificationOptions([patch], options);
	for (const key of Object.keys(options)) {
		const changed = { ...options }; delete changed[key];
		assert.throws(() => verifyWideScalarQualificationOptions([patch], changed));
	}
	assert.throws(() => verifyWideScalarQualificationOptions([patch], {
		longDoubleQualification: 'TF.json', int128Qualification: 'TI.json', nativeLinker: 'wasm-ld', libstdcxx: 'GNU'
	}), /requires --gnu-float128-qualification/);
});

test('GNU float128 proof binds all language, ABI, GNU header and declared Clang-reference boundaries (synthetic receipts)', () => {
	const { expected, report } = int128ProofFixture(gnuFloat128Cases, 'gcc-wasi-wide-integer-qualification');
	assert.equal(report.counts.total, 78);
	assert.equal(report.skippedReferences.length, 6);
	verifyGnuFloat128Qualification(report, expected, gnuFloat128Cases);
	for (const mutate of [
		proof => { proof.cases.pop(); },
		proof => { proof.cases[1] = structuredClone(proof.cases[0]); },
		proof => { proof.skippedReferences.pop(); },
		proof => { proof.skippedReferences.push({ fixture: gnuFloat128Cases[0].id, direction: 'clang-clang', reason: 'not tested' }); },
		proof => { proof.directions = ['gcc-gcc']; },
		proof => { proof.suiteSha256 = '0'.repeat(64); },
		proof => { proof.headers.gnuCpp.vector = identity(Buffer.from('stale GNU headers')); },
		proof => { proof.cases.find(entry => entry.fixture.includes('cpp-overloads')).units[1].signatures._Z11gf_overloadg.params = ['f64']; },
		proof => { proof.cases.find(entry => entry.fixture.includes('direct-callback')).units[0].signatures.gq_add.params.pop(); },
		proof => { proof.cases.find(entry => entry.fixture.includes('library-bridge')).commands.at(-2).argv = ['--fatal-warnings', '-lc']; },
		proof => { proof.cases.find(entry => entry.fixture.includes('gnu-cpp-library')).commands[0].command = '/unqualified/cc1plus'; },
		proof => { proof.cases.find(entry => entry.fixture.includes('c-type-relations')).stdout = '1 0 1\n'; }
	]) {
		const changed = structuredClone(report); mutate(changed);
		assert.throws(() => verifyGnuFloat128Qualification(changed, expected, gnuFloat128Cases));
	}
});

test('typed GNU math detection rejects missing functions, stale tools and invalid link probes (synthetic receipts)', () => {
	const expected = Object.fromEntries(['recipe', 'compiler', 'assembler', 'linker'].map(name => [name, identity(Buffer.from(name))]));
	const functions = [...typedMathProbeContract.functions];
	const headers = { gcc: { 'stddef.h': identity(Buffer.from('GCC header')) }, target: {}, sdk: {} };
	const report = {
		kind: 'gcc-wasi-typed-math-link-probes', status: 'passed', inputsUnchanged: true, target: 'wasm32-wasi', missingRequired: [],
		functions, stdlibFunctions: ['at_quick_exit', 'quick_exit', 'strtof', 'strtold'], requiredToAvoidMathStubs: [...typedMathProbeContract.required],
		headers,
		inputs: Object.fromEntries(Object.entries(expected).map(([name, value]) => [name, { ...value, path: `/verified/${name}` }])),
		cases: functions.map(name => ({ function: name, required: typedMathProbeContract.required.includes(name), available: true,
			commands: ['compiler', 'assembler', 'linker'].map(tool => ({ argv: [`/verified/${tool}`, ...(tool === 'linker' ? ['--fatal-warnings'] : [])], exitCode: 0, stderr: '' })) })),
		counts: { total: 67, available: 67, unavailable: 0 }
	};
	verifyTypedMathProbes(report, expected, headers);
	for (const mutate of [
		proof => { proof.functions.pop(); },
		proof => { proof.functions[1] = 'unrelated_function'; proof.cases[1].function = 'unrelated_function'; },
		proof => { proof.requiredToAvoidMathStubs = proof.requiredToAvoidMathStubs.filter(name => name !== 'acosl'); proof.cases.find(test => test.function === 'acosl').required = false; },
		proof => { proof.headers.gcc['stddef.h'].sha256 = '0'.repeat(64); },
		proof => { proof.cases.pop(); },
		proof => { proof.missingRequired.push('sqrtl'); },
		proof => { proof.cases[0].available = false; },
		proof => { proof.inputs.compiler.sha256 = '0'.repeat(64); },
		proof => { proof.cases[0].commands[0].argv[0] = '/unverified/clang'; },
		proof => { proof.cases[0].commands[2].argv.pop(); },
		proof => { proof.cases[0].commands[2].exitCode = 1; },
		proof => { proof.cases[0].commands[0].stderr = 'internal compiler error'; },
		proof => { proof.inputsUnchanged = false; }
	]) {
		const changed = structuredClone(report); mutate(changed);
		assert.throws(() => verifyTypedMathProbes(changed, expected, headers));
	}
});

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
