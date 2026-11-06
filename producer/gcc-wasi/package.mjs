#!/usr/bin/env node
// Package only source-pinned, receipt-verified compiler/runtime build outputs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { identity, readNativeTree, relativePath } from '../clang-browser/cross/package.mjs';
import { deterministicTar } from '../clang-browser/scripts/package-language-sysroots.mjs';
import { cases as simdCases, disabledCases } from './simd-fixtures.mjs';
import { cases as saturatingCases, disabledCases as saturatingDisabledCases, diagnosticCases as saturatingDiagnosticCases } from './simd-saturating-fixtures.mjs';
import { cases as conversionCases, disabledCases as conversionDisabledCases, diagnosticCases as conversionDiagnosticCases } from './simd-conversions-fixtures.mjs';
import { cases as headerCases, disabledCases as headerDisabledCases, diagnosticCases as headerDiagnosticCases } from './simd-header-fixtures.mjs';
import { verifySimdHeaderQualificationOptions, reopenSimdHeaderQualification, verifySimdHeaderInstallation } from './simd-header-qualification.mjs';
import { cases as relaxedCases, disabledCases as relaxedDisabledCases, diagnosticCases as relaxedDiagnosticCases } from './simd-relaxed-fixtures.mjs';
import { verifyRelaxedSimdQualificationOptions, reopenRelaxedSimdQualification, verifyRelaxedSimdHeaderInstallation } from './simd-relaxed-qualification.mjs';
import { verifyRelaxedSimdDriverQualificationOptions, reopenRelaxedSimdDriverQualification } from './simd-relaxed-driver-qualification.mjs';
import { conversionInstructions, verifyConversionInstructions } from './simd-conversions-inspect.mjs';
import { inspectVectorAbi, inspectObjectFunctionSignatures } from './inspect-vector-abi.mjs';
import { verifySymbolAliasQualificationOptions, reopenSymbolAliasQualification } from './symbol-alias-qualification.mjs';
import { verifyWeakrefQualificationOptions, reopenWeakrefQualification } from './weakref-qualification.mjs';
import { verifyRttiQualificationOptions, verifyRttiRuntimeProfile, reopenRttiQualification } from './rtti-qualification.mjs';
import { verifyCoverageQualificationOptions, reopenLibgcovBuild, reopenCoverageQualification } from './coverage-qualification.mjs';
import { wasiRunnerSource as coverageRunnerSource } from './coverage-fixtures.mjs';
import { verifyDwarfQualificationOptions, reopenDwarfQualification } from './dwarf-qualification.mjs';
import { reopenLibatomicBuild } from './libatomic-qualification.mjs';
import { reopenLibatomicExecutionQualification } from './libatomic-execution-qualification.mjs';
import { reopenNativeAtomicsQualification } from './atomics-qualification.mjs';
import { reopenNativeTlsQualification } from './tls-native-qualification.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const readJson = async (name) => JSON.parse(await fs.readFile(name, 'utf8'));
const inventory = (files) => files.map((f) => ({ path: f.path, ...identity(f.bytes) }));
const inside = (root, name) => {
	const rel = path.relative(root, name);
	return !rel || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

export async function writeProvenanceFiles(directory, files) {
	const entries = [...files].map(([name, bytes]) => [relativePath(name), bytes]);
	for (const [name, bytes] of entries) {
		const destination = path.join(directory, name);
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.writeFile(destination, bytes, { flag: 'wx' });
	}
}

export function verifyInventory(files, expected, label) {
	const entries = Array.isArray(expected) ? expected : Object.entries(expected).map(([name, value]) => ({ path: name, ...value }));
	const canonical = entries.map((f) => ({ path: relativePath(f.path), bytes: f.bytes ?? f.size, sha256: f.sha256 }));
	assert.equal(new Set(canonical.map((f) => f.path)).size, canonical.length, `${label}: duplicate receipt path`);
	const ordered = (items) => [...items].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	assert.deepEqual(ordered(inventory(files)), ordered(canonical), `${label}: files differ from the build receipt`);
}

export function verifyWabtAssemblerReceipt(receipt, lock, recipes) {
	assert.equal(receipt.component, 'wabt');
	assert.equal(receipt.role, 'wasm-object-assembler');
	assert.equal(receipt.host, 'wasm32-emscripten');
	assert.equal(receipt.repository, lock.repository);
	assert.equal(receipt.commit, lock.commit);
	assert.equal(receipt.version, lock.version);
	assert.equal(receipt.inputsUnchanged, true, 'WABT inputs changed during the build');
	assert.deepEqual(receipt.assemblerArguments, ['-r', '--enable-annotations']);
	assert.deepEqual(receipt.source, {
		wabtCommit: lock.commit, patches: lock.patches || [],
		sourceDiffSha256: lock.sourceDiffSha256, submodules: lock.submodules || {}
	}, 'WABT assembler source differs from the locked patched source');
	assert.deepEqual(receipt.recipes, recipes, 'WABT assembler build recipes changed');
}

export function verifyRuntimeLibraryIdentities(files, locked = {}) {
	for (const [name, expected] of Object.entries(locked)) {
		assert(/^[a-zA-Z0-9_+-][a-zA-Z0-9_.+-]*\.a$/.test(name), `Invalid locked runtime library: ${name}`);
		const file = files.find(file => file.path === `lib/wasm32-wasi/${name}`);
		assert(file, `Locked runtime library missing: ${name}`);
		assert.deepEqual(identity(file.bytes), expected, `Runtime library differs from its lock: ${name}`);
	}
}

export function verifyLibatomicPackageOptions(patches, options) {
	const required = patches.some(patch => patch.path === 'patches/0024-libatomic-wasm.patch');
	if (!required && !options.libatomic && !options.libatomicQualification) return;
	for (const field of ['libatomic', 'libatomicQualification', 'nativeLinker'])
		assert(options[field], `GNU libatomic requires ${field}`);
	assert(required, 'GNU libatomic requires the locked Wasm runtime port');
}

export function verifyAtomicsPackageOptions(patches, options) {
	const required = patches.some(patch => patch.path === 'patches/0023-atomics.patch');
	if (!required && !options.atomicsQualification) return;
	assert(required, 'Atomics require the locked native backend');
	for (const field of ['atomicsQualification', 'libatomic', 'libatomicQualification', 'nativeLinker'])
		assert(options[field], `Atomics require ${field}`);
	verifyLibatomicPackageOptions(patches, options);
}

export function qualifiedAtomicsManifestProfile(native, runtime) {
	if (!native && !runtime) return { capabilities: {}, runtimeLibraries: [], limitations: [] };
	assert.equal(native?.status, 'passed', 'Atomics require reopened native compiler evidence');
	assert.equal(runtime?.build?.status, 'built-unverified', 'Atomics require the measured GNU runtime build');
	assert.equal(runtime?.execution?.status, 'passed', 'Atomics require reopened GNU runtime execution evidence');
	assert.deepEqual(native.gccSource, runtime.build.gccSource, 'Atomics compiler and runtime sources differ');
	assert.deepEqual(native.gccSource, runtime.execution.gccSource, 'Atomics compiler and runtime execution sources differ');
	const content = value => ({ bytes: value.bytes, sha256: value.sha256 });
	assert.deepEqual(content(native.nativeBuild), content(runtime.build.nativeBuild), 'Atomics compiler and runtime builds differ');
	assert.deepEqual(content(runtime.build.archive), content(runtime.execution.archive), 'Atomics runtime execution uses another archive');
	assert.equal(runtime.runtimeLibrary, '/sysroot/lib/wasm32-wasi/libatomic.a');
	return {
		capabilities: { atomics: true, sharedMemory: true },
		runtimeLibraries: [runtime.runtimeLibrary],
		limitations: [
			'Atomics require explicit opt-in. Naturally aligned 1/2/4/8-byte operations use native Wasm atomics; generic and 16-byte operations use GNU libatomic, with 16-byte operations not lock-free. Accepted memory orders are conservatively strengthened to sequential consistency.',
			'The atomics compiler profile disables IPA-reference analysis to preserve synchronized plain-memory accesses. This restriction also applies to function-specific optimization attributes and pragmas.',
			'The basic shared-atomics profile requires cross-origin isolation and the SDK shared-entry runner, fixed shared memory and private Worker stacks. It admits freestanding C/C++ entries without dynamic constructors, TLS, external objects or WASI imports; TLS uses its separate explicit profile. pthreads and std::thread are unavailable.'
		]
	};
}

export const tlsRuntimeHeaderPath = 'include/wasm32-wasi-tls/__errno.h';
export const tlsRuntimePaths = Object.freeze([
	'lib/wasm32-wasi-tls/libgcc-wasi-tls.a',
	'lib/wasm32-wasi-tls/libc.a',
	'lib/wasm32-wasi-tls/libc-printscan-long-double.a',
	'lib/wasm32-wasi-tls/libm.a',
	'lib/wasm32-wasi-tls/libclang_rt.builtins-wasm32.a',
	'lib/wasm32-wasi-threads/libgcc-wasi-tls-shared.a',
	'lib/wasm32-wasi-threads/libc.a',
	'lib/wasm32-wasi-threads/libm.a',
	'lib/wasm32-wasi-threads/libclang_rt.builtins-wasm32.a',
	tlsRuntimeHeaderPath
]);

export function verifyTlsPackageOptions(patches, options) {
	const backend = patches.some(patch => patch.path === 'patches/0025-tls.patch');
	const runtime = patches.some(patch => patch.path === 'patches/0026-wasm-tls-runtime.patch');
	if (!backend && !runtime && !options.tlsRuntime && !options.tlsLibc && !options.tlsQualification && !options.tlsRuntimeQualification) return;
	assert(backend && runtime, 'TLS requires the locked backend and GNU runtime port');
	for (const name of ['tlsRuntime', 'tlsLibc', 'tlsQualification', 'tlsRuntimeQualification', 'libstdcxx', 'nativeLinker'])
		assert(options[name], `TLS requires ${name}`);
}

export function qualifiedTlsManifestProfile(native, runtime) {
	if (!native && !runtime) return { capabilities: {}, limitations: [] };
	assert.equal(native?.status, 'passed', 'TLS requires reopened native compiler evidence');
	assert.equal(runtime?.build?.status, 'built-unverified', 'TLS requires the measured GNU runtime build');
	assert.equal(runtime?.execution?.status, 'passed', 'TLS requires reopened runtime execution evidence');
	assert.deepEqual(native.gccSource, runtime.build.gccSource, 'TLS compiler and runtime sources differ');
	assert.deepEqual(native.gccSource, runtime.execution.gccSource, 'TLS compiler and runtime execution sources differ');
	const content = value => ({ bytes: value.bytes, sha256: value.sha256 });
	assert.deepEqual(content(native.nativeBuild), content(runtime.build.nativeBuild), 'TLS runtime uses another native compiler build');
	assert.deepEqual(content(native.nativeBuild), content(runtime.execution.nativeBuild), 'TLS execution uses another native compiler build');
	assert.deepEqual(content(runtime.build.build), content(runtime.execution.runtimeBuild), 'TLS execution uses another runtime build');
	return { capabilities: { tls: true }, limitations: [
		'TLS requires explicit opt-in and static local-exec linking. C _Thread_local and C++ thread_local use real TLS object metadata, initialization and GNU destructor registration. TLS with embedded debugging is unavailable.',
		'Shared TLS requires fixed shared memory and an explicit linker reservation for Worker stacks, TLS blocks and guards. The SDK uses the actual WASI threads allocator and sched_yield, and runs TLS destructors after normal entry return. Trap, cancellation and timeout discard the cohort without guaranteeing destructor execution.',
		'Ordinary TLS uses private memory, an isolated TLS errno declaration and the pinned single-thread WASI libc rebuilt with real TLS preserved. Qualified normal-return/exit wrappers destroy TLS before process atexit callbacks and static objects. Linked runtime atomic instructions require engine support independently of the user atomic-lowering flag. This profile does not provide pthreads or std::thread.'
	] };
}

export function verifyTlsInstallation(sysroot, files, licenses, validated) {
	qualifiedTlsManifestProfile(validated.native, validated);
	assert.deepEqual(files.map(file => relativePath(file.path)).sort(), [...tlsRuntimePaths].sort(), 'TLS runtime must contain exactly its nine qualified archives and isolated errno header');
	verifyInventory(files, validated.build.files, 'TLS runtime build');
	verifyInventory(files, validated.execution.files, 'Executed TLS runtime');
	for (const file of files) {
		assert(!sysroot.some(existing => existing.path === file.path), `Duplicate TLS sysroot path: ${file.path}`);
		if (file.path === tlsRuntimeHeaderPath)
			assert(file.bytes.length > 0 && !file.bytes.includes(0), 'TLS errno header must contain source text');
		else
			assert.equal(file.bytes.subarray(0, 8).toString(), '!<arch>\n', 'TLS runtime must contain actual static archives');
	}
	verifyInventory(licenses, validated.build.licenses, 'TLS runtime full licenses');
	assert(licenses.length > 0, 'TLS runtime licenses are missing');
}

export const exceptionRuntimePaths = Object.freeze([
	'lib/wasm32-wasi-eh/libstdc++.a',
	'lib/wasm32-wasi-eh/libsupc++.a',
	'lib/wasm32-wasi-eh/libunwind.a'
]);

export function verifyExceptionPackageOptions(patches, options) {
	const backend = patches.some(patch => patch.path === 'patches/0027-exception-handling.patch');
	const runtime = patches.some(patch => patch.path === 'patches/0028-wasm-eh-runtime.patch');
	if (!backend && !runtime && !options.ehRuntime && !options.ehQualification && !options.ehRuntimeQualification) return;
	assert(backend && runtime, 'Exceptions require the locked backend and GNU runtime port');
	for (const name of ['ehRuntime', 'ehQualification', 'ehRuntimeQualification', 'libstdcxx', 'nativeLinker'])
		assert(options[name], `Exceptions require ${name}`);
}

export function qualifiedExceptionManifestProfile(native, runtime) {
	if (!native && !runtime) return { capabilities: {}, limitations: [] };
	assert.equal(native?.status, 'passed', 'Exceptions require reopened native GCC evidence');
	assert.equal(runtime?.build?.status, 'built-unverified', 'Exceptions require a measured full GNU runtime build');
	assert.equal(runtime?.execution?.status, 'passed', 'Exceptions require reopened GNU runtime execution');
	assert.equal(runtime.build.profile, 'ordinary-private-modern', 'Unqualified exception runtime profile');
	assert.equal(runtime.execution.profile, 'ordinary-private-modern', 'Unqualified executed exception profile');
	assert.equal(runtime.build.fullGnuLibrary, true, 'An exception bootstrap cannot qualify the full GNU runtime');
	assert.equal(runtime.execution.fullGnuLibrary, true, 'The full GNU runtime must be executed');
	assert.equal(runtime.build.defaultHeadersIdentical, true, 'Exception and ordinary GNU headers must match');
	assert.deepEqual(native.gccSource, runtime.build.gccSource, 'Exceptions compiler and runtime sources differ');
	assert.deepEqual(native.gccSource, runtime.execution.gccSource, 'Exceptions execution uses another source');
	const content = value => ({ bytes: value.bytes, sha256: value.sha256 });
	assert.deepEqual(content(native.nativeBuild), content(runtime.build.nativeBuild), 'Exceptions runtime uses another native build');
	assert.deepEqual(content(native.nativeBuild), content(runtime.execution.nativeBuild), 'Exceptions execution uses another native build');
	assert.deepEqual(content(runtime.build.build), content(runtime.execution.runtimeBuild), 'Exceptions execution uses another runtime build');
	assert.deepEqual(content(native.nativeFixtures), content(runtime.execution.nativeFixtures), 'Exceptions backend and runtime fixtures differ');
	assert(Array.isArray(native.nativeCaseIds) && native.nativeCaseIds.length > 0, 'Missing exception backend cases');
	assert.deepEqual(native.nativeCaseIds, runtime.execution.nativeCaseIds, 'Exceptions runtime omitted backend cases');
	assert.deepEqual(runtime.build.linkFlags, ['--wrap=__main_void', '--wrap=__wasm_call_ctors', '--wrap=__wasm_call_dtors', '--wrap=exit'],
		'Exceptions require the qualified GNU entry/constructor/destructor boundaries');
	return { capabilities: { exceptions: true }, limitations: [
		'C++ exceptions require explicit opt-in, private memory, the modern Wasm exception instructions and the separate exception-enabled GNU libstdc++/libsupc++ with the pinned native Wasm unwinder. Ordinary non-exception providers remain separate.',
		'Exceptions with explicit TLS, shared memory, atomics, SIMD, coverage or embedded debugging require separate qualification and are unavailable in this profile. General mixed-toolchain C++ exceptions and arbitrary host exception interoperability are not qualified.'
	] };
}

export function verifyExceptionInstallation(sysroot, files, licenses, validated, runtimeLock) {
	qualifiedExceptionManifestProfile(validated.native, validated);
	assert.deepEqual(files.map(file => relativePath(file.path)).sort(), [...exceptionRuntimePaths].sort(),
		'Exception runtime must contain exactly its three qualified archives');
	verifyInventory(files, validated.build.files, 'Exception runtime build');
	verifyInventory(files, validated.execution.files, 'Executed exception runtime');
	for (const file of files) {
		assert(!sysroot.some(existing => existing.path === file.path), `Duplicate exception sysroot path: ${file.path}`);
		assert.equal(file.bytes.subarray(0, 8).toString(), '!<arch>\n', 'Exception runtime must contain actual static archives');
	}
	verifyInventory(licenses, validated.build.licenses, 'Exception runtime full licenses');
	assert(licenses.length > 0, 'Exception runtime licenses are missing');
	const pin = runtimeLock?.exceptionHandling;
	assert.equal(pin?.profile, 'ordinary-private-modern', 'Exception runtime pin is missing');
	const content = value => ({ bytes: value.bytes, sha256: value.sha256 });
	assert.deepEqual(identity(files.find(file => file.path.endsWith('/libunwind.a')).bytes), content(pin.unwinder),
		'Exception unwinder differs from the pinned native Wasm archive');
	assert(licenses.some(file => {
		const actual = identity(file.bytes);
		return actual.bytes === pin.license.bytes && actual.sha256 === pin.license.sha256;
	}), 'Full pinned native Wasm unwinder license is missing');
}

export function verifyLibatomicInstallation(sysroot, files, licenses, validated) {
	const content = value => ({ bytes: value.bytes, sha256: value.sha256 });
	assert.equal(validated.build.status, 'built-unverified');
	assert.equal(validated.execution.status, 'passed');
	assert.deepEqual(content(validated.build.archive), content(validated.execution.archive));
	verifyInventory(files, [{ path: 'lib/wasm32-wasi/libatomic.a', ...content(validated.build.archive) }], 'GNU libatomic runtime');
	for (const file of files) assert(!sysroot.some(existing => existing.path === file.path), `Duplicate runtime sysroot path: ${file.path}`);
	assert.equal(files[0].bytes.subarray(0, 8).toString(), '!<arch>\n', 'GNU libatomic must be an actual static archive');
	assert.deepEqual(Object.keys(validated.build.licenses).sort(), ['COPYING.RUNTIME', 'COPYING3']);
	verifyInventory(licenses, Object.entries(validated.build.licenses).map(([name, record]) => ({ path: name, ...content(record) })), 'GNU libatomic full licenses');
}

export function checkWasm(bytes, label, executable = false) {
	assert(bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])), `${label}: expected WebAssembly`);
	// Relocatable objects can have placeholders that do not validate until linked.
	if (!executable) return;
	assert(WebAssembly.validate(bytes), `${label}: invalid executable Wasm`);
	const module = new WebAssembly.Module(bytes);
	const exports = WebAssembly.Module.exports(module);
	// Emscripten minifies its internal export names; its generated JS maps them.
	assert(exports.some((e) => e.kind === 'memory'), `${label}: no exported memory`);
}

export function verifySimdQualification(report, expected) {
	assert.equal(report.kind, expected.kind || 'gcc-wasi-native-simd-qualification');
	assert.equal(report.status, 'passed', 'SIMD qualification did not pass');
	assert.equal(report.gccCommit, expected.gccCommit);
	assert.equal(report.compiler?.sha256, expected.compilerSha256, 'SIMD qualification covers another GCC binary');
	assert.deepEqual(report.fixture, expected.fixture, 'SIMD fixture changed after qualification');
	assert.deepEqual(report.testRecipe, expected.testRecipe, 'SIMD test recipe changed after qualification');
	assert.deepEqual(report.assembler, expected.assembler, 'SIMD assembler changed after qualification');
	assert.deepEqual(report.linker, expected.linker, 'SIMD linker changed after qualification');
	assert.deepEqual(report.runtime, expected.runtime, 'SIMD runtime differs from the packaged runtime');
	assert.deepEqual(report.targetSource, expected.targetSource, 'SIMD backend sources differ');
	const fixtures = expected.fixtures || [...simdCases, ...disabledCases];
	if (fixtures.some(fixture => fixture.request.language === 'cpp'))
		assert.equal(report.compilerCpp?.sha256, expected.compilerCppSha256, 'SIMD qualification covers another C++ compiler');
	assert.deepEqual(report.cases.map((test) => test.id).sort(), fixtures.map((test) => test.id).sort(), 'SIMD qualification is incomplete');
	for (const test of report.cases) {
		const fixture = fixtures.find((f) => f.id === test.id);
		assert.equal(test.status, 'passed', `SIMD fixture failed: ${test.id}`);
		assert.deepEqual(test.source, identity(Buffer.from(fixture.request.code)), 'SIMD source differs from its fixture');
		assert.equal(test.stdout, fixture.stdout, 'SIMD execution output differs from the fixture');
		assert(Number.isSafeInteger(test.wasm?.bytes) && test.wasm.bytes > 8 && /^[a-f0-9]{64}$/.test(test.wasm.sha256), 'Missing SIMD program identity');
		assert.equal(test.commands?.length, 5, 'Missing SIMD compile/assemble/disassemble/link/execute evidence');
		for (const command of test.commands) {
			assert.equal(command.status, 0, 'SIMD command failed');
			assert.equal(command.signal, null, 'SIMD command was interrupted');
			assert(!command.error, 'SIMD command did not execute');
		}
		assert.deepEqual(test.commands.map((command) => path.basename(command.command)), [fixture.request.language === 'cpp' ? 'cc1plus' : 'cc1', 'wat2wasm', 'wasm-objdump', 'wasm-ld', 'node']);
		assert(test.commands[3].argv.includes('--fatal-warnings'), 'SIMD linking must reject signature warnings');
		const argv = test.commands[0].argv;
		assert.deepEqual(argv.filter(arg => /^-O/.test(arg)), [`-O${fixture.request.optimization}`], 'SIMD optimization differs from fixture');
		assert.deepEqual(argv.filter(arg => arg.startsWith('-std=')), [`-std=${fixture.request.standard}`], 'SIMD language standard differs from fixture');
		assert.deepEqual(argv.filter(arg => /^-m(?:no-)?simd128$/.test(arg)), [fixture.request.simd ? '-msimd128' : '-mno-simd128'], 'SIMD profile differs from fixture');
		assert.equal(test.commands[4].stdout, fixture.stdout);
		assert.equal(test.commands[4].stderr, '');
		assert(Array.isArray(test.imports) && test.imports.every((entry) => entry.module === 'wasi_snapshot_preview1' && entry.kind === 'function'));
		assert(test.exports?.some((entry) => entry.name === 'memory' && entry.kind === 'memory'));
		assert(test.exports.some((entry) => entry.name === '_start' && entry.kind === 'function'));
	}
	for (const field of ['disabledDiagnostic', 'defaultDiagnostic']) {
		assert.equal(report[field]?.status, 1, 'SIMD disabled-profile diagnostic was not verified');
		assert.match(report[field].stderr, /SIMD128 is disabled/);
	}
}

export function verifySaturatingSimdQualificationOptions(patches, options) {
	if (!patches.some(patch => patch.path === 'patches/0013-simd-saturating-arithmetic.patch')) return;
	for (const field of ['simdQualification', 'simdExtendedQualification', 'vectorAbiQualification', 'simdSaturatingQualification', 'nativeLinker'])
		assert(options[field], `Saturating SIMD requires ${field} with the current compiler`);
}

export function verifySaturatingSimdQualification(report, expected) {
	const fixtures = [...saturatingCases, ...saturatingDisabledCases];
	verifySimdQualification(report, { ...expected, kind: 'gcc-wasi-native-simd-saturating-qualification', fixtures });
	assert.equal(report.inputsUnchanged, true, 'Saturating SIMD inputs changed');
	for (const field of ['sourceLock', 'gccSource', 'headers', 'objdump', 'validator', 'node'])
		assert.deepEqual(report[field], expected[field], `Saturating SIMD ${field} differs`);
	const tools = { gcc: report.compiler, gccCpp: report.compilerCpp, assembler: report.assembler,
		objdump: report.objdump, linker: report.linker, validator: report.validator, node: report.node };
	assert.deepEqual(Object.keys(report.toolPaths).sort(), Object.keys(tools).sort());
	for (const [name, receipt] of Object.entries(tools)) {
		assert(path.isAbsolute(report.toolPaths[name]), `Missing absolute ${name} path`);
		assert.deepEqual(report.inputs[report.toolPaths[name]], receipt, `Saturating SIMD ${name} command is not bound to its measured tool`);
	}
	const binaryIdentity = (receipt, label) => {
		assert(Number.isSafeInteger(receipt?.bytes) && receipt.bytes > 8 && /^[a-f0-9]{64}$/.test(receipt.sha256), `Missing ${label} identity`);
	};
	const simd = /\b(?:v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\./u;
	for (const entry of report.cases) {
		const fixture = fixtures.find(candidate => candidate.id === entry.id);
		assert.equal(entry.stdin, fixture.stdin, 'Saturating SIMD stdin differs from the oracle');
		binaryIdentity(entry.assembly, 'saturating assembly'); binaryIdentity(entry.object, 'saturating object');
		assert.deepEqual(entry.commands.map(command => command.command),
			[fixture.request.language === 'cpp' ? report.toolPaths.gccCpp : report.toolPaths.gcc,
				report.toolPaths.assembler, report.toolPaths.objdump, report.toolPaths.linker, report.toolPaths.node]);
		const decoded = entry.commands[2].stdout.split('\n').flatMap(line => {
			const match = /^\s*[a-f0-9]+:\s+(?:[a-f0-9]{2}\s+)+\|\s*(\S+)/i.exec(line);
			return match && !match[1].startsWith('local[') ? [match[1]] : [];
		});
		assert.deepEqual(entry.instructions, decoded, 'Saturating instructions differ from disassembly');
		for (const opcode of fixture.requiredInstructions) assert(decoded.includes(opcode), `Missing saturating opcode: ${opcode}`);
		for (const opcode of fixture.forbiddenInstructions) assert(!decoded.includes(opcode), `Unexpected saturating opcode: ${opcode}`);
		if (!fixture.request.simd) assert(!decoded.some(opcode => simd.test(opcode)), 'Disabled profile encoded SIMD');
		const validation = entry.simdDisabledValidation;
		assert.equal(validation?.command, report.toolPaths.validator);
		assert.equal(validation.status, fixture.request.simd ? 1 : 0, 'Independent disabled-SIMD validation disagrees');
		assert.equal(validation.signal, null); assert(!validation.error);
		assert.equal(validation.argv[0], '--disable-simd');
		assert.equal(path.basename(validation.argv.at(-1)), 'main.wasm');
	}
	const diagnostics = [...saturatingCases.flatMap(fixture => ['disabled', 'default'].map(profile => ({ fixture, profile }))),
		...saturatingDiagnosticCases.map(fixture => ({ fixture, profile: 'enabled-invalid' }))];
	assert.deepEqual(report.diagnostics.map(entry => entry.id), diagnostics.map(({ fixture, profile }) => `${fixture.id}-${profile}`), 'Saturating SIMD diagnostic matrix is incomplete');
	for (const [index, { fixture, profile }] of diagnostics.entries()) {
		const entry = report.diagnostics[index], command = entry.command;
		assert.equal(entry.fixture, fixture.id); assert.equal(entry.profile, profile);
		assert.deepEqual(entry.source, identity(Buffer.from(fixture.request.code)));
		assert.equal(entry.emittedSimd, false, 'Rejected builtin emitted SIMD');
		assert.equal(command.command, fixture.request.language === 'cpp' ? report.toolPaths.gccCpp : report.toolPaths.gcc);
		assert.equal(command.status, 1); assert.equal(command.signal, null); assert(!command.error);
		assert.match(command.stderr, profile === 'enabled-invalid' ? new RegExp(fixture.diagnosticPattern) : /SIMD128 is disabled/);
		assert.deepEqual(command.argv.filter(arg => /^-O/.test(arg)), [`-O${fixture.request.optimization}`]);
		assert.deepEqual(command.argv.filter(arg => arg.startsWith('-std=')), [`-std=${fixture.request.standard}`]);
		assert.deepEqual(command.argv.filter(arg => /^-m(?:no-)?simd128$/.test(arg)), profile === 'default' ? [] : [profile === 'disabled' ? '-mno-simd128' : '-msimd128']);
	}
}

export function verifySimdConversionsQualificationOptions(patches, options) {
  if (!patches.some(patch => patch.path === 'patches/0015-simd-conversions.patch')) return;
  for (const field of ['simdQualification', 'simdExtendedQualification', 'simdSaturatingQualification', 'simdConversionsQualification', 'vectorAbiQualification', 'nativeLinker'])
    assert(options[field], `SIMD conversions require ${field} with the current compiler`);
}

export function verifySimdConversionsQualification(report, expected) {
  const fixtures = [...conversionCases, ...conversionDisabledCases];
  verifySimdQualification(report, { ...expected, kind: 'gcc-wasi-native-simd-conversions-qualification', fixtures });
  assert.equal(report.inputsUnchanged, true, 'SIMD conversion inputs changed');
  for (const field of ['sourceLock', 'gccSource', 'headers', 'objdump', 'validator', 'node', 'inspectionRecipe'])
    assert.deepEqual(report[field], expected[field], `SIMD conversion ${field} differs`);
  const tools = { gcc: report.compiler, gccCpp: report.compilerCpp, assembler: report.assembler,
    objdump: report.objdump, linker: report.linker, validator: report.validator, node: report.node };
  assert.deepEqual(Object.keys(report.toolPaths).sort(), Object.keys(tools).sort());
  for (const [name, receipt] of Object.entries(tools)) {
    assert(path.isAbsolute(report.toolPaths[name]), `Missing absolute ${name} path`);
    assert.deepEqual(report.inputs[report.toolPaths[name]], receipt, `SIMD conversion ${name} command is not bound to its measured tool`);
  }
  const binaryIdentity = (receipt, label) => {
    assert(Number.isSafeInteger(receipt?.bytes) && receipt.bytes > 8 && /^[a-f0-9]{64}$/.test(receipt.sha256), `Missing ${label} identity`);
  };
  const simd = /\b(?:v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\./u;
  assert.deepEqual(report.defaultControls.map(entry => entry.id), conversionDisabledCases.map(fixture => `${fixture.id}-default`), 'Default fallback matrix is incomplete');
  for (const entry of [...report.cases, ...report.defaultControls]) {
    const fixture = fixtures.find(candidate => candidate.id === entry.fixture);
    assert(fixture, 'Unknown conversion fixture');
    const profile = entry.id.endsWith('-default') ? 'default' : fixture.request.simd ? 'enabled' : 'disabled';
    assert.equal(entry.id, fixture.id + (profile === 'default' ? '-default' : ''));
    assert.equal(entry.profile, profile); assert.equal(entry.semanticKind, fixture.semanticKind);
    if (profile === 'default') assert(conversionDisabledCases.includes(fixture), 'Default control is not a scalar fallback fixture');
    assert.equal(entry.status, 'passed');
    assert.deepEqual(entry.source, identity(Buffer.from(fixture.request.code)));
    assert.equal(entry.stdin, fixture.stdin); assert.equal(entry.stdout, fixture.stdout);
    binaryIdentity(entry.assembly, 'conversion assembly'); binaryIdentity(entry.object, 'conversion object'); binaryIdentity(entry.wasm, 'conversion program');
    assert.deepEqual(entry.commands.map(command => command.command),
      [fixture.request.language === 'cpp' ? report.toolPaths.gccCpp : report.toolPaths.gcc,
        report.toolPaths.assembler, report.toolPaths.objdump, report.toolPaths.linker, report.toolPaths.node]);
    for (const command of entry.commands) { assert.equal(command.status, 0); assert.equal(command.signal, null); assert(!command.error); }
    const argv = entry.commands[0].argv;
    assert.deepEqual(argv.filter(arg => /^-O/.test(arg)), [`-O${fixture.request.optimization}`]);
    assert.deepEqual(argv.filter(arg => arg.startsWith('-std=')), [`-std=${fixture.request.standard}`]);
    assert.deepEqual(argv.filter(arg => /^-m(?:no-)?simd128$/.test(arg)), profile === 'default' ? [] : [fixture.request.simd ? '-msimd128' : '-mno-simd128']);
    assert(entry.commands[3].argv.includes('--fatal-warnings'));
    assert.equal(entry.commands[4].stdout, fixture.stdout); assert.equal(entry.commands[4].stderr, '');
    assert(entry.imports?.every(item => item.module === 'wasi_snapshot_preview1' && item.kind === 'function'));
    assert(entry.exports?.some(item => item.name === 'memory' && item.kind === 'memory'));
    assert(entry.exports.some(item => item.name === '_start' && item.kind === 'function'));
    const disassembly = entry.commands[2].stdout;
    const decoded = disassembly.split('\n').flatMap(line => {
      const match = /^\s*[a-f0-9]+:\s+(?:[a-f0-9]{2}\s+)+\|\s*(\S+)/i.exec(line);
      return match && !match[1].startsWith('local[') ? [match[1]] : [];
    });
    assert.deepEqual(entry.instructions, decoded, 'Conversion instructions differ from actual disassembly');
    const conversion = conversionInstructions(disassembly);
    assert.deepEqual(entry.conversionFunction, conversion, 'Conversion body differs from disassembly');
    verifyConversionInstructions(fixture, conversion);
    if (!fixture.request.simd) assert(!decoded.some(opcode => simd.test(opcode)), 'Disabled/default profile encoded SIMD');
    const validation = entry.simdDisabledValidation;
    assert.equal(validation?.command, report.toolPaths.validator);
    assert.equal(validation.status, fixture.request.simd ? 1 : 0);
    assert.equal(validation.signal, null); assert(!validation.error);
    assert.equal(validation.argv[0], '--disable-simd'); assert.equal(path.basename(validation.argv.at(-1)), 'main.wasm');
  }
  const diagnostics = [...conversionCases.filter(fixture => fixture.builtin).flatMap(fixture => ['disabled', 'default'].map(profile => ({ fixture, profile }))),
    ...conversionDiagnosticCases.map(fixture => ({ fixture, profile: 'enabled-invalid' }))];
  assert.deepEqual(report.diagnostics.map(entry => entry.id), diagnostics.map(({ fixture, profile }) => `${fixture.id}-${profile}`), 'Conversion diagnostic matrix is incomplete');
  for (const [index, { fixture, profile }] of diagnostics.entries()) {
    const entry = report.diagnostics[index], command = entry.command;
    assert.equal(entry.fixture, fixture.id); assert.equal(entry.profile, profile);
    assert.deepEqual(entry.source, identity(Buffer.from(fixture.request.code))); assert.equal(entry.emittedSimd, false);
    assert.equal(command.command, fixture.request.language === 'cpp' ? report.toolPaths.gccCpp : report.toolPaths.gcc);
    assert.equal(command.status, 1); assert.equal(command.signal, null); assert(!command.error);
    assert.match(command.stderr, profile === 'enabled-invalid' ? new RegExp(fixture.diagnosticPattern) : /SIMD128 is disabled/);
    assert.deepEqual(command.argv.filter(arg => /^-O/.test(arg)), [`-O${fixture.request.optimization}`]);
    assert.deepEqual(command.argv.filter(arg => arg.startsWith('-std=')), [`-std=${fixture.request.standard}`]);
    assert.deepEqual(command.argv.filter(arg => /^-m(?:no-)?simd128$/.test(arg)), profile === 'default' ? [] : [profile === 'disabled' ? '-mno-simd128' : '-msimd128']);
  }
}

export function verifyVectorAbiQualification(report, expected, fixtures) {
	assert.equal(report.kind, 'gcc-wasi-vector-abi-interop');
	assert.equal(report.status, 'passed', 'Vector ABI qualification failed');
	assert.equal(report.inputsUnchanged, true, 'Vector ABI inputs were not stable');
	assert.equal(report.compilerHost, 'native');
	assert.equal(report.outputTarget, 'wasm32-wasi');
	assert.equal(report.gccCommit, expected.gccCommit);
	const content = receipt => ({ bytes: receipt?.bytes, sha256: receipt?.sha256 });
	assert.deepEqual(content(report.fixtures), expected.fixture, 'Vector ABI fixtures changed');
	assert.deepEqual(content(report.harness), expected.testRecipe, 'Vector ABI recipe changed');
	assert.deepEqual(content(report.inspectionRecipe), expected.inspectionRecipe, 'Vector ABI inspection recipe changed');
	assert.deepEqual(Object.fromEntries(Object.entries(report.targetSource).map(([name, receipt]) => [name, content(receipt)])), expected.targetSource, 'Vector ABI backend sources differ');
	for (const [name, sha256] of Object.entries(expected.tools))
		assert.equal(report.tools?.[name]?.sha256, sha256, `Vector ABI tool differs: ${name}`);
	for (const [name, receipt] of Object.entries(expected.runtime))
		assert.deepEqual(content(report.runtime?.[name]), receipt, `Vector ABI runtime differs: ${name}`);
	const matrix = fixtures.flatMap(fixture => ['0', '2'].flatMap(optimization =>
		(fixture.request.simd ? ['gcc-gcc', 'gcc-clang', 'clang-gcc', 'clang-clang'] : ['gcc-gcc'])
			.map(direction => ({ fixture, optimization, direction, id: `${fixture.id}-o${optimization}-${direction}` }))));
	assert.deepEqual(report.cases?.map(test => test.id).sort(), matrix.map(test => test.id).sort(), 'Vector ABI matrix is incomplete');
	assert.deepEqual(report.counts, { total: matrix.length, passed: matrix.length, failed: 0 });
	for (const { fixture, optimization, direction, id } of matrix) {
		const test = report.cases.find(entry => entry.id === id);
		assert.equal(test.status, 'passed', `${id}: failed`);
		assert.equal(test.fixture, fixture.id);
		assert.equal(test.optimization, optimization);
		assert.equal(test.direction, direction);
		assert.equal(test.simd, fixture.request.simd);
		assert.equal(test.stdout, fixture.stdout, `${id}: execution output differs`);
		assert.deepEqual(test.abi?.exports?._start, { params: [], results: [] });
		assert.equal(test.abi.memories.length, 1);
		assert.equal(test.abi.memories[0].shared, false);
		for (const [symbol, signature] of Object.entries(fixture.signatures))
			assert.deepEqual(test.abi.exports[symbol], signature, `${id}: ${symbol} signature differs`);
		assert(test.imports.every(entry => entry.module === 'wasi_snapshot_preview1' && entry.kind === 'function'));
		assert(test.exports.some(entry => entry.name === 'memory' && entry.kind === 'memory'));
		assert(test.exports.some(entry => entry.name === '_start' && entry.kind === 'function'));
		assert(Number.isSafeInteger(test.program?.bytes) && test.program.bytes > 8 && /^[a-f0-9]{64}$/.test(test.program.sha256));
		const units = [fixture.request.code, ...(fixture.request.sources || []).map(name => fixture.request.files.find(file => file.path === name).contents)];
		assert.equal(test.units.length, units.length, `${id}: missing translation unit`);
		const stages = [];
		for (const [index, source] of units.entries()) {
			const family = direction.split('-')[index === 0 ? 0 : 1];
			assert.equal(test.units[index].compiler, family);
			assert.deepEqual(content(test.units[index].source), identity(Buffer.from(source)), `${id}: source differs`);
			const frontend = family === 'clang' ? 'clang' : fixture.request.language === 'cpp' ? 'cc1plus' : 'cc1';
			const argv = test.commands[stages.length]?.argv || [];
			assert.deepEqual(argv.filter(arg => /^-O/.test(arg)), [`-O${optimization}`], `${id}: optimization differs`);
			assert.deepEqual(argv.filter(arg => arg.startsWith('-std=')), [`-std=${fixture.request.standard}`], `${id}: standard differs`);
			assert.deepEqual(argv.filter(arg => /^-m(?:no-)?simd128$/.test(arg)), [fixture.request.simd ? '-msimd128' : '-mno-simd128'], `${id}: SIMD profile differs`);
			stages.push(frontend, ...(family === 'gcc' ? ['wat2wasm'] : []), 'wasm-objdump');
		}
		stages.push('wasm-ld', 'node');
		assert.deepEqual(test.commands.map(command => path.basename(command.command)), stages, `${id}: unexpected compilation path`);
		for (const command of test.commands) {
			assert.equal(command.status, 0); assert.equal(command.signal, null); assert(!command.error);
		}
		assert(test.commands.at(-2).argv.includes('--fatal-warnings'));
		assert.equal(test.commands.at(-1).stdout, fixture.stdout);
		assert.equal(test.commands.at(-1).stderr, '');
	}
}

export function verifyWideScalarQualificationOptions(patches, options) {
	for (const [patch, field, option] of [
		['patches/0008-binary128-long-double.patch', 'longDoubleQualification', 'long-double-qualification'],
		['patches/0009-int128.patch', 'int128Qualification', 'int128-qualification'],
		['patches/0014-gnu-float128.patch', 'gnuFloat128Qualification', 'gnu-float128-qualification']
	]) {
		if (options[field])
			assert(options.nativeLinker && options.libstdcxx, `--${option} requires --native-linker and --libstdcxx`);
		if (patches.some(entry => entry.path === patch))
			assert(options[field], `This backend requires --${option}`);
	}
}

export function verifyAbiQualificationOptions(patches, options) {
	for (const [patch, field, option] of [
		['patches/0010-empty-record-abi.patch', 'emptyAbiQualification', 'empty-abi-qualification'],
		['patches/0011-bitfield-layout.patch', 'bitfieldQualification', 'bitfield-qualification'],
		['patches/0012-anonymous-bitfield-abi.patch', 'anonymousBitfieldQualification', 'anonymous-bitfield-qualification']
	]) {
		if (options[field]) assert(options.nativeLinker, `--${option} requires --native-linker`);
		if (patches.some(entry => entry.path === patch)) assert(options[field], `This backend requires --${option}`);
	}
}

export function verifyLongDoubleQualification(report, expected, fixtures) {
	return verifyWideScalarQualification(report, expected, fixtures, 'gcc-wasi-long-double-qualification', 'Binary128');
}

export function verifyEmptyAbiQualification(report, expected, fixtures) {
	assert(report, 'Empty ABI requires native qualification proof');
	assert(report.counts?.total >= 112, 'Empty ABI requires the complete native qualification');
	verifyFixtureIdentities(report, fixtures, 'Empty ABI');
	return verifyWideScalarQualification(report, expected, fixtures, 'gcc-wasi-empty-record-abi-qualification', 'Empty ABI');
}

export function verifyBrowserHostProfile(receipt, nativeDriverSpecs) {
	assert.deepEqual(receipt.hostUtilityProfile, {
		name: 'browser-frontends', gcov: false, gcovDump: false, gcovTool: false
	}, 'Browser compiler must exclude unsupported gcov host tools');
	assert.deepEqual(receipt.bootstrap, {
		allGccBootstrapExitCode: 0, gcovHostTools: 'disabled', profile: 'browser-frontends'
	}, 'Browser compiler requires successful all-gcc preparation');
	assert(nativeDriverSpecs, 'Browser host must bind the qualified native driver specs');
	assert.deepEqual(receipt.nativeDriverSpecs, nativeDriverSpecs, 'Browser host used different native driver specs');
}

export function verifyBitfieldQualification(report, expected, fixtures) {
	assert(report, 'Bitfield requires native qualification proof');
	verifyFixtureIdentities(report, fixtures, 'Bitfield');
	return verifyWideScalarQualification(report, expected, fixtures, 'gcc-wasi-wide-integer-qualification', 'Bitfield');
}

export function verifyAnonymousBitfieldQualification(report, expected, fixtures) {
	assert(report, 'Anonymous bitfield requires native qualification proof');
	assert(Array.isArray(fixtures) && fixtures.length > 0 && fixtures.every(fixture => fixture.interop === true),
		'Anonymous bitfield requires the complete mixed-compiler fixture matrix');
	assert.deepEqual(report.skippedReferences ?? [], [], 'Anonymous bitfield cannot omit compiler directions');
	verifyFixtureIdentities(report, fixtures, 'Anonymous bitfield');
	verifyWideScalarQualification(report, expected, fixtures, 'gcc-wasi-wide-integer-qualification', 'Anonymous bitfield');
	for (const test of report.cases) {
		const fixture = fixtures.find(fixture => fixture.id === test.fixture);
		for (const [index, unit] of test.units.entries())
			for (const [symbol, signature] of Object.entries(fixture.signatures))
				assert.deepEqual(unit.signatures?.[symbol], signature,
					`${test.id}: unit ${index} object ${symbol} ABI differs`);
	}
}

export function verifyGnuFloat128Qualification(report, expected, fixtures) {
	assert(report, 'GNU float128 requires native qualification proof');
	assert.equal(fixtures.length, 36, 'GNU float128 requires the complete type/ABI/library matrix');
	assert.equal(report.counts?.total, 78, 'GNU float128 requires all 78 native runs');
	const directions = ['gcc-gcc', 'gcc-clang', 'clang-gcc', 'clang-clang'];
	const skipped = fixtures.flatMap(fixture => directions
		.filter(direction => fixture.interop || direction === 'gcc-gcc' || direction === 'clang-clang')
		.filter(direction => fixture.clang === false && direction.includes('clang'))
		.map(direction => ({ fixture: fixture.id, direction, reason: fixture.clangReason })));
	assert.deepEqual(report.skippedReferences, skipped, 'GNU float128 may omit only the declared GNU-specific references');
	verifyFixtureIdentities(report, fixtures, 'GNU float128');
	verifyWideScalarQualification(report, expected, fixtures, 'gcc-wasi-wide-integer-qualification', 'GNU float128');
	for (const test of report.cases) {
		const fixture = fixtures.find(fixture => fixture.id === test.fixture);
		if (fixture.objectSignatures)
			for (const [index, unit] of test.units.entries())
				for (const [symbol, signature] of Object.entries(fixture.signatures))
					assert.deepEqual(unit.signatures?.[symbol], signature,
						`${test.id}: unit ${index} GNU float128 object ${symbol} ABI differs`);
	}
}

function verifyFixtureIdentities(report, fixtures, label) {
	assert.equal(report.suiteSha256, identity(Buffer.from(JSON.stringify(fixtures))).sha256, `${label} fixture matrix changed`);
	const fixtureHashes = new Map(fixtures.map(fixture => [fixture.id, identity(Buffer.from(JSON.stringify(fixture))).sha256]));
	for (const test of report.cases)
		assert.equal(test.fixtureSha256, fixtureHashes.get(test.fixture), `${label} fixture differs: ${test.id}`);
}

// Exact math contract of the locked GCC 17 linkage.m4 and fallback sources.
// Bind membership as well as tool hashes: a self-reported count cannot qualify
// omitted functions whose absence would enable reduced-precision stubs.
export const typedMathProbeContract = Object.freeze({
	functions: Object.freeze(["acosf", "acosl", "asinf", "asinl", "at_quick_exit", "atan2f", "atan2l", "atanf", "atanl", "ceilf", "ceill", "cosf", "coshf", "coshl", "cosl", "expf", "expl", "fabsf", "fabsl", "finite", "finitef", "finitel", "floorf", "floorl", "fmodf", "fmodl", "fpclass", "frexpf", "frexpl", "hypot", "hypotf", "hypotl", "isinf", "isinff", "isinfl", "isnan", "isnanf", "isnanl", "ldexpf", "ldexpl", "log10f", "log10l", "logf", "logl", "modf", "modff", "modfl", "powf", "powl", "qfpclass", "quick_exit", "sin", "sincos", "sincosf", "sincosl", "sinf", "sinhf", "sinhl", "sinl", "sqrtf", "sqrtl", "strtof", "strtold", "tanf", "tanhf", "tanhl", "tanl"]),
	required: Object.freeze(["acosf", "acosl", "asinf", "asinl", "atan2f", "atan2l", "atanf", "atanl", "ceilf", "ceill", "cosf", "coshf", "coshl", "cosl", "expf", "expl", "fabsf", "fabsl", "floorf", "floorl", "fmodf", "fmodl", "frexpf", "frexpl", "hypotf", "hypotl", "ldexpf", "ldexpl", "log10f", "log10l", "logf", "logl", "modff", "modfl", "powf", "powl", "sinf", "sinhf", "sinhl", "sinl", "sqrtf", "sqrtl", "tanf", "tanhf", "tanhl", "tanl"])
});

export function verifyTypedMathProbes(report, expectedInputs, expectedHeaders) {
	assert.equal(report?.kind, 'gcc-wasi-typed-math-link-probes');
	assert.equal(report.status, 'passed', 'Typed math probes did not pass');
	assert.equal(report.inputsUnchanged, true, 'Typed math probe inputs changed');
	assert.equal(report.target, 'wasm32-wasi');
	assert.deepEqual(report.missingRequired, [], 'Typed math probes permit reduced-precision GNU stubs');
	assert.deepEqual(report.functions, typedMathProbeContract.functions, 'Typed math function membership differs from the pinned GCC source');
	assert.deepEqual(report.requiredToAvoidMathStubs, typedMathProbeContract.required, 'Typed math required replacements differ from the pinned GCC source');
	assert.equal(report.functions?.length, 67, 'Typed math probe matrix is incomplete');
	assert.equal(new Set(report.functions).size, 67, 'Duplicate typed math function');
	assert.deepEqual(report.stdlibFunctions, ['at_quick_exit', 'quick_exit', 'strtof', 'strtold']);
	assert.deepEqual(report.cases?.map(entry => entry.function).sort(), [...report.functions].sort(), 'Typed math case membership differs');
	for (const [name, expected] of Object.entries(expectedInputs))
		assert.deepEqual({ bytes: report.inputs?.[name]?.bytes, sha256: report.inputs?.[name]?.sha256 }, expected, `Typed math input differs: ${name}`);
	assert(expectedHeaders, 'Typed math must bind the actual GCC, target and SDK headers');
	assert.deepEqual(Object.keys(report.headers).sort(), Object.keys(expectedHeaders).sort(), 'Typed math header roots differ');
	for (const [name, files] of Object.entries(expectedHeaders))
		assert.deepEqual(Object.fromEntries(Object.entries(report.headers[name]).map(([file, receipt]) => [file, { bytes: receipt.bytes, sha256: receipt.sha256 }])), files, `Typed math headers differ: ${name}`);
	const required = new Set(report.requiredToAvoidMathStubs);
	assert(['sqrtl', 'hypotl', 'fabsl'].every(name => required.has(name)), 'Missing binary128 math stub checks');
	assert([...required].every(name => report.cases.some(entry => entry.function === name && entry.available)), 'Required math function is unavailable');
	for (const entry of report.cases) {
		assert.equal(entry.required, required.has(entry.function));
		const stages = ['compiler', 'assembler', 'linker'];
		assert(entry.commands.length >= 1 && entry.commands.length <= 3);
		for (const [index, command] of entry.commands.entries()) {
			assert.equal(command.argv?.[0], report.inputs[stages[index]].path, 'Typed math used an unbound tool');
			assert(!command.error, 'Typed math command did not complete');
			if (index === 2) assert(command.argv.includes('--fatal-warnings'), 'Typed math linker warnings must be fatal');
			assert(Number.isInteger(command.exitCode), 'Typed math command has no exit status');
			assert(!/internal compiler error/i.test(command.stderr || ''), 'Typed math feature detection hit a compiler defect');
		}
		if (entry.available) assert(entry.commands.length === 3 && entry.commands.every(command => command.exitCode === 0));
		else assert(entry.commands.at(-1).exitCode !== 0, 'Unavailable math function has no failing probe');
	}
	const available = report.cases.filter(entry => entry.available).length;
	assert.deepEqual(report.counts, { total: 67, available, unavailable: 67 - available });
}

export function verifyInt128Qualification(report, expected, fixtures) {
	assert(report, 'Int128 requires native qualification proof');
	assert.equal(report.counts?.total, 116, 'Int128 requires the complete 116-case native qualification');
	verifyFixtureIdentities(report, fixtures, 'Int128');
	return verifyWideScalarQualification(report, expected, fixtures, 'gcc-wasi-int128-qualification', 'Int128');
}

export function verifySymbolAliasPrograms(report, expected, fixtures) {
	assert.equal(report.counts?.total, 106, 'Symbol aliases require every native compiler direction');
	const skipped = fixtures.flatMap(fixture => ['gcc-gcc', 'gcc-clang', 'clang-gcc', 'clang-clang']
		.filter(direction => fixture.interop || direction === 'gcc-gcc' || direction === 'clang-clang')
		.filter(direction => fixture.clang === false && direction.includes('clang'))
		.map(direction => ({ fixture: fixture.id, direction, reason: fixture.clangReason })));
	assert.deepEqual(report.skippedReferences, skipped, 'Symbol aliases may omit only the declared GNU runtime references');
	verifyFixtureIdentities(report, fixtures, 'Symbol alias');
	return verifyWideScalarQualification(report, expected, fixtures, 'gcc-wasi-wide-integer-qualification', 'Symbol alias');
}

// Both real harnesses have the same compiler-direction matrix and artifact
// contract. Keep their provenance and ABI validation identical while retaining
// the binary128 verifier's established diagnostics and public test entry point.
function verifyWideScalarQualification(report, expected, fixtures, kind, label) {
	assert.equal(report.kind, kind);
	assert.equal(report.status, 'passed', `${label} qualification failed`);
	assert.equal(report.inputsUnchanged, true, `${label} inputs changed`);
	assert.equal(report.compilerHost, 'native');
	assert.equal(report.outputTarget, 'wasm32-wasi');
	assert.equal(report.gccCommit, expected.gccCommit);
	const content = receipt => ({ bytes: receipt?.bytes, sha256: receipt?.sha256 });
	const contents = map => Object.fromEntries(Object.entries(map).map(([name, receipt]) => [name, content(receipt)]));
	assert.deepEqual(contents(report.targetSource), expected.targetSource, `${label} backend sources differ`);
	assert.deepEqual(contents(report.recipes), expected.recipes, `${label} qualification recipes differ`);
	for (const group of ['tools', 'runtime'])
		for (const [name, receipt] of Object.entries(expected[group]))
			assert.deepEqual(content(report[group]?.[name]), receipt, `${label} ${group} differs: ${name}`);
	for (const [name, files] of Object.entries(expected.headers))
		assert.deepEqual(contents(report.headers[name]), files, `${label} headers differ: ${name}`);
	const directions = ['gcc-gcc', 'gcc-clang', 'clang-gcc', 'clang-clang'];
	assert.deepEqual(report.directions, directions);
	assert.deepEqual(report.selectedCases, fixtures.map(fixture => fixture.id));
	const matrix = fixtures.flatMap(fixture => directions
		.filter(direction => fixture.interop || direction === 'gcc-gcc' || direction === 'clang-clang')
		.filter(direction => fixture.clang !== false || !direction.includes('clang'))
		.map(direction => ({ fixture, direction, id: `${fixture.id}-${direction}` })));
	assert.deepEqual(report.cases.map(test => test.id).sort(), matrix.map(test => test.id).sort(), `${label} qualification is incomplete`);
	assert.deepEqual(report.counts, { total: matrix.length, passed: matrix.length, failed: 0 });
	for (const { fixture, direction, id } of matrix) {
		const test = report.cases.find(test => test.id === id);
		assert.equal(test.status, 'passed', `${id}: failed`);
		assert.equal(test.fixture, fixture.id);
		assert.equal(test.direction, direction);
		assert.equal(test.optimization, fixture.request.optimization);
		assert.equal(test.stdin, fixture.stdin);
		assert.equal(test.stdout, fixture.stdout, `${id}: incorrect output`);
		assert.equal(test.stderr, '');
		assert.deepEqual(test.abi.exports._start, { params: [], results: [] });
		assert.equal(test.abi.memories.length, 1);
		assert.equal(test.abi.memories[0].shared, false);
		for (const [symbol, signature] of Object.entries(fixture.signatures))
			assert.deepEqual(test.abi.exports[symbol], signature, `${id}: ${symbol} ABI differs`);
		assert(test.imports.every(entry => entry.module === 'wasi_snapshot_preview1' && entry.kind === 'function'));
		assert(test.exports.some(entry => entry.name === 'memory' && entry.kind === 'memory'));
		assert(test.exports.some(entry => entry.name === '_start' && entry.kind === 'function'));
		const units = [fixture.request.code, ...(fixture.request.sources || []).map(name => fixture.request.files.find(file => file.path === name).contents)];
		assert.equal(test.units.length, units.length, `${id}: missing translation unit`);
		const stages = [];
		for (const [index, source] of units.entries()) {
			const family = direction.split('-')[index === 0 ? 0 : 1];
			assert.equal(test.units[index].compiler, family);
			assert.deepEqual(content(test.units[index].source), identity(Buffer.from(source)), `${id}: source differs`);
			// Clang emits reference IR and the actual object in separate invocations.
			// Both must use the profile whose result is being qualified.
			for (let step = 0; step < (family === 'clang' ? 2 : 1); ++step) {
				const argv = test.commands[stages.length + step]?.argv || [];
				assert.deepEqual(argv.filter(arg => /^-O/.test(arg)), [`-O${fixture.request.optimization}`]);
				assert.deepEqual(argv.filter(arg => arg.startsWith('-std=')), [`-std=${fixture.request.standard}`]);
				assert.deepEqual(argv.filter(arg => /^-m(?:no-)?simd128$/.test(arg)), [fixture.request.simd ? '-msimd128' : '-mno-simd128'], `${label} SIMD profile differs`);
				assert.deepEqual(argv.filter(arg => arg.startsWith('-D')), ['-D__GCC_WASI_SINGLE_THREAD__=1', ...(fixture.request.defines || []).map(define => `-D${define}`)], `${label} macro definitions differ`);
				if (family === 'clang')
					assert.deepEqual(argv.filter(arg => ['-S', '-emit-llvm', '-c'].includes(arg)), step === 0 ? ['-S', '-emit-llvm'] : ['-c'], `${label} Clang compilation stage differs`);
			}
			stages.push(family === 'clang' ? 'clang' : fixture.request.language === 'cpp' ? 'gccCpp' : 'gcc', family === 'clang' ? 'clang' : 'assembler', 'inspector');
		}
		stages.push('linker', 'node');
		assert.equal(test.commands.length, stages.length, `${id}: unexpected compilation path`);
		for (const [index, command] of test.commands.entries()) {
			const tool = stages[index], recorded = report.tools[tool];
			assert(expected.tools[tool], `${label} tool has no expected fingerprint: ${tool}`);
			assert.deepEqual(content(recorded), expected.tools[tool], `${label} tool differs: ${tool}`);
			assert(typeof recorded.path === 'string' && path.isAbsolute(recorded.path), `${label} tool path is not absolute: ${tool}`);
			assert(typeof command.command === 'string' && path.isAbsolute(command.command), `${label} executed tool path is not absolute: ${tool}`);
			// Lexical aliases remain portable when the original proof directory is
			// relocated.  A same-named binary in another directory is not an alias.
			assert.equal(path.normalize(command.command), path.normalize(recorded.path), `${label} executed tool differs from its fingerprint: ${tool}`);
			assert.equal(command.status, 0); assert.equal(command.signal, null); assert(!command.error);
		}
		const link = test.commands.at(-2).argv;
		assert(link.includes('--fatal-warnings'), `${label} linking must reject signature warnings`);
		if (fixture.printscan) {
			const extension = link.indexOf(report.runtime.printscan.path);
			assert(extension >= 0 && extension < link.indexOf('-lc'), `${label} print/scan extension must precede libc`);
		}
		assert.equal(test.commands.at(-1).stdout, fixture.stdout);
		assert.equal(test.commands.at(-1).stderr, '');
	}
}

export async function packageWasi({ work, runtime, output, libstdcxx, simdQualification, simdExtendedQualification, simdSaturatingQualification, simdConversionsQualification, simdHeaderQualification, simdRelaxedQualification, simdRelaxedDriverQualification, vectorAbiQualification, longDoubleQualification, int128Qualification, gnuFloat128Qualification, emptyAbiQualification, bitfieldQualification, anonymousBitfieldQualification, symbolAliasQualification, weakrefQualification, rttiQualification, coverageQualification, dwarfQualification, libgcov, libatomic, libatomicQualification, atomicsQualification, tlsRuntime, tlsLibc, tlsQualification, tlsRuntimeQualification, ehRuntime, ehQualification, ehRuntimeQualification, nativeGcov, nativeLinker }) {
	work = await fs.realpath(work);
	runtime = await fs.realpath(runtime);
	if (libstdcxx) libstdcxx = await fs.realpath(libstdcxx);
	if (libgcov) libgcov = await fs.realpath(libgcov);
	if (libatomic) libatomic = await fs.realpath(libatomic);
	if (tlsRuntime) tlsRuntime = await fs.realpath(tlsRuntime);
	if (tlsLibc) tlsLibc = await fs.realpath(tlsLibc);
	if (ehRuntime) ehRuntime = await fs.realpath(ehRuntime);
	const out = path.resolve(output);
	const inputs = [work, runtime, libstdcxx, libgcov, libatomic, tlsRuntime, tlsLibc, ehRuntime,
		...(libatomicQualification ? [await fs.realpath(libatomicQualification)] : []),
		...(atomicsQualification ? [await fs.realpath(atomicsQualification)] : []),
		...(tlsQualification ? [await fs.realpath(tlsQualification)] : []),
		...(tlsRuntimeQualification ? [await fs.realpath(tlsRuntimeQualification)] : []),
		...(ehQualification ? [await fs.realpath(ehQualification)] : []),
		...(ehRuntimeQualification ? [await fs.realpath(ehRuntimeQualification)] : [])].filter(Boolean);
	// Existing parent realpaths also catch output aliases through a symlink.
	await fs.mkdir(path.dirname(out), { recursive: true });
	const finalOut = path.join(await fs.realpath(path.dirname(out)), path.basename(out));
	assert(!inputs.some((input) => inside(input, finalOut) || inside(finalOut, input)), 'Output must not overlap any build input');
	const lockBytes = await fs.readFile(path.join(here, 'sources.lock.json'));
	const runtimeLockBytes = await fs.readFile(path.join(here, 'runtime.lock.json'));
	const lock = JSON.parse(lockBytes), runtimeLock = JSON.parse(runtimeLockBytes);
	verifyLibatomicPackageOptions(lock.gcc.patches || [], { libatomic, libatomicQualification, nativeLinker });
	verifyAtomicsPackageOptions(lock.gcc.patches || [], { atomicsQualification, libatomic, libatomicQualification, nativeLinker });
	verifyTlsPackageOptions(lock.gcc.patches || [], { tlsRuntime, tlsLibc, tlsQualification, tlsRuntimeQualification, libstdcxx, nativeLinker });
	verifyExceptionPackageOptions(lock.gcc.patches || [], { ehRuntime, ehQualification, ehRuntimeQualification, libstdcxx, nativeLinker });
	const libatomicProof = libatomicQualification && await fs.readFile(libatomicQualification);
	const atomicsProof = atomicsQualification && await fs.readFile(atomicsQualification);
	const tlsProof = tlsQualification && await fs.readFile(tlsQualification);
	const tlsRuntimeProof = tlsRuntimeQualification && await fs.readFile(tlsRuntimeQualification);
	const exceptionProof = ehQualification && await fs.readFile(ehQualification);
	const exceptionRuntimeProof = ehRuntimeQualification && await fs.readFile(ehRuntimeQualification);
	const compilerRoot = path.join(work, 'browser-compiler');
	const compilerReceipt = await readJson(path.join(compilerRoot, 'compiler-build.json'));
	assert.equal(compilerReceipt.kind, 'gcc-wasi-browser-build');
	assert.equal(compilerReceipt.gccCommit, lock.gcc.commit);
	assert.equal(compilerReceipt.host, 'wasm32-emscripten');
	assert.equal(compilerReceipt.target, 'wasm32-wasi');
	const nativeDriverSpecs = identity(await fs.readFile(path.join(work, 'native-driver.specs')));
	verifyBrowserHostProfile(compilerReceipt, nativeDriverSpecs);
	assert.deepEqual(compilerReceipt.sourceLock, identity(lockBytes));
	assert.deepEqual(compilerReceipt.gccSource?.patches, lock.gcc.patches || []);
	assert.deepEqual(compilerReceipt.recipe, identity(await fs.readFile(path.join(here, 'build-browser.sh'))));
	const compilerFiles = (await readNativeTree(compilerRoot)).filter((f) => f.path !== 'compiler-build.json');
	verifyInventory(compilerFiles, compilerReceipt.files, 'GCC compiler');
	for (const [name, expected] of Object.entries(compilerReceipt.hostDependencies))
		assert.deepEqual(identity(await fs.readFile(path.join(work, 'host-libraries/lib', `lib${name}.a`))), expected, 'Compiler host arithmetic libraries changed');
	const nativeGate = await fs.readFile(path.join(work, 'native-qualification.json'));
	assert.deepEqual(compilerReceipt.nativeQualification, identity(nativeGate));
	assert.equal(JSON.parse(nativeGate).status, 'passed');
	assert.equal(JSON.parse(nativeGate).gccCommit, lock.gcc.commit);
	assert.deepEqual(JSON.parse(nativeGate).gccSource, compilerReceipt.gccSource);
	const nativeReceiptBytes = await fs.readFile(path.join(work, 'native-build.json'));
	const nativeReceipt = JSON.parse(nativeReceiptBytes);
	assert.equal(nativeDriverSpecs.sha256, nativeReceipt.driverSpecsSha256, 'Native driver specs differ from the qualified native build');
	assert.equal(nativeReceipt.gccCommit, lock.gcc.commit);
	assert.deepEqual(nativeReceipt.gccSource, compilerReceipt.gccSource);
	assert.equal(JSON.parse(nativeGate).buildReceiptSha256, identity(nativeReceiptBytes).sha256);
	assert.equal(JSON.parse(nativeGate).sourceLockSha256, identity(lockBytes).sha256);
	assert.equal(nativeReceipt.sourceLockSha256, identity(lockBytes).sha256);
	let simdProof;
	if (simdQualification) {
		assert(nativeLinker, '--simd-qualification requires --native-linker');
		simdProof = await fs.readFile(simdQualification);
	}
	let simdExtendedProof;
	if (simdExtendedQualification) {
		assert(simdProof, '--simd-extended-qualification requires --simd-qualification');
		simdExtendedProof = await fs.readFile(simdExtendedQualification);
	}
	if (simdProof && lock.gcc.patches.some(patch => patch.path === 'patches/0006-simd-operations.patch'))
		assert(simdExtendedProof, 'This backend requires --simd-extended-qualification before advertising SIMD');
	verifySaturatingSimdQualificationOptions(lock.gcc.patches, { simdQualification, simdExtendedQualification, simdSaturatingQualification, vectorAbiQualification, nativeLinker });
	const simdSaturatingProof = simdSaturatingQualification && await fs.readFile(simdSaturatingQualification);
	verifySimdConversionsQualificationOptions(lock.gcc.patches, { simdQualification, simdExtendedQualification, simdSaturatingQualification, simdConversionsQualification, vectorAbiQualification, nativeLinker });
	const simdConversionsProof = simdConversionsQualification && await fs.readFile(simdConversionsQualification);
	verifySimdHeaderQualificationOptions(lock.gcc.patches, { simdQualification, simdExtendedQualification, simdSaturatingQualification, simdConversionsQualification, simdHeaderQualification, vectorAbiQualification, nativeLinker });
	const simdHeaderProof = simdHeaderQualification && await fs.readFile(simdHeaderQualification);
	verifyRelaxedSimdQualificationOptions(lock.gcc.patches, { simdQualification, simdExtendedQualification, simdSaturatingQualification, simdConversionsQualification, simdHeaderQualification, simdRelaxedQualification, vectorAbiQualification, nativeLinker });
	const simdRelaxedProof = simdRelaxedQualification && await fs.readFile(simdRelaxedQualification);
	verifyRelaxedSimdDriverQualificationOptions(lock.gcc.patches, { simdRelaxedQualification, simdRelaxedDriverQualification });
	const simdRelaxedDriverProof = simdRelaxedDriverQualification && await fs.readFile(simdRelaxedDriverQualification);
	verifySymbolAliasQualificationOptions(lock.gcc.patches, { symbolAliasQualification, nativeLinker, libstdcxx });
	const symbolAliasProof = symbolAliasQualification && await fs.readFile(symbolAliasQualification);
	const aliasReport = symbolAliasProof && JSON.parse(symbolAliasProof);
	const aliasProgramPath = aliasReport?.programs?.path;
	const aliasProgramProof = symbolAliasProof && await fs.readFile(aliasProgramPath);
	if (aliasProgramProof) assert.deepEqual(identity(aliasProgramProof), { bytes: aliasReport.programs.bytes, sha256: aliasReport.programs.sha256 });
	verifyWeakrefQualificationOptions(lock.gcc.patches, { weakrefQualification, nativeLinker, libstdcxx });
	const weakrefProof = weakrefQualification && await fs.readFile(weakrefQualification);
	verifyRttiQualificationOptions(lock.gcc.patches, { rttiQualification, nativeLinker, libstdcxx });
	const rttiProof = rttiQualification && await fs.readFile(rttiQualification);
	verifyCoverageQualificationOptions(lock.gcc.patches, { coverageQualification, libgcov, nativeGcov, nativeLinker, libstdcxx });
	const coverageProof = coverageQualification && await fs.readFile(coverageQualification);
	verifyDwarfQualificationOptions(lock.gcc.patches, { dwarfQualification, nativeLinker, libstdcxx, libgcov, nativeGcov });
	const dwarfProof = dwarfQualification && await fs.readFile(dwarfQualification);
	let vectorAbiProof;
	if (vectorAbiQualification) {
		assert(simdProof, '--vector-abi-qualification requires --simd-qualification');
		vectorAbiProof = await fs.readFile(vectorAbiQualification);
	}
	if (simdProof && lock.gcc.patches.some(patch => patch.path === 'patches/0007-vector-abi.patch'))
		assert(vectorAbiProof, 'This backend requires --vector-abi-qualification before advertising SIMD');
	verifyWideScalarQualificationOptions(lock.gcc.patches, { longDoubleQualification, int128Qualification, gnuFloat128Qualification, nativeLinker, libstdcxx });
	verifyAbiQualificationOptions(lock.gcc.patches, { emptyAbiQualification, bitfieldQualification, anonymousBitfieldQualification, nativeLinker });
	const longDoubleProof = longDoubleQualification && await fs.readFile(longDoubleQualification);
	const int128Proof = int128Qualification && await fs.readFile(int128Qualification);
	const gnuFloat128Proof = gnuFloat128Qualification && await fs.readFile(gnuFloat128Qualification);
	const emptyAbiProof = emptyAbiQualification && await fs.readFile(emptyAbiQualification);
	const bitfieldProof = bitfieldQualification && await fs.readFile(bitfieldQualification);
	const anonymousBitfieldProof = anonymousBitfieldQualification && await fs.readFile(anonymousBitfieldQualification);

	const asRoot = path.join(work, 'wabt-browser');
	const asReceipt = await readJson(path.join(asRoot, 'provenance.json'));
	const wabtRecipes = await Promise.all(['build-wabt.sh', 'prepare-source.py', 'sources.lock.json']
		.map(async name => [name, await fs.readFile(path.join(here, name))]));
	verifyWabtAssemblerReceipt(asReceipt, lock.wabt,
		Object.fromEntries(wabtRecipes.map(([name, bytes]) => [name, identity(bytes)])));
	const asFiles = await Promise.all(['as.mjs', 'as.wasm'].map(async (name) => ({ path: name, bytes: await fs.readFile(path.join(asRoot, name)) })));
	verifyInventory(asFiles, asReceipt.files, 'WABT assembler');
	const runtimeReceipt = await readJson(path.join(runtime, 'runtime-build.json'));
	assert.equal(runtimeReceipt.kind, 'gcc-wasi-runtime-import');
	assert.equal(runtimeReceipt.target, 'wasm32-wasi');
	assert.deepEqual(runtimeReceipt.runtimeLock, identity(runtimeLockBytes));
	assert.equal(runtimeReceipt.sdkArchiveSha256, lock.wasiSdk.sha256);
	assert.deepEqual(runtimeReceipt.patches, runtimeLock.wasiLibc.patches || []);
	const sysroot = await readNativeTree(path.join(runtime, 'sysroot'));
	verifyInventory(sysroot, runtimeReceipt.files, 'WASI sysroot');
	verifyRuntimeLibraryIdentities(sysroot, runtimeLock.wasiLibc.libraryIdentities);
	const targetSource = simdProof || longDoubleProof || int128Proof || gnuFloat128Proof || emptyAbiProof || bitfieldProof || anonymousBitfieldProof || symbolAliasProof || weakrefProof ? Object.fromEntries(inventory(await readNativeTree(path.join(work, 'gcc/gcc/config/wasm'))).map(({ path: name, ...receipt }) => [name, receipt])) : undefined;
	const runtimeHeaders = sysroot.filter(file => file.path.startsWith('include/')).map(file => ({ ...file, path: file.path.slice('include/'.length) }));
	for (const [proof, qualificationPath, fixtureName, recipeName, kind] of [
		[simdProof, simdQualification, 'simd-fixtures.mjs', 'test-simd.mjs', 'gcc-wasi-native-simd-qualification'],
		[simdExtendedProof, simdExtendedQualification, 'simd-extended-fixtures.mjs', 'test-simd-extended.mjs', 'gcc-wasi-native-simd-extended-qualification'],
		[simdSaturatingProof, simdSaturatingQualification, 'simd-saturating-fixtures.mjs', 'test-simd-saturating.mjs', 'gcc-wasi-native-simd-saturating-qualification'],
		[simdConversionsProof, simdConversionsQualification, 'simd-conversions-fixtures.mjs', 'test-simd-conversions.mjs', 'gcc-wasi-native-simd-conversions-qualification']
	]) {
		if (!proof) continue;
		const report = JSON.parse(proof);
		const suite = await import(new URL(fixtureName, import.meta.url));
		const expected = {
			kind, fixtures: [...suite.cases, ...(suite.disabledCases || [])], targetSource,
			gccCommit: lock.gcc.commit,
			compilerSha256: nativeReceipt.tools.cc1.sha256,
			compilerCppSha256: nativeReceipt.tools.cc1plus.sha256,
			fixture: identity(await fs.readFile(path.join(here, fixtureName))),
			testRecipe: identity(await fs.readFile(path.join(here, recipeName))),
			assembler: identity(await fs.readFile(path.join(work, 'wabt-native/wat2wasm'))),
			linker: identity(await fs.readFile(nativeLinker)),
			runtime: Object.fromEntries(['crt1-command.o', 'libc.a', 'libm.a', 'libclang_rt.builtins-wasm32.a'].map((name) => [name, identity(sysroot.find((f) => f.path === `lib/wasm32-wasi/${name}`).bytes)]))
		};
		if (proof === simdSaturatingProof || proof === simdConversionsProof) {
			const indexed = files => Object.fromEntries(files.map(file => [file.path, identity(file.bytes)]));
			Object.assign(expected, { sourceLock: identity(lockBytes), gccSource: nativeReceipt.gccSource,
				headers: { gcc: indexed(await readNativeTree(path.join(work, 'gcc-native/gcc/include'))), target: indexed(runtimeHeaders) },
				objdump: identity(await fs.readFile(path.join(work, 'wabt-native/wasm-objdump'))),
				validator: identity(await fs.readFile(path.join(work, 'wabt-native/wasm-validate'))), node: identity(await fs.readFile(process.execPath)) });
			if (proof === simdConversionsProof) {
				expected.inspectionRecipe = identity(await fs.readFile(path.join(here, 'simd-conversions-inspect.mjs')));
				verifySimdConversionsQualification(report, expected);
			} else verifySaturatingSimdQualification(report, expected);
			const artifacts = proof === simdConversionsProof ? [...report.cases, ...report.defaultControls] : report.cases;
			for (const entry of artifacts) for (const [name, receipt] of [['main.wat', entry.assembly], ['main.o', entry.object]]) {
				const bytes = await fs.readFile(path.join(path.dirname(qualificationPath), entry.id, name));
				assert.deepEqual(identity(bytes), receipt, `SIMD ${name} changed after qualification`);
				if (name === 'main.o') assert.equal(WebAssembly.Module.customSections(new WebAssembly.Module(bytes), 'linking').length, 1);
				if (proof === simdConversionsProof && name === 'main.wat' && entry.profile !== 'enabled')
					assert(!/\b(?:v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\./u.test(bytes.toString()), 'Disabled/default conversion assembly contains SIMD');
			}
			if (proof === simdConversionsProof) for (const entry of [...artifacts, ...report.diagnostics]) {
				const fixture = [...conversionCases, ...conversionDisabledCases, ...conversionDiagnosticCases].find(fixture => fixture.id === entry.fixture);
				const source = await fs.readFile(path.join(path.dirname(qualificationPath), entry.id, fixture.request.language === 'cpp' ? 'main.cc' : 'main.c'));
				assert.deepEqual(identity(source), entry.source, 'Conversion source changed after qualification');
			}
		} else verifySimdQualification(report, expected);
		for (const test of proof === simdConversionsProof ? [...report.cases, ...report.defaultControls] : report.cases) {
			const bytes = await fs.readFile(path.join(path.dirname(qualificationPath), test.id, 'main.wasm'));
			assert.deepEqual(identity(bytes), test.wasm, 'SIMD program differs from its qualification');
			checkWasm(bytes, `SIMD ${test.id}`, true);
			const module = new WebAssembly.Module(bytes);
			assert.deepEqual(WebAssembly.Module.imports(module), test.imports);
			assert.deepEqual(WebAssembly.Module.exports(module), test.exports);
		}
	}
	if (vectorAbiProof) {
		const report = JSON.parse(vectorAbiProof);
		const suite = await import('./vector-abi-cases.mjs');
		verifyVectorAbiQualification(report, {
			targetSource,
			gccCommit: lock.gcc.commit,
			fixture: identity(await fs.readFile(path.join(here, 'vector-abi-cases.mjs'))),
			testRecipe: identity(await fs.readFile(path.join(here, 'test-vector-abi.mjs'))),
			inspectionRecipe: identity(await fs.readFile(path.join(here, 'inspect-vector-abi.mjs'))),
			tools: {
				gcc: nativeReceipt.tools.cc1.sha256, gccCpp: nativeReceipt.tools.cc1plus.sha256,
				assembler: identity(await fs.readFile(path.join(work, 'wabt-native/wat2wasm'))).sha256,
				inspector: identity(await fs.readFile(path.join(work, 'wabt-native/wasm-objdump'))).sha256,
				linker: identity(await fs.readFile(nativeLinker)).sha256,
				clang: identity(await fs.readFile(path.join(path.dirname(nativeLinker), 'clang'))).sha256
			},
			runtime: Object.fromEntries(['crt1-command.o', 'libc.a', 'libm.a', 'libclang_rt.builtins-wasm32.a'].map(name =>
				[name === 'libclang_rt.builtins-wasm32.a' ? 'builtins' : name, identity(sysroot.find(file => file.path === `lib/wasm32-wasi/${name}`).bytes)]))
		}, [...suite.cases, ...suite.disabledCases]);
		for (const test of report.cases) {
			const bytes = await fs.readFile(path.join(path.dirname(vectorAbiQualification), test.id, 'program.wasm'));
			assert.deepEqual(identity(bytes), { bytes: test.program.bytes, sha256: test.program.sha256 }, 'Vector ABI program differs from qualification');
			checkWasm(bytes, `Vector ABI ${test.id}`, true);
			assert.deepEqual(inspectVectorAbi(bytes), test.abi, `Vector ABI ${test.id}: binary types/memory differ from qualification`);
			const module = new WebAssembly.Module(bytes);
			assert.deepEqual(WebAssembly.Module.imports(module), test.imports);
			assert.deepEqual(WebAssembly.Module.exports(module), test.exports);
		}
	}
	const linker = await fs.readFile(path.join(runtime, 'ld.wasm'));
	assert.deepEqual(identity(linker), { bytes: runtimeReceipt.linker.bytes, sha256: runtimeReceipt.linker.sha256 });
	assert.equal(runtimeReceipt.linker.commit, runtimeLock.browserLinker.commit);
	assert.equal(runtimeReceipt.linker.archiveSha256, runtimeLock.browserLinker.archiveSha256);
	const llvmProofs = new Map();
	for (const [name, pin] of [['llvm-producer.json', 'producerManifestSha256'], ['llvm-toolchain.json', 'toolchainReceiptSha256']]) {
		const bytes = await fs.readFile(path.join(runtime, name));
		assert.deepEqual(identity(bytes), runtimeReceipt.provenance?.[name], `LLVM provenance changed after import: ${name}`);
		assert.equal(identity(bytes).sha256, runtimeLock.browserLinker[pin], `LLVM provenance differs from the locked original: ${name}`);
		llvmProofs.set(name, bytes);
	}
	checkWasm(linker, 'WASI wasm-ld', true);
	const linkerModule = new WebAssembly.Module(linker);
	assert(WebAssembly.Module.imports(linkerModule).every((i) => i.module === 'wasi_snapshot_preview1'), 'Linker must use only WASI Preview 1 imports');
	assert(WebAssembly.Module.exports(linkerModule).some((e) => e.name === 'memory' && e.kind === 'memory'), 'WASI linker has no exported memory');
	assert(WebAssembly.Module.exports(linkerModule).some((e) => e.name === '_start'), 'Linker has no WASI entry point');

	const gccDirectory = `lib/gcc/wasm32-wasi/${lock.gcc.version}`;
	for (const f of compilerFiles.filter((f) => f.path.startsWith('resource-include/'))) {
		sysroot.push({ path: `${gccDirectory}/include/${f.path.slice('resource-include/'.length)}`, bytes: f.bytes });
	}
	if (simdHeaderProof) {
		const report = JSON.parse(simdHeaderProof);
		const sdk = path.resolve(path.dirname(nativeLinker), '..');
		const gccHeaders = path.join(work, 'gcc-native/gcc/include');
		const clangHeaders = path.join(sdk, 'lib/clang/22/include');
		const sourceHeader = await fs.readFile(path.join(work, 'gcc/gcc/config/wasm/wasm_simd128.h'));
		const installedHeader = await fs.readFile(path.join(gccHeaders, 'wasm_simd128.h'));
		const sourceLicenses = Object.fromEntries(await Promise.all(['COPYING3', 'COPYING.RUNTIME'].map(async name => [name, await fs.readFile(path.join(work, 'gcc', name))])));
		verifySimdHeaderInstallation({
			source: sourceHeader, installed: installedHeader,
			browser: compilerFiles.find(file => file.path === 'resource-include/wasm_simd128.h')?.bytes,
			packaged: sysroot.find(file => file.path === `${gccDirectory}/include/wasm_simd128.h`)?.bytes,
			licenses: sourceLicenses,
			packagedLicenses: Object.fromEntries(['COPYING3', 'COPYING.RUNTIME'].map(name => [name, compilerFiles.find(file => file.path === `licenses/gcc-${name}`)?.bytes]))
		});
		const indexed = files => Object.fromEntries(files.map(file => [file.path, identity(file.bytes)]));
		const toolPaths = { gcc: path.join(work, 'gcc-native/gcc/cc1'), gccCpp: path.join(work, 'gcc-native/gcc/cc1plus'),
			clang: path.join(sdk, 'bin/clang'), clangCpp: path.join(sdk, 'bin/clang++'),
			assembler: path.join(work, 'wabt-native/wat2wasm'), objdump: path.join(work, 'wabt-native/wasm-objdump'),
			linker: nativeLinker, node: process.execPath, validator: path.join(work, 'wabt-native/wasm-validate') };
		const expected = {
			cases: headerCases, disabledCases: headerDisabledCases, diagnosticCases: headerDiagnosticCases,
			sourceLock: identity(lockBytes), gccSource: nativeReceipt.gccSource, targetSource,
			tools: Object.fromEntries(await Promise.all(Object.entries(toolPaths).map(async ([name, file]) => [name, identity(await fs.readFile(file))]))),
			// An independently imported target sysroot may have another path. Its
			// complete bytes must equal this package's current imported headers;
			// the gate also reopens the original qualification root below.
			headerRoots: { gcc: gccHeaders, clang: clangHeaders, target: report.headerRoots?.target },
			headers: { gcc: indexed(await readNativeTree(gccHeaders)), clang: indexed(await readNativeTree(clangHeaders)), target: indexed(runtimeHeaders) },
			runtime: Object.fromEntries(['crt1-command.o', 'libc.a', 'libm.a', 'libclang_rt.builtins-wasm32.a'].map(name => [name, identity(sysroot.find(file => file.path === `lib/wasm32-wasi/${name}`).bytes)])),
			publicHeader: { source: identity(sourceHeader), installed: identity(installedHeader), clangReference: identity(await fs.readFile(path.join(clangHeaders, 'wasm_simd128.h'))) },
			licenses: Object.fromEntries(Object.entries(sourceLicenses).map(([name, bytes]) => [name, identity(bytes)])),
			fixtureDependencies: { 'simd-conversions-fixtures.mjs': identity(await fs.readFile(path.join(here, 'simd-conversions-fixtures.mjs'))) }
		};
		assert(path.isAbsolute(expected.headerRoots.target), 'Missing absolute qualified target header root');
		for (const [field, name] of [['fixtures', 'simd-header-fixtures.mjs'], ['apiContract', 'simd-header-api.mjs'], ['testRecipe', 'test-simd-header.mjs'], ['inspectionRecipe', 'simd-conversions-inspect.mjs'], ['gateRecipe', 'simd-header-qualification.mjs']])
			expected[field] = identity(await fs.readFile(path.join(here, name)));
		assert.equal(expected.tools.gcc.sha256, nativeReceipt.tools.cc1.sha256, 'Header gate GCC differs from native build');
		assert.equal(expected.tools.gccCpp.sha256, nativeReceipt.tools.cc1plus.sha256, 'Header gate C++ compiler differs from native build');
		await reopenSimdHeaderQualification(report, simdHeaderQualification, expected);
	}
	if (simdRelaxedProof) {
		const report = JSON.parse(simdRelaxedProof);
		const gccHeaders = path.join(work, 'gcc-native/gcc/include');
		const sourceHeader = await fs.readFile(path.join(work, 'gcc/gcc/config/wasm/wasm_relaxed_simd.h'));
		const installedHeader = await fs.readFile(path.join(gccHeaders, 'wasm_relaxed_simd.h'));
		const sourceLicenses = Object.fromEntries(await Promise.all(['COPYING3', 'COPYING.RUNTIME'].map(async name => [name, await fs.readFile(path.join(work, 'gcc', name))])));
		verifyRelaxedSimdHeaderInstallation({
			source: sourceHeader, installed: installedHeader,
			browser: compilerFiles.find(file => file.path === 'resource-include/wasm_relaxed_simd.h')?.bytes,
			packaged: sysroot.find(file => file.path === `${gccDirectory}/include/wasm_relaxed_simd.h`)?.bytes,
			licenses: sourceLicenses,
			packagedLicenses: Object.fromEntries(['COPYING3', 'COPYING.RUNTIME'].map(name => [name, compilerFiles.find(file => file.path === `licenses/gcc-${name}`)?.bytes]))
		});
		const indexed = files => Object.fromEntries(files.map(file => [file.path, identity(file.bytes)]));
		const toolPaths = { gcc: path.join(work, 'gcc-native/gcc/cc1'), gccCpp: path.join(work, 'gcc-native/gcc/cc1plus'),
			assembler: path.join(work, 'wabt-native/wat2wasm'), objdump: path.join(work, 'wabt-native/wasm-objdump'),
			linker: nativeLinker, node: process.execPath, validator: path.join(work, 'wabt-native/wasm-validate') };
		const expected = {
			cases: relaxedCases, disabledCases: relaxedDisabledCases, diagnosticCases: relaxedDiagnosticCases,
			sourceLock: identity(lockBytes), gccSource: nativeReceipt.gccSource, targetSource,
			sourcePath: path.join(work, 'gcc'), nativeBuild: identity(nativeReceiptBytes),
			tools: Object.fromEntries(await Promise.all(Object.entries(toolPaths).map(async ([name, file]) => [name, identity(await fs.readFile(file))]))),
			headerRoots: { gcc: gccHeaders, target: report.headerRoots?.target },
			headers: { gcc: indexed(await readNativeTree(gccHeaders)), target: indexed(runtimeHeaders) },
			runtime: Object.fromEntries(['crt1-command.o', 'libc.a', 'libm.a', 'libclang_rt.builtins-wasm32.a'].map(name => [name, identity(sysroot.find(file => file.path === `lib/wasm32-wasi/${name}`).bytes)])),
			publicHeader: { source: identity(sourceHeader), installed: identity(installedHeader) },
			licenses: Object.fromEntries(Object.entries(sourceLicenses).map(([name, bytes]) => [name, identity(bytes)]))
		};
		assert(path.isAbsolute(expected.headerRoots.target), 'Missing absolute qualified relaxed SIMD target header root');
		for (const [field, name] of [['fixtures', 'simd-relaxed-fixtures.mjs'], ['testRecipe', 'test-simd-relaxed.mjs'], ['inspectionRecipe', 'simd-relaxed-inspect.mjs'], ['gateRecipe', 'simd-relaxed-qualification.mjs'], ['sourceRecipe', 'prepare-source.py'], ['buildRecipe', 'build-native.sh'], ['featureRecipe', 'inspect-target-features.mjs']])
			expected[field] = identity(await fs.readFile(path.join(here, name)));
		assert.equal(expected.tools.gcc.sha256, nativeReceipt.tools.cc1.sha256, 'Relaxed SIMD gate GCC differs from native build');
		assert.equal(expected.tools.gccCpp.sha256, nativeReceipt.tools.cc1plus.sha256, 'Relaxed SIMD gate C++ compiler differs from native build');
		await reopenRelaxedSimdQualification(report, simdRelaxedQualification, expected);
	}
	let simdRelaxedDriverReplay;
	if (simdRelaxedDriverProof) {
		assert(simdRelaxedProof, 'Relaxed SIMD driver gate requires the full compiler qualification');
		const compiler = path.join(work, 'gcc-native/gcc');
		const indexed = files => Object.fromEntries(files.map(file => [file.path, identity(file.bytes)]));
		const tools = Object.fromEntries(await Promise.all(Object.entries({
			xgcc: path.join(compiler, 'xgcc'), cc1: path.join(compiler, 'cc1'), cc1plus: path.join(compiler, 'cc1plus'),
			assembler: path.join(work, 'wabt-native/wat2wasm'), objdump: path.join(work, 'wabt-native/wasm-objdump')
		}).map(async ([name, file]) => [name, identity(await fs.readFile(file))])));
		const recipes = Object.fromEntries(await Promise.all(Object.entries({
			driver: 'test-simd-relaxed-driver.py', native: 'build-native.sh',
			gate: 'simd-relaxed-driver-qualification.mjs', features: 'inspect-target-features.mjs'
		}).map(async ([name, file]) => [name, identity(await fs.readFile(path.join(here, file)))])));
		simdRelaxedDriverReplay = await reopenRelaxedSimdDriverQualification(JSON.parse(simdRelaxedDriverProof), simdRelaxedDriverQualification, {
			work, sysroot: path.join(runtime, 'sysroot'), sourceLock: identity(lockBytes), gccSource: nativeReceipt.gccSource,
			nativeBuild: identity(nativeReceiptBytes), tools, recipes, targetSource,
			specs: { overlay: nativeDriverSpecs, default: identity(await fs.readFile(path.join(compiler, 'specs'))) },
			headers: { gcc: indexed(await readNativeTree(path.join(compiler, 'include'))),
				fixed: indexed(await readNativeTree(path.join(compiler, 'include-fixed'))), target: indexed(runtimeHeaders) }
		});
	}
	let stdReceipt;
	const runtimeProofs = new Map();
	if (libstdcxx) {
		stdReceipt = await readJson(path.join(libstdcxx, 'libstdcxx-build.json'));
		assert.equal(stdReceipt.status, 'passed', 'libstdc++ must pass native GCC qualification before packaging');
		assert.equal(stdReceipt.gccCommit, lock.gcc.commit);
		assert.equal(stdReceipt.target, 'wasm32-wasi');
		for (const field of ['buildReceipt', 'qualification']) {
			const proof = stdReceipt[field];
			const bytes = await fs.readFile(path.join(libstdcxx, relativePath(proof.path)));
			assert.deepEqual(identity(bytes), { bytes: proof.bytes, sha256: proof.sha256 }, `libstdc++ ${field} differs from qualification`);
			runtimeProofs.set(`libstdcxx-${field}.json`, bytes);
		}
		const build = JSON.parse(runtimeProofs.get('libstdcxx-buildReceipt.json'));
		const qualification = JSON.parse(runtimeProofs.get('libstdcxx-qualification.json'));
		assert.equal(build.status, 'built-unverified');
		assert.equal(build.gccCommit, lock.gcc.commit);
		assert.equal(build.target, 'wasm32-wasi');
		assert.equal(qualification.status, 'passed');
		assert.equal(qualification.gccCommit, lock.gcc.commit);
		assert.equal(qualification.target, 'wasm32-wasi');
		assert.deepEqual(qualification.buildReceipt, identity(runtimeProofs.get('libstdcxx-buildReceipt.json')), 'libstdc++ qualification covers a different build');
		assert.deepEqual(build.gccSource, compilerReceipt.gccSource, 'libstdc++ was built with different GCC patches');
		assert.deepEqual(build.nativeCompiler, Object.fromEntries(Object.entries(nativeReceipt.tools).map(([name, tool]) => [name, tool.sha256])), 'libstdc++ was built with a different native GCC');
		assert(nativeLinker, 'Typed GNU runtime qualification requires --native-linker');
		const math = build.typedMathProbes;
		assert(math, 'GNU runtime lacks typed math qualification');
		const mathRecipe = await fs.readFile(path.join(here, 'fp-extension-math-probe.py'));
		assert.deepEqual(math.recipe, identity(mathRecipe), 'Typed math recipe changed after the GNU build');
		const mathReport = await fs.readFile(path.join(libstdcxx, 'math-probes/report.json'));
		assert.deepEqual(math.report, identity(mathReport), 'Typed math report differs from the GNU build');
		assert.deepEqual(JSON.parse(mathReport), math.evidence);
		const mathCache = await fs.readFile(path.join(libstdcxx, 'math-probes/config.site'));
		assert.deepEqual(math.cache, identity(mathCache), 'Typed math cache differs from the GNU build');
		const mathHeaders = async root => Object.fromEntries(inventory(await readNativeTree(root)).map(({ path: name, ...receipt }) => [name, receipt]));
		verifyTypedMathProbes(math.evidence, {
			...Object.fromEntries(await Promise.all([['linkage', 'linkage.m4'], ['float', 'src/c++98/math_stubs_float.cc'], ['long_double', 'src/c++98/math_stubs_long_double.cc']].map(async ([name, file]) => [name, identity(await fs.readFile(path.join(work, 'gcc/libstdc++-v3', file)))]))),
			recipe: identity(mathRecipe), compiler: identity(await fs.readFile(path.join(work, 'gcc-native/gcc/cc1'))),
			assembler: identity(await fs.readFile(path.join(work, 'wabt-native/wat2wasm'))),
			linker: identity(await fs.readFile(nativeLinker)),
			...Object.fromEntries([['crt', 'crt1-command.o'], ['libc', 'libc.a'], ['libm', 'libm.a'], ['builtins', 'libclang_rt.builtins-wasm32.a']].map(([name, archive]) => [name, identity(sysroot.find(file => file.path === `lib/wasm32-wasi/${archive}`).bytes)]))
		}, {
			gcc: await mathHeaders(path.join(work, 'gcc-native/gcc/include')),
			target: { 'wasm32-wasi/__errno.h': identity(sysroot.find(file => file.path === 'include/wasm32-wasi/__errno.h').bytes) },
			sdk: await mathHeaders(path.join(path.resolve(path.dirname(nativeLinker), '..'), 'share/wasi-sysroot/include'))
		});
		for (const entry of math.evidence.cases)
			assert(mathCache.toString().includes(`ac_cv_func_${entry.function}=${entry.available ? 'yes' : 'no'}\n`), 'Typed math cache does not match measured availability');
		for (const artifact of math.evidence.artifacts) {
			const bytes = await fs.readFile(artifact.path);
			assert.deepEqual(identity(bytes), { bytes: artifact.bytes, sha256: artifact.sha256 }, 'Typed math artifact changed');
			if (artifact.path.endsWith('/probe.wasm')) checkWasm(bytes, 'Typed math link probe', true);
		}
		runtimeProofs.set('fp-extension-math-probe.py', mathRecipe);
		runtimeProofs.set('typed-math-link-probes.json', mathReport);
		runtimeProofs.set('typed-math-config.site', mathCache);
		for (const [field, name] of [['recipe', 'build-libstdcxx.sh'], ['patch', 'patches/libstdcxx-wasi-config.patch']]) {
			const bytes = await fs.readFile(path.join(here, name));
			assert.deepEqual(build[field], identity(bytes), `libstdc++ ${field} changed after building`);
			assert.deepEqual(stdReceipt[field], build[field]);
			runtimeProofs.set(path.basename(name), bytes);
		}
		verifyRttiRuntimeProfile(build, stdReceipt, Boolean(rttiProof), qualification);
		const errnoPatch = identity(await fs.readFile(path.join(here, 'patches/wasi-libc-errno.patch')));
		const errnoHeader = identity(sysroot.find((f) => f.path === 'include/wasm32-wasi/__errno.h').bytes);
		for (const receipt of [build, stdReceipt]) {
			assert.deepEqual(receipt.errnoPatch, errnoPatch, 'libstdc++ errno port differs from the packaged runtime');
			assert.deepEqual(receipt.errnoHeader, errnoHeader, 'libstdc++ errno ABI differs from the packaged sysroot');
		}
		const files = await readNativeTree(path.join(libstdcxx, 'sysroot'));
		verifyInventory(files, stdReceipt.files, 'GNU libstdc++');
		for (const name of ['libstdc++.a', 'libsupc++.a']) {
			const archive = files.find((f) => f.path === `lib/wasm32-wasi/${name}`);
			assert(archive, `GNU runtime archive missing: ${name}`);
			assert.deepEqual(identity(archive.bytes), build.libraries[name], `GNU runtime archive differs from the build: ${name}`);
		}
		for (const required of ['lib/wasm32-wasi/libstdc++.a', `include/c++/${lock.gcc.version}/vector`, `include/c++/${lock.gcc.version}/wasm32-wasi/bits/c++config.h`])
			assert(files.some((f) => f.path === required), `GNU libstdc++ missing ${required}`);
		sysroot.push(...files);
	}
	// Admit the runtime and native-width compiler independently, then bind both
	// to the same source and native compiler before advertising the profile.
	let validatedLibatomic;
	const libatomicProvenance = new Map(), libatomicLicenses = [];
	if (libatomicProof) {
		const sdk = path.resolve(path.dirname(nativeLinker), '..');
		const buildBytes = await fs.readFile(path.join(libatomic, 'build.json'));
		const context = { work, sdk, sysroot: path.join(runtime, 'sysroot'), libatomic,
			gccSource: nativeReceipt.gccSource, sourceLockSha256: identity(lockBytes).sha256,
			nativeBuild: { path: path.join(work, 'native-build.json'), ...identity(nativeReceiptBytes) } };
		const build = await reopenLibatomicBuild(libatomic, context);
		assert.deepEqual(identity(buildBytes), { bytes: build.build.bytes, sha256: build.build.sha256 }, 'GNU libatomic build proof changed during packaging');
		const execution = await reopenLibatomicExecutionQualification(JSON.parse(libatomicProof), path.resolve(libatomicQualification),
			{ ...context, archive: build.archive });
		assert.deepEqual(identity(libatomicProof), { bytes: execution.qualification.bytes, sha256: execution.qualification.sha256 }, 'GNU libatomic execution proof changed during packaging');
		validatedLibatomic = { build, execution, archive: build.archive,
			runtimeLibrary: '/sysroot/lib/wasm32-wasi/libatomic.a' };
		const files = await readNativeTree(path.join(libatomic, 'sysroot'));
		const licenses = await readNativeTree(path.join(libatomic, 'licenses'));
		verifyLibatomicInstallation(sysroot, files, licenses, validatedLibatomic);
		sysroot.push(...files);
		libatomicLicenses.push(...licenses.map(file => ({ path: `licenses/libatomic/${file.path}`, bytes: file.bytes })));
		libatomicProvenance.set('libatomic-build.json', buildBytes);
		libatomicProvenance.set('native-libatomic-qualification.json', libatomicProof);
		libatomicProvenance.set('libatomic-validated-runtime.json', json(validatedLibatomic));
		for (const [name, record] of [['libatomic-build-replay.json', build.replay], ['native-libatomic-replay.json', execution.replay]]) {
			const bytes = await fs.readFile(record.path);
			assert.deepEqual(identity(bytes), { bytes: record.bytes, sha256: record.sha256 }, `Changed ${name}`);
			libatomicProvenance.set(name, bytes);
		}
		for (const name of ['build-libatomic.py', 'libatomic-fixtures.mjs', 'libatomic-shared-fixtures.mjs',
			'test-libatomic.mjs', 'run-libatomic-shared.mjs', 'atomics-native-fixtures.mjs',
			'libatomic-qualification.mjs', 'libatomic-execution-qualification.mjs'])
			libatomicProvenance.set(name, await fs.readFile(path.join(here, name)));
	}
	let validatedAtomics;
	const atomicsProvenance = new Map();
	if (atomicsProof) {
		assert(validatedLibatomic, 'Atomics require the qualified GNU runtime');
		validatedAtomics = await reopenNativeAtomicsQualification(path.resolve(atomicsQualification), {
			work, sdk: path.resolve(path.dirname(nativeLinker), '..'), gccSource: nativeReceipt.gccSource,
			sourceLockSha256: identity(lockBytes).sha256, nativeBuild: identity(nativeReceiptBytes)
		});
		assert.deepEqual(identity(atomicsProof), { bytes: validatedAtomics.qualification.bytes, sha256: validatedAtomics.qualification.sha256 }, 'Native atomics proof changed during packaging');
		atomicsProvenance.set('native-atomics-qualification.json', atomicsProof);
		atomicsProvenance.set('native-atomics-validated.json', json(validatedAtomics));
		const original = JSON.parse(atomicsProof);
		const records = [['native-atomics-driver.json', original.driver], ['native-atomics-shared.json', original.shared],
			['native-atomics-replay.json', validatedAtomics.replay]];
		for (const [name, record] of records) {
			const bytes = await fs.readFile(record.path);
			assert.deepEqual(identity(bytes), { bytes: record.bytes, sha256: record.sha256 }, `Changed ${name}`);
			atomicsProvenance.set(name, bytes);
		}
		for (const name of ['atomics-qualification.mjs', 'test-atomics-native.py', 'atomics-native-probe.c',
			'test-atomics-shared-native.py', 'atomics-native-fixtures.mjs'])
			atomicsProvenance.set(name, await fs.readFile(path.join(here, name)));
	}
	const atomicsProfile = qualifiedAtomicsManifestProfile(validatedAtomics, validatedLibatomic);
	let validatedTlsNative, validatedTlsRuntime;
	const tlsProvenance = new Map(), tlsLicenses = [];
	if (tlsProof && tlsRuntimeProof) {
		const { reopenTlsRuntimeBuild, reopenTlsRuntimeExecutionQualification } = await import('./tls-runtime-qualification.mjs');
		const context = { work, sdk: path.resolve(path.dirname(nativeLinker), '..'),
			sysroot: path.join(runtime, 'sysroot'), gccCxxSysroot: path.join(libstdcxx, 'sysroot'), tlsRuntime, tlsLibc,
			gccSource: nativeReceipt.gccSource, sourceLockSha256: identity(lockBytes).sha256,
			nativeBuild: { path: path.join(work, 'native-build.json'), ...identity(nativeReceiptBytes) } };
		validatedTlsNative = await reopenNativeTlsQualification(path.resolve(tlsQualification), context);
		assert.deepEqual(identity(tlsProof), { bytes: validatedTlsNative.qualification.bytes, sha256: validatedTlsNative.qualification.sha256 }, 'Native TLS proof changed during packaging');
		const buildBytes = await fs.readFile(path.join(tlsRuntime, 'build.json'));
		const build = await reopenTlsRuntimeBuild(tlsRuntime, context);
		assert.deepEqual(identity(buildBytes), { bytes: build.build.bytes, sha256: build.build.sha256 }, 'TLS runtime build proof changed during packaging');
		const execution = await reopenTlsRuntimeExecutionQualification(JSON.parse(tlsRuntimeProof), path.resolve(tlsRuntimeQualification),
			{ ...context, runtimeBuild: build.build, files: build.files });
		assert.deepEqual(identity(tlsRuntimeProof), { bytes: execution.qualification.bytes, sha256: execution.qualification.sha256 }, 'TLS runtime execution proof changed during packaging');
		validatedTlsRuntime = { native: validatedTlsNative, build, execution };
		const files = await readNativeTree(path.join(tlsRuntime, 'sysroot'));
		const licenses = await readNativeTree(path.join(tlsRuntime, 'licenses'));
		verifyTlsInstallation(sysroot, files, licenses, validatedTlsRuntime);
		sysroot.push(...files);
		tlsLicenses.push(...licenses.map(file => ({ path: `licenses/tls-runtime/${file.path}`, bytes: file.bytes })));
		tlsProvenance.set('native-tls-qualification.json', tlsProof);
		tlsProvenance.set('native-tls-validated.json', json(validatedTlsNative));
		tlsProvenance.set('tls-runtime-build.json', buildBytes);
		tlsProvenance.set('tls-runtime-qualification.json', tlsRuntimeProof);
		tlsProvenance.set('tls-runtime-validated.json', json(validatedTlsRuntime));
		const original = JSON.parse(tlsProof);
		for (const [name, record] of [['native-tls-driver.json', original.driver], ['native-tls-shared.json', original.shared],
			['native-tls-replay.json', validatedTlsNative.replay], ['tls-runtime-build-replay.json', build.replay],
			['tls-runtime-execution-replay.json', execution.replay],
			['tls-libc-build.json', build.privateLibc.build], ['tls-libc-replay.json', build.privateLibc.replay]]) {
			const bytes = await fs.readFile(record.path);
			assert.deepEqual(identity(bytes), { bytes: record.bytes, sha256: record.sha256 }, `Changed ${name}`);
			tlsProvenance.set(name, bytes);
		}
		for (const name of ['tls-native-qualification.mjs', 'tls-native-check.py', 'tls-native-probe.c',
			'tls-native-shared-check.py', 'tls-native-fixtures.mjs', 'tls-inspect.mjs', 'tls-assembly-replay.mjs',
			'run-tls-shared.mjs', 'run-tls-runtime-program.mjs',
			'build-tls-runtime.py', 'build-tls-libc.py', 'tls-libc-qualification.mjs',
			'test-tls-runtime.mjs', 'tls-runtime-fixtures.mjs', 'tls-runtime-qualification.mjs'])
			tlsProvenance.set(name, await fs.readFile(path.join(here, name)));
	}
	const tlsProfile = qualifiedTlsManifestProfile(validatedTlsNative, validatedTlsRuntime);
	let validatedExceptionNative, validatedExceptionRuntime;
	const exceptionProvenance = new Map(), exceptionLicenses = [];
	if (exceptionProof && exceptionRuntimeProof) {
		const { reopenNativeExceptionQualification } = await import('./eh-native-qualification.mjs');
		const { reopenExceptionRuntimeBuild, reopenExceptionRuntimeQualification } = await import('./eh-runtime-qualification.mjs');
		const context = { work, sdk: path.resolve(path.dirname(nativeLinker), '..'),
			sysroot: path.join(runtime, 'sysroot'), gccCxxSysroot: path.join(libstdcxx, 'sysroot'), runtime: ehRuntime,
			gccSource: nativeReceipt.gccSource, sourceLockSha256: identity(lockBytes).sha256,
			nativeBuild: { path: path.join(work, 'native-build.json'), ...identity(nativeReceiptBytes) } };
		validatedExceptionNative = await reopenNativeExceptionQualification(path.resolve(ehQualification), context);
		assert.deepEqual(identity(await fs.readFile(ehQualification)), identity(exceptionProof), 'Native exception proof changed during packaging');
		const buildBytes = await fs.readFile(path.join(ehRuntime, 'build.json'));
		const build = await reopenExceptionRuntimeBuild(ehRuntime, context);
		assert.deepEqual(identity(buildBytes), { bytes: build.build.bytes, sha256: build.build.sha256 }, 'Exception runtime build proof changed during packaging');
		const execution = await reopenExceptionRuntimeQualification(path.resolve(ehRuntimeQualification), { ...context, runtimeBuild: build.build });
		assert.deepEqual(identity(exceptionRuntimeProof), { bytes: execution.qualification.bytes, sha256: execution.qualification.sha256 }, 'Exception runtime execution proof changed during packaging');
		validatedExceptionRuntime = { native: validatedExceptionNative, build, execution };
		const files = await readNativeTree(path.join(ehRuntime, 'sysroot'));
		const licenses = await readNativeTree(path.join(ehRuntime, 'licenses'));
		verifyExceptionInstallation(sysroot, files, licenses, validatedExceptionRuntime, runtimeLock);
		sysroot.push(...files);
		exceptionLicenses.push(...licenses.map(file => ({ path: `licenses/exception-runtime/${file.path}`, bytes: file.bytes })));
		exceptionProvenance.set('native-exception-qualification.json', exceptionProof);
		exceptionProvenance.set('native-exception-validated.json', json(validatedExceptionNative));
		exceptionProvenance.set('exception-runtime-build.json', buildBytes);
		exceptionProvenance.set('exception-runtime-qualification.json', exceptionRuntimeProof);
		exceptionProvenance.set('exception-runtime-validated.json', json(validatedExceptionRuntime));
		const original = JSON.parse(exceptionProof);
		for (const [name, record] of [['native-exception-compiler.json', original.compiler],
			['native-exception-driver.json', original.driver], ['native-exception-replay.json', validatedExceptionNative.replay.report],
			['exception-runtime-build-replay.json', build.replay], ['exception-runtime-execution-replay.json', execution.replay]]) {
			const bytes = await fs.readFile(record.path);
			assert.deepEqual(identity(bytes), { bytes: record.bytes, sha256: record.sha256 }, `Changed ${name}`);
			exceptionProvenance.set(name, bytes);
		}
		for (const name of ['eh-native-qualification.mjs', 'eh-native-check.py', 'eh-native-driver-check.py',
			'eh-native-fixtures.mjs', 'eh-assembly-replay.mjs', 'eh-runtime-qualification.mjs',
			'eh-runtime-fixtures.mjs', 'eh-library-fixtures.mjs', 'eh-runtime-build-state.py', 'test-eh-runtime.py',
			'build-libstdcxx.sh', 'patches/libstdcxx-wasi-eh-config.patch'])
			exceptionProvenance.set(name, await fs.readFile(path.join(here, name)));
	}
	const exceptionProfile = qualifiedExceptionManifestProfile(validatedExceptionNative, validatedExceptionRuntime);
	let libgcovBuildBytes, coverageAnalysisBytes;
	if (coverageProof) {
		assert(libgcov && nativeGcov && nativeLinker && libstdcxx, 'Coverage requires its runtime, analysis tool, linker and GNU runtime');
		libgcovBuildBytes = await fs.readFile(path.join(libgcov, 'build.json'));
		const build = JSON.parse(libgcovBuildBytes);
		const files = await readNativeTree(path.join(libgcov, 'sysroot'));
		verifyInventory(files, build.files, 'Official libgcov runtime');
		const libraries = Object.fromEntries(files.map(file => [path.basename(file.path), identity(file.bytes)]));
		assert.deepEqual(libraries['libwasi-emulated-getpid.a'], runtimeLock.coverage.sdkLibraries['libwasi-emulated-getpid.a'], 'Coverage getpid archive differs from its pin');
		const sdkRoot = path.resolve(path.dirname(nativeLinker), '..');
		const fileIdentity = async file => ({ path: file, ...identity(await fs.readFile(file)) });
		const tools = Object.fromEntries(await Promise.all(Object.entries({
			assembler: path.join(work, 'wabt-native/wat2wasm'), validator: path.join(work, 'wabt-native/wasm-validate'),
			ar: path.join(sdkRoot, 'bin/llvm-ar'), nm: path.join(sdkRoot, 'bin/llvm-nm'),
			ranlib: path.join(sdkRoot, 'bin/llvm-ranlib'), linker: nativeLinker
		}).map(async ([name, file]) => [name, await fileIdentity(file)])));
		const recipes = Object.fromEntries(await Promise.all(['build-libgcov.sh', 'build-libgcov.py', 'prepare-source.py']
			.map(async name => [name, await fileIdentity(path.join(here, name))])));
		const nativeCompiler = Object.fromEntries(await Promise.all(['cc1', 'cc1plus', 'xgcc']
			.map(async name => [name, await fileIdentity(path.join(work, 'gcc-native/gcc', name))])));
		const sources = Object.fromEntries(await Promise.all(['libgcov-driver.c', 'libgcov-merge.c']
			.map(async name => [name, await fileIdentity(path.join(work, 'gcc/libgcc', name))])));
		const libc = Object.fromEntries(['crt1-command.o', 'libc.a', 'libm.a', 'libclang_rt.builtins-wasm32.a']
			.map(name => [name, identity(sysroot.find(file => file.path === 'lib/wasm32-wasi/' + name).bytes)]));
		// Keep actual paths for exact compiler/include argument verification.
		for (const name of Object.keys(libc)) libc[name].path = path.join(runtime, 'sysroot/lib/wasm32-wasi', name);
		await reopenLibgcovBuild(build, { sourceLock: identity(lockBytes), runtimeLock: identity(runtimeLockBytes),
			nativeBuild: identity(nativeReceiptBytes), gccSource: nativeReceipt.gccSource, nativeCompiler, tools, recipes, sources, libraries, libc,
			runtimeImport: identity(await fs.readFile(path.join(runtime, 'runtime-build.json'))),
			getpid: runtimeLock.coverage.sdkLibraries['libwasi-emulated-getpid.a'] });
		sysroot.push(...files);
		const coverageTools = Object.fromEntries(await Promise.all(Object.entries({
			gcc: nativeCompiler.cc1.path, gccCpp: nativeCompiler.cc1plus.path, xgcc: nativeCompiler.xgcc.path,
			assembler: tools.assembler.path, validator: tools.validator.path,
			objdump: path.join(work, 'wabt-native/wasm-objdump'), linker: nativeLinker,
			ar: tools.ar.path, nm: tools.nm.path, gcov: nativeGcov,
			gcovDump: path.join(path.dirname(nativeGcov), 'gcov-dump'), node: process.execPath
		}).map(async ([name, file]) => [name, await fileIdentity(file)])));
		const coverageRecipes = Object.fromEntries(await Promise.all(['test-coverage.mjs', 'coverage-fixtures.mjs',
			'coverage-inspect.mjs', 'symbol-alias-inspect.mjs', 'inspect-vector-abi.mjs', 'prepare-source.py',
			'build-native.sh', 'build-wabt.sh', 'build-libgcov.sh', 'build-libgcov.py', 'runtime.lock.json']
			.map(async name => [name, await fileIdentity(path.join(here, name))])));
		const headerRoots = { gcc: path.join(work, 'gcc-native/gcc/include'),
			target: path.join(runtime, 'sysroot/include'), gnu: path.join(libstdcxx, 'sysroot/include') };
		const headers = Object.fromEntries(await Promise.all(Object.entries(headerRoots).map(async ([name, root]) =>
			[name, (await readNativeTree(root)).map(file => ({ path: path.join(root, file.path), ...identity(file.bytes) }))])));
		const gnuVersion = path.join(headerRoots.gnu, 'c++', lock.gcc.version);
		const coverageArchives = Object.fromEntries(await Promise.all(Object.entries({
			crt: 'crt1-command.o', libc: 'libc.a', libm: 'libm.a', builtins: 'libclang_rt.builtins-wasm32.a',
			libstdcxx: 'libstdc++.a', libsupcxx: 'libsupc++.a', libgcov: 'libgcov.a', getpid: 'libwasi-emulated-getpid.a'
		}).map(async ([name, filename]) => {
			const root = ['libstdcxx', 'libsupcxx'].includes(name) ? libstdcxx : ['libgcov', 'getpid'].includes(name) ? libgcov : runtime;
			return [name, await fileIdentity(path.join(root, 'sysroot/lib/wasm32-wasi', filename))];
		})));
		const report = JSON.parse(coverageProof);
		await reopenCoverageQualification(report, {
			sourceLock: identity(lockBytes), nativeBuild: { path: path.join(work, 'native-build.json'), ...identity(nativeReceiptBytes) }, gccSource: nativeReceipt.gccSource,
			assemblerSource: asReceipt.source, assemblerProvenance: await fileIdentity(path.join(work, 'wabt-native/provenance.json')),
			tools: coverageTools, recipes: coverageRecipes, fixtures: coverageRecipes['coverage-fixtures.mjs'],
			runner: identity(Buffer.from(coverageRunnerSource)),
			analysisTools: { sources: Object.fromEntries(await Promise.all(['gcov.cc', 'gcov-dump.cc', 'gcov-io.cc', 'gcov-io.h', 'gcov-counter.def']
				.map(async name => [name, await fileIdentity(path.join(work, 'gcc/gcc', name))]))),
				buildMakefile: await fileIdentity(path.join(work, 'gcc-native/gcc/Makefile')) },
			runtime: { sysroot: path.join(runtime, 'sysroot'), gnuSysroot: path.join(libstdcxx, 'sysroot'),
				coverageRoot: libgcov, archives: coverageArchives, headerRoots, headers,
				gnuIncludePaths: [gnuVersion, path.join(gnuVersion, 'wasm32-wasi'), path.join(gnuVersion, 'backward'),
					headerRoots.gcc, path.join(headerRoots.target, 'wasm32-wasi')],
				importReceipt: await fileIdentity(path.join(runtime, 'runtime-build.json')),
				gnuBuild: await fileIdentity(path.join(libstdcxx, 'build.json')),
				gnuQualification: await fileIdentity(path.join(libstdcxx, 'qualification/qualification.json')),
				gnuReceipt: await fileIdentity(path.join(libstdcxx, 'libstdcxx-build.json')),
				coverageBuild: await fileIdentity(path.join(libgcov, 'build.json')) }
		});
		coverageAnalysisBytes = json({ format: 'gcc-gcov', gccCommit: lock.gcc.commit,
			versionWord: report.analysisTools.versionWord, jsonFormatVersion: report.analysisTools.jsonFormatVersion,
			gcov: coverageTools.gcov, gcovDump: coverageTools.gcovDump,
			sources: report.analysisTools.sources, nativeBuild: report.nativeBuild });
	}
	assert.equal(new Set(sysroot.map((f) => f.path)).size, sysroot.length, 'Duplicate merged sysroot path');
	if (dwarfProof) {
		const report = JSON.parse(dwarfProof);
		const sdkRoot = path.resolve(path.dirname(nativeLinker), '..');
		const fileIdentity = async file => ({ path: file, ...identity(await fs.readFile(file)) });
		const toolPaths = {
			gcc: path.join(work, 'gcc-native/gcc/cc1'), gccCpp: path.join(work, 'gcc-native/gcc/cc1plus'),
			assembler: path.join(work, 'wabt-native/wat2wasm'), objdump: path.join(work, 'wabt-native/wasm-objdump'),
			validator: path.join(work, 'wabt-native/wasm-validate'), linker: nativeLinker,
			llvmDwarf: path.join(sdkRoot, 'bin/llvm-dwarfdump'), symbolizer: path.join(sdkRoot, 'bin/llvm-symbolizer'),
			llvmObjdump: path.join(sdkRoot, 'bin/llvm-objdump'), objcopy: path.join(sdkRoot, 'bin/llvm-objcopy'),
			node: process.execPath, chromium: report.tools?.chromium?.path,
			gcov: nativeGcov, gcovDump: path.join(path.dirname(nativeGcov), 'gcov-dump')
		};
		const tools = Object.fromEntries(await Promise.all(Object.entries(toolPaths)
			.map(async ([name, file]) => [name, await fileIdentity(file)])));
		const recipes = Object.fromEntries(await Promise.all(['dwarf-fixtures.mjs', 'dwarf-fixtures.test.mjs',
			'dwarf-inspect.mjs', 'test-dwarf.mjs', 'prepare-source.py', 'build-native.sh', 'build-wabt.sh', 'runtime.lock.json',
			'coverage-fixtures.mjs', 'coverage-inspect.mjs', 'symbol-alias-inspect.mjs', 'inspect-vector-abi.mjs',
			'build-libgcov.sh', 'build-libgcov.py']
			.map(async name => [name, await fileIdentity(path.join(here, name))])));
		const headerRoots = { gcc: path.join(work, 'gcc-native/gcc/include'), target: path.join(runtime, 'sysroot/include'),
			gnu: path.join(libstdcxx, 'sysroot/include') };
		const headers = Object.fromEntries(await Promise.all(Object.entries(headerRoots).map(async ([name, root]) =>
			[name, (await readNativeTree(root)).map(file => ({ path: path.join(root, file.path), ...identity(file.bytes) }))])));
		const gnuVersion = path.join(headerRoots.gnu, 'c++', lock.gcc.version);
		const includeRoots = {
			c: [headerRoots.gcc, path.join(headerRoots.target, 'wasm32-wasi'), headerRoots.target],
			cpp: [gnuVersion, path.join(gnuVersion, 'wasm32-wasi'), path.join(gnuVersion, 'backward'),
				headerRoots.gcc, path.join(headerRoots.target, 'wasm32-wasi'), headerRoots.target]
		};
		const archives = Object.fromEntries(await Promise.all(Object.entries({ crt: 'crt1-command.o', libc: 'libc.a',
			libm: 'libm.a', libstdcxx: 'libstdc++.a', builtins: 'libclang_rt.builtins-wasm32.a',
			libgcov: 'libgcov.a', getpid: 'libwasi-emulated-getpid.a' }).map(async ([name, filename]) => {
			const root = name === 'libstdcxx' ? libstdcxx : ['libgcov', 'getpid'].includes(name) ? libgcov : runtime;
			return [name, await fileIdentity(path.join(root, 'sysroot/lib/wasm32-wasi', filename))];
		})));
		await reopenDwarfQualification(report, {
			sourceLock: identity(lockBytes), nativeBuild: identity(nativeReceiptBytes), gccSource: nativeReceipt.gccSource,
			wabtSource: asReceipt.source, assemblerBuild: await fileIdentity(path.join(work, 'wabt-native/provenance.json')),
			tools, recipes,
			analysisToolDependencies: await Promise.all(['libLLVM.so.22.1-wasi-sdk', 'libedit.so.0']
				.map(name => fileIdentity(path.join(sdkRoot, 'lib', name)))),
			runtime: { sysroot: path.join(runtime, 'sysroot'), gnuSysroot: path.join(libstdcxx, 'sysroot'),
				includeRoots, headers, archives, importReceipt: await fileIdentity(path.join(runtime, 'runtime-build.json')),
				gnuBuild: await fileIdentity(path.join(libstdcxx, 'build.json')),
				gnuQualification: await fileIdentity(path.join(libstdcxx, 'qualification/qualification.json')),
				coverageRoot: libgcov, coverageBuild: await fileIdentity(path.join(libgcov, 'build.json')),
				coverageAnalysis: {
					sources: Object.fromEntries(await Promise.all(['gcov.cc', 'gcov-dump.cc', 'gcov-io.cc', 'gcov-io.h', 'gcov-counter.def']
						.map(async name => [name, await fileIdentity(path.join(work, 'gcc/gcc', name))]))),
					buildMakefile: await fileIdentity(path.join(work, 'gcc-native/gcc/Makefile')),
					versionWord: 'B70 ', jsonFormatVersion: '2'
				} }
		});
	}
	for (const [proof, qualificationPath, fixtureName, harnessName, verify, label] of [
		[longDoubleProof, longDoubleQualification, 'long-double-fixtures.mjs', 'test-long-double.mjs', verifyLongDoubleQualification, 'Binary128'],
		[int128Proof, int128Qualification, 'int128-fixtures.mjs', 'test-int128.mjs', verifyInt128Qualification, 'Int128'],
		[gnuFloat128Proof, gnuFloat128Qualification, 'gnu-float128-fixtures.mjs', 'wide-integer-test.mjs', verifyGnuFloat128Qualification, 'GNU float128'],
		[emptyAbiProof, emptyAbiQualification, 'empty-abi-fixtures.mjs', 'test-empty-abi.mjs', verifyEmptyAbiQualification, 'Empty ABI'],
		[bitfieldProof, bitfieldQualification, 'wide-integer-bitfields-fixtures.mjs', 'wide-integer-test.mjs', verifyBitfieldQualification, 'Bitfield'],
		[anonymousBitfieldProof, anonymousBitfieldQualification, 'anonymous-bitfield-fixtures.mjs', 'wide-integer-test.mjs', verifyAnonymousBitfieldQualification, 'Anonymous bitfield'],
		[aliasProgramProof, aliasProgramPath, 'symbol-alias-fixtures.mjs', 'wide-integer-test.mjs', verifySymbolAliasPrograms, 'Symbol alias']
	]) {
		if (!proof) continue;
		const report = JSON.parse(proof);
		const suite = await import(new URL(fixtureName, import.meta.url));
		for (const tool of ['cc1', 'cc1plus'])
			assert.equal(identity(await fs.readFile(path.join(work, 'gcc-native/gcc', tool))).sha256, nativeReceipt.tools[tool].sha256, `${label} ${tool} differs from the compiler build receipt`);
		const indexed = files => Object.fromEntries(inventory(files).map(({ path: name, ...receipt }) => [name, receipt]));
		const sdkRoot = path.resolve(path.dirname(nativeLinker), '..');
		const languageOnly = label === 'Empty ABI' || label === 'Bitfield' || label === 'Anonymous bitfield';
		const runtimeFiles = {
			'crt1-command.o': 'crt1-command.o', 'libc.a': 'libc.a', 'libm.a': 'libm.a',
			builtins: 'libclang_rt.builtins-wasm32.a',
			...(suite.cases.some(fixture => fixture.printscan) ? { printscan: 'libc-printscan-long-double.a' } : {}),
			...(languageOnly ? {} : { gnuCpp: 'libstdc++.a', gnuAbi: 'libsupc++.a' })
		};
		const runtimeIdentities = Object.fromEntries(Object.entries(runtimeFiles).map(([name, archive]) => {
			const file = sysroot.find(file => file.path === `lib/wasm32-wasi/${archive}`);
			assert(file, `${label} runtime missing: ${archive}`);
			return [name, identity(file.bytes)];
		}));
		if (!languageOnly) for (const [name, archive] of [['clangCpp', 'libc++.a'], ['clangAbi', 'libc++abi.a']])
			runtimeIdentities[name] = identity(await fs.readFile(path.join(sdkRoot, 'share/wasi-sysroot/lib/wasm32-wasi/noeh', archive)));
		const recipes = {};
		for (const [name, file] of [['fixtures', fixtureName], ['harness', harnessName], ['inspector', 'inspect-vector-abi.mjs']])
			recipes[name] = identity(await fs.readFile(path.join(here, file)));
		if (languageOnly || label === 'GNU float128' || label === 'Symbol alias') recipes.sourceLock = identity(lockBytes);
		if (label === 'Empty ABI') recipes.build = identity(nativeReceiptBytes);
		const cxxPrefix = `include/c++/${lock.gcc.version}/`;
		verify(report, {
			gccCommit: lock.gcc.commit, targetSource, recipes,
			tools: {
				gcc: identity(await fs.readFile(path.join(work, 'gcc-native/gcc/cc1'))),
				gccCpp: identity(await fs.readFile(path.join(work, 'gcc-native/gcc/cc1plus'))),
				clang: identity(await fs.readFile(path.join(path.dirname(nativeLinker), 'clang'))),
				assembler: identity(await fs.readFile(path.join(work, 'wabt-native/wat2wasm'))),
				inspector: identity(await fs.readFile(path.join(work, 'wabt-native/wasm-objdump'))),
				linker: identity(await fs.readFile(nativeLinker)),
				node: identity(await fs.readFile(process.execPath))
			},
			runtime: runtimeIdentities,
			headers: {
				libc: indexed(runtimeHeaders),
				...(label === 'Empty ABI' ? {} : { clangLibc: indexed(await readNativeTree(path.join(sdkRoot, 'share/wasi-sysroot/include'))) }),
					clangResource: indexed(await readNativeTree(path.join(sdkRoot, 'lib/clang/22/include'))),
				gcc: indexed(await readNativeTree(path.join(work, 'gcc-native/gcc/include'))),
				...(languageOnly ? {} : { gnuCpp: indexed(sysroot.filter(file => file.path.startsWith(cxxPrefix)).map(file => ({ ...file, path: file.path.slice(cxxPrefix.length) }))) })
			}
		}, suite.cases);
		for (const test of report.cases) {
			const directory = path.join(path.dirname(qualificationPath), test.id);
			for (const [index, unit] of test.units.entries()) {
				for (const [kind, name] of [['object', `unit${index}.o`], ['assembly', `unit${index}.${unit.compiler === 'gcc' ? 'wat' : 'll'}`]]) {
					const bytes = await fs.readFile(path.join(directory, name));
					assert.deepEqual(identity(bytes), { bytes: unit[kind].bytes, sha256: unit[kind].sha256 }, `${label} ${kind} differs: ${test.id}`);
					if (kind === 'object') {
						checkWasm(bytes, `${label} ${test.id} object`);
						assert.equal(WebAssembly.Module.customSections(new WebAssembly.Module(bytes), 'linking').length, 1, `${label} object has no linking metadata: ${test.id}`);
						if (label === 'Anonymous bitfield' || label === 'GNU float128')
							assert.deepEqual(inspectObjectFunctionSignatures(bytes), unit.signatures,
								`${label} actual object signatures differ: ${test.id} unit ${index}`);
					}
				}
			}
			const bytes = await fs.readFile(path.join(directory, 'program.wasm'));
			assert.deepEqual(identity(bytes), { bytes: test.program.bytes, sha256: test.program.sha256 }, `${label} program differs: ${test.id}`);
			checkWasm(bytes, `${label} ${test.id}`, true);
			assert.deepEqual(inspectVectorAbi(bytes), test.abi, `${label} binary types/memory differ: ${test.id}`);
			const module = new WebAssembly.Module(bytes);
			assert.deepEqual(WebAssembly.Module.imports(module), test.imports);
			assert.deepEqual(WebAssembly.Module.exports(module), test.exports);
		}
	}
	for (const name of ['include/wasm32-wasi/stdio.h', `${gccDirectory}/include/stddef.h`, 'lib/wasm32-wasi/crt1-command.o', 'lib/wasm32-wasi/libc.a', 'lib/wasm32-wasi/libm.a', 'lib/wasm32-wasi/libclang_rt.builtins-wasm32.a'])
		assert(sysroot.some((f) => f.path === name), `Required sysroot file missing: ${name}`);
	assert(!sysroot.some((f) => /(?:^|\/)libc\+\+/.test(f.path)), 'GCC profile must not silently substitute libc++');
	for (const f of sysroot.filter((f) => f.path.endsWith('.o'))) checkWasm(f.bytes, f.path);
	for (const f of sysroot.filter((f) => f.path.endsWith('.a')))
		assert.equal(f.bytes.subarray(0, 8).toString(), '!<arch>\n', `${f.path}: expected static archive`);
	const payloads = new Map();
	for (const name of ['cc1.mjs', 'cc1.wasm', 'cc1plus.mjs', 'cc1plus.wasm']) {
		const file = compilerFiles.find((f) => f.path === name);
		assert(file, `Missing GCC compiler: ${name}`);
		payloads.set(name, file.bytes);
	}
	for (const f of asFiles) payloads.set(f.path, f.bytes);
	payloads.set('ld.wasm', linker);
	payloads.set('sysroot.tar', deterministicTar(sysroot));
	for (const [name, bytes] of payloads) if (name.endsWith('.wasm')) checkWasm(bytes, name, true);
	const assetPaths = { cc1Js: 'cc1.mjs', cc1Wasm: 'cc1.wasm', cc1plusJs: 'cc1plus.mjs', cc1plusWasm: 'cc1plus.wasm', asJs: 'as.mjs', asWasm: 'as.wasm', ldWasm: 'ld.wasm', sysroot: 'sysroot.tar' };
	const revision = (family, item) => ({ family, repository: item.repository, version: item.version, commit: item.commit });
	const manifest = {
		schemaVersion: 2, kind: 'gcc-wasm32-wasi', host: 'wasm32-emscripten', target: 'wasm32-wasi',
		compiler: revision('gcc', lock.gcc), assembler: revision('wabt', lock.wabt),
		linker: { ...revision('lld', runtimeLock.browserLinker), host: 'wasm32-wasi' },
		sysroot: revision('wasi-libc', runtimeLock.wasiLibc), abi: 'wasm32-wasi-preview1', linkMode: 'static',
		sysrootPath: '/sysroot', gccInstallation: `/sysroot/${gccDirectory}`, resourceDir: `/sysroot/${gccDirectory}/include`,
		assets: Object.fromEntries(Object.entries(assetPaths).map(([key, name]) => [key, { path: name, ...identity(payloads.get(name)) }])),
		runtimeLibraries: ['/sysroot/lib/wasm32-wasi/libclang_rt.builtins-wasm32.a', ...atomicsProfile.runtimeLibraries],
		capabilities: { c: true, cpp: true, libc: true, libm: true, libstdcxx: Boolean(libstdcxx), staticInitialization: true, ...(coverageProof ? { coverage: true } : {}), ...(dwarfProof ? { debug: true } : {}), longDouble: Boolean(longDoubleProof), int128: Boolean(int128Proof), exceptions: false, rtti: Boolean(rttiProof), threads: false, dynamicLinking: false, simd: Boolean(simdProof), ...(simdRelaxedProof ? { relaxedSimd: true } : {}), ...atomicsProfile.capabilities, ...tlsProfile.capabilities, ...exceptionProfile.capabilities },
		limitations: [
			'Experimental, unmerged GCC 17 backend; not a released GCC target.',
			...(longDoubleProof ? [] : ['long double is binary64 in this GCC port but binary128 in WASI libc; long-double library interfaces are unsupported.']),
			...(int128Proof ? [] : ['Signed/unsigned __int128 is not qualified in this compiler profile.']),
			...(gnuFloat128Proof ? ['GNU __float128 covers the qualified core language/ABI and GNU type traits/limits/abs; libquadmath, GNU q-math builtins and complex128 remain unavailable.'] : ['GNU __float128 is not qualified in this compiler profile.']),
			'External objects require the SDK compatibility/profile receipts; general mixed-toolchain C++ interoperability is not qualified.',
			...(rttiProof ? [
				'C++ defaults to -fno-rtti; explicit RTTI opt-in uses -frtti with the qualified GNU runtime. ' + (exceptionProfile.capabilities.exceptions
					? 'Failed reference casts and typeid through null polymorphic pointers require exception opt-in.'
					: 'Exceptions remain disabled, including failed reference casts and typeid through null polymorphic pointers.'),
				'Ordinary WASI C++ execution retains -fno-exceptions -fuse-cxa-atexit -fno-threadsafe-statics and single-threaded static linking.'
			] : ['Ordinary WASI C++ execution uses -fno-exceptions -fno-rtti -fuse-cxa-atexit -fno-threadsafe-statics and single-threaded static linking.']),
			...atomicsProfile.limitations,
			...tlsProfile.limitations,
			...exceptionProfile.limitations,
			'GNU libstdc++ timezone database, C++26 debugger functions and prebuilt std modules are unavailable; no fallback implementations are provided.',
			...(dwarfProof ? ['Debug is explicit embedded DWARF32/DWARF4 at -O0. It uses actual Wasm local indices and initialized frame bases. Optimized register locations, split debug files, alternate debug formats and a general expression evaluator are outside this profile.'] : []),
			...(coverageProof ? ['Coverage is explicit source-only single-counter GCC gcov instrumentation. Run covered executables with a writable /profile directory and analyze returned .gcno/.gcda files with the pinned matching GCC gcov. PGO, atomic counters, info-section streaming, manual gcov APIs and process PID semantics are unsupported.'] : []),
			...(simdProof ? [simdHeaderProof
				? 'SIMD128 is explicit opt-in for GNU 128-bit vectors and the documented 169-name wasm_simd128.h subset; automatic vectorization and other header APIs are not qualified.'
				: 'SIMD128 is explicit opt-in for GNU 128-bit vector types; automatic vectorization and wasm_simd128.h intrinsics are not qualified.'] : []),
			...(simdRelaxedProof ? ['Relaxed SIMD requires separate explicit opt-in and an engine probe. The 20 wasm_relaxed_simd.h operations may return any result allowed by the WebAssembly specification; FP16 and BF16 extensions are not included.'] : []),
			...(vectorAbiProof
				? ['Direct v128 and qualified vector aggregate ABI require -msimd128 on both sides; the disabled profile retains indirect vector arguments/results.']
				: ['Direct LLVM v128 and vector aggregate ABI interoperability are not qualified.']),
			'x86 AVX2/FMA intrinsics and target pragmas do not provide Wasm SIMD.'
		],
		qualification: { status: 'unverified' }
	};
	const provenanceFiles = new Map([
		['sources.lock.json', lockBytes], ['runtime.lock.json', runtimeLockBytes],
		['compiler-build.json', json(compilerReceipt)], ['native-build.json', json(nativeReceipt)],
		['native-qualification.json', nativeGate], ['assembler-build.json', json(asReceipt)],
		['runtime-build.json', json(runtimeReceipt)], ['sysroot-inventory.json', json(inventory(sysroot))],
		...llvmProofs
	]);
	if (stdReceipt) provenanceFiles.set('libstdcxx-build.json', json(stdReceipt));
	if (libgcovBuildBytes) provenanceFiles.set('libgcov-build.json', libgcovBuildBytes);
	for (const [name, bytes] of libatomicProvenance) provenanceFiles.set(name, bytes);
	for (const [name, bytes] of atomicsProvenance) provenanceFiles.set(name, bytes);
	for (const [name, bytes] of tlsProvenance) provenanceFiles.set(name, bytes);
	for (const [name, bytes] of exceptionProvenance) provenanceFiles.set(name, bytes);
	if (dwarfProof) provenanceFiles.set('native-dwarf-qualification.json', dwarfProof);
	if (coverageProof) {
		provenanceFiles.set('native-coverage-qualification.json', coverageProof);
		provenanceFiles.set('coverage-analysis-tools.json', coverageAnalysisBytes);
	}
	if (simdProof) provenanceFiles.set('native-simd-qualification.json', simdProof);
	if (simdExtendedProof) provenanceFiles.set('native-simd-extended-qualification.json', simdExtendedProof);
	if (simdSaturatingProof) provenanceFiles.set('native-simd-saturating-qualification.json', simdSaturatingProof);
	if (simdConversionsProof) provenanceFiles.set('native-simd-conversions-qualification.json', simdConversionsProof);
	if (simdHeaderProof) provenanceFiles.set('native-simd-header-qualification.json', simdHeaderProof);
	if (simdRelaxedProof) provenanceFiles.set('native-simd-relaxed-qualification.json', simdRelaxedProof);
	if (simdRelaxedDriverProof) {
		provenanceFiles.set('native-simd-relaxed-driver-qualification.json', simdRelaxedDriverProof);
		provenanceFiles.set('native-simd-relaxed-driver-replay.json', json(simdRelaxedDriverReplay));
	}
	if (symbolAliasProof) {
		const sdkRoot = path.resolve(path.dirname(nativeLinker), '..');
		const toolPaths = { gcc: path.join(work, 'gcc-native/gcc/cc1'), gccCpp: path.join(work, 'gcc-native/gcc/cc1plus'),
			clang: path.join(sdkRoot, 'bin/clang'), assembler: path.join(work, 'wabt-native/wat2wasm'),
			linker: nativeLinker, archive: path.join(sdkRoot, 'bin/llvm-ar'), node: process.execPath };
		const tools = Object.fromEntries(await Promise.all(Object.entries(toolPaths).map(async ([name, file]) => [name, identity(await fs.readFile(file))])));
		const recipes = Object.fromEntries(await Promise.all(['test-symbol-alias.mjs', 'symbol-alias-fixtures.mjs', 'symbol-alias-inspect.mjs', 'wide-integer-test.mjs'].map(async name => [name, identity(await fs.readFile(path.join(here, name)))])));
		await reopenSymbolAliasQualification(aliasReport, {
			sourceLock: identity(lockBytes), nativeBuild: identity(nativeReceiptBytes), gccSource: nativeReceipt.gccSource,
			tools, recipes, programs: JSON.parse(aliasProgramProof),
			gnuRuntimeArchive: identity(sysroot.find(file => file.path === 'lib/wasm32-wasi/libsupc++.a').bytes)
		});
	}
	if (vectorAbiProof) provenanceFiles.set('native-vector-abi-qualification.json', vectorAbiProof);
	if (longDoubleProof) provenanceFiles.set('native-long-double-qualification.json', longDoubleProof);
	if (int128Proof) provenanceFiles.set('native-int128-qualification.json', int128Proof);
	if (gnuFloat128Proof) provenanceFiles.set('native-gnu-float128-qualification.json', gnuFloat128Proof);
	if (emptyAbiProof) provenanceFiles.set('native-empty-abi-qualification.json', emptyAbiProof);
	if (bitfieldProof) provenanceFiles.set('native-bitfield-qualification.json', bitfieldProof);
	if (anonymousBitfieldProof) provenanceFiles.set('native-anonymous-bitfield-qualification.json', anonymousBitfieldProof);
	if (symbolAliasProof) {
		provenanceFiles.set('native-symbol-alias-qualification.json', symbolAliasProof);
		provenanceFiles.set('native-symbol-alias-programs.json', aliasProgramProof);
	}
	for (const [proof, feature, harness, reopen] of [
		[weakrefProof, 'weakref', 'test-weakrefs.mjs', reopenWeakrefQualification],
		[rttiProof, 'rtti', 'test-rtti.mjs', reopenRttiQualification]
	]) {
		if (!proof) continue;
		const sdkRoot = path.resolve(path.dirname(nativeLinker), '..');
		const fileIdentity = async file => ({ path: file, ...identity(await fs.readFile(file)) });
		const toolPaths = {
			gcc: path.join(work, 'gcc-native/gcc/cc1'), gccCpp: path.join(work, 'gcc-native/gcc/cc1plus'),
			xgcc: path.join(work, 'gcc-native/gcc/xgcc'), clang: path.join(sdkRoot, 'bin/clang'),
			clangCpp: path.join(sdkRoot, 'bin/clang++'), assembler: path.join(work, 'wabt-native/wat2wasm'),
			objdump: path.join(work, 'wabt-native/wasm-objdump'), validator: path.join(work, 'wabt-native/wasm-validate'),
			linker: nativeLinker, node: process.execPath
		};
		const tools = Object.fromEntries(await Promise.all(Object.entries(toolPaths).map(async ([name, file]) => [name, await fileIdentity(file)])));
		const recipeNames = [harness, feature + '-fixtures.mjs', feature + '-inspect.mjs', 'symbol-alias-inspect.mjs',
			'inspect-vector-abi.mjs', 'prepare-source.py', 'build-native.sh', 'build-wabt.sh', 'build-libstdcxx.sh',
			'test-libstdcxx.mjs', 'runtime.lock.json'];
		const recipes = Object.fromEntries(await Promise.all(recipeNames.map(async name => [name, await fileIdentity(path.join(here, name))])));
		const archives = Object.fromEntries(Object.entries({ crt: 'crt1-command.o', libc: 'libc.a', libm: 'libm.a',
			libstdcxx: 'libstdc++.a', libsupcxx: 'libsupc++.a', builtins: 'libclang_rt.builtins-wasm32.a' }).map(([name, filename]) => {
			const file = sysroot.find(file => file.path === 'lib/wasm32-wasi/' + filename);
			assert(file, 'Missing ' + feature + ' runtime archive: ' + filename);
			return [name, identity(file.bytes)];
		}));
		const headerRoots = { gcc: path.join(work, 'gcc-native/gcc/include'), target: path.join(runtime, 'sysroot/include'),
			gnu: path.join(libstdcxx, 'sysroot/include'), clang: path.join(sdkRoot, 'lib/clang/22/include') };
		const headers = Object.fromEntries(await Promise.all(Object.entries(headerRoots).map(async ([name, root]) =>
			[name, (await readNativeTree(root)).map(file => ({ path: path.join(root, file.path), ...identity(file.bytes) }))])));
		const gnuVersionRoot = path.join(headerRoots.gnu, 'c++', lock.gcc.version);
		const gnuIncludePaths = [gnuVersionRoot, path.join(gnuVersionRoot, 'wasm32-wasi'), path.join(gnuVersionRoot, 'backward'),
			headerRoots.gcc, path.join(headerRoots.target, 'wasm32-wasi')];
		await reopen(JSON.parse(proof), {
			sourceLock: identity(lockBytes), nativeBuild: identity(nativeReceiptBytes), gccSource: nativeReceipt.gccSource,
			fixtures: recipes[feature + '-fixtures.mjs'], tools, recipes,
			assemblerProvenance: await fileIdentity(path.join(work, 'wabt-native/provenance.json')), assemblerSource: asReceipt.source,
			runtime: { archives, headers, headerRoots, gnuIncludePaths, gnuBuild: await fileIdentity(path.join(libstdcxx, 'build.json')),
				gnuReceipt: await fileIdentity(path.join(libstdcxx, 'libstdcxx-build.json')),
				gnuQualification: await fileIdentity(path.join(libstdcxx, 'qualification/qualification.json')) }
		});
		provenanceFiles.set('native-' + feature + '-qualification.json', proof);
	}
	for (const [name, bytes] of runtimeProofs) provenanceFiles.set(name, bytes);
	provenanceFiles.set('host-dependencies.lock.json', await fs.readFile(path.join(here, '../gcc-browser/sources.lock.json')));
	for (const [name, bytes] of wabtRecipes) provenanceFiles.set(`wabt-${name}`, bytes);
	for (const patch of [...(lock.gcc.patches || []), ...(lock.wabt.patches || [])]) {
		const bytes = await fs.readFile(path.join(here, relativePath(patch.path)));
		assert.equal(identity(bytes).sha256, patch.sha256, 'Compiler or assembler patch differs from the source lock');
		provenanceFiles.set(path.basename(patch.path), bytes);
	}
	for (const patch of runtimeLock.wasiLibc.patches || []) {
		const bytes = await fs.readFile(path.join(here, relativePath(patch.path)));
		assert.equal(identity(bytes).sha256, patch.sha256, 'WASI patch differs from the runtime lock');
		provenanceFiles.set(path.basename(patch.path), bytes);
	}
	manifest.provenance = {
		gccSource: compilerReceipt.gccSource,
		files: Object.fromEntries([...provenanceFiles].map(([name, bytes]) => [name, { path: `provenance/${name}`, ...identity(bytes) }]))
	};
	const licenseFiles = [...compilerFiles.filter((f) => f.path.startsWith('licenses/')), ...libatomicLicenses, ...tlsLicenses, ...exceptionLicenses];
	for (const f of await readNativeTree(path.join(here, 'licenses'))) licenseFiles.push({ path: `licenses/runtime/${f.path}`, bytes: f.bytes });
	for (const name of (await fs.readdir(asRoot)).filter((name) => name.startsWith('LICENSE')))
		licenseFiles.push({ path: `licenses/wabt/${name}`, bytes: await fs.readFile(path.join(asRoot, name)) });
	const licenseSources = await readJson(path.join(here, 'licenses/sources.json'));
	verifyInventory(licenseFiles.filter((f) => f.path.startsWith('licenses/runtime/') && f.path !== 'licenses/runtime/sources.json').map((f) => ({ path: f.path.slice('licenses/runtime/'.length), bytes: f.bytes })), licenseSources, 'Runtime license notices');
	// Reserve a new directory; a failed attempt never becomes a completed bundle.
	await fs.mkdir(finalOut);
	for (const [name, bytes] of payloads) await fs.writeFile(path.join(finalOut, name), bytes, { flag: 'wx' });
	for (const f of licenseFiles) {
		await fs.mkdir(path.dirname(path.join(finalOut, f.path)), { recursive: true });
		await fs.writeFile(path.join(finalOut, f.path), f.bytes, { flag: 'wx' });
	}
	await fs.mkdir(path.join(finalOut, 'provenance'));
	await writeProvenanceFiles(path.join(finalOut, 'provenance'), provenanceFiles);
	const loading = [...payloads].map(([name, bytes]) => ({ path: name, ...identity(bytes), gzipBytes: gzipSync(bytes, { level: 9 }).length, brotliBytes: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }).length }));
	const metadata = json(manifest);
	loading.push({ path: 'gcc-toolchain.v2.json', ...identity(metadata), gzipBytes: gzipSync(metadata, { level: 9 }).length, brotliBytes: brotliCompressSync(metadata, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }).length });
	await fs.writeFile(path.join(finalOut, 'loading-sizes.json'), json({ scope: 'All initial manifest and tool/sysroot payloads; SDK Worker modules measured separately by browser qualification', gzipLevel: 9, brotliQuality: 6, assets: loading, totalBytes: loading.reduce((n, a) => n + a.bytes, 0), totalGzipBytes: loading.reduce((n, a) => n + a.gzipBytes, 0), totalBrotliBytes: loading.reduce((n, a) => n + a.brotliBytes, 0) }), { flag: 'wx' });
	await fs.writeFile(path.join(finalOut, 'gcc-toolchain.v2.json'), metadata, { flag: 'wx' });
	return { output: finalOut, manifest: identity(metadata), libstdcxx: Boolean(libstdcxx), status: 'packaged-unverified' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const opts = {};
		for (let i = 2; i < process.argv.length; i += 2) {
			const key = process.argv[i].replace(/^--/, '');
			assert(['work', 'runtime', 'output', 'libstdcxx', 'simd-qualification', 'simd-extended-qualification', 'simd-saturating-qualification', 'simd-conversions-qualification', 'simd-header-qualification', 'simd-relaxed-qualification', 'simd-relaxed-driver-qualification', 'vector-abi-qualification', 'long-double-qualification', 'int128-qualification', 'gnu-float128-qualification', 'empty-abi-qualification', 'bitfield-qualification', 'anonymous-bitfield-qualification', 'symbol-alias-qualification', 'weakref-qualification', 'rtti-qualification', 'coverage-qualification', 'dwarf-qualification', 'libgcov', 'libatomic', 'libatomic-qualification', 'atomics-qualification', 'tls-runtime', 'tls-libc', 'tls-qualification', 'tls-runtime-qualification', 'eh-runtime', 'eh-qualification', 'eh-runtime-qualification', 'native-gcov', 'native-linker'].includes(key) && process.argv[i + 1], 'Usage: package.mjs --work DIR --runtime DIR --output NEW_DIR [--libstdcxx DIR] [--tls-runtime DIR --tls-libc DIR --tls-qualification FILE --tls-runtime-qualification FILE] [--eh-runtime DIR --eh-qualification FILE --eh-runtime-qualification FILE] [--libatomic DIR --libatomic-qualification FILE --atomics-qualification FILE] [--simd-qualification FILE --simd-extended-qualification FILE --simd-saturating-qualification FILE --simd-conversions-qualification FILE --simd-header-qualification FILE --simd-relaxed-qualification FILE --simd-relaxed-driver-qualification FILE --vector-abi-qualification FILE --long-double-qualification FILE --int128-qualification FILE --gnu-float128-qualification FILE --empty-abi-qualification FILE --bitfield-qualification FILE --anonymous-bitfield-qualification FILE --symbol-alias-qualification FILE --weakref-qualification FILE --rtti-qualification FILE --coverage-qualification FILE --dwarf-qualification FILE --libgcov DIR --native-gcov FILE --native-linker FILE]');
			const field = { 'simd-qualification': 'simdQualification', 'simd-extended-qualification': 'simdExtendedQualification', 'simd-saturating-qualification': 'simdSaturatingQualification', 'simd-conversions-qualification': 'simdConversionsQualification', 'simd-header-qualification': 'simdHeaderQualification', 'simd-relaxed-qualification': 'simdRelaxedQualification', 'simd-relaxed-driver-qualification': 'simdRelaxedDriverQualification', 'vector-abi-qualification': 'vectorAbiQualification', 'long-double-qualification': 'longDoubleQualification', 'int128-qualification': 'int128Qualification', 'gnu-float128-qualification': 'gnuFloat128Qualification', 'empty-abi-qualification': 'emptyAbiQualification', 'bitfield-qualification': 'bitfieldQualification', 'anonymous-bitfield-qualification': 'anonymousBitfieldQualification', 'symbol-alias-qualification': 'symbolAliasQualification', 'weakref-qualification': 'weakrefQualification', 'rtti-qualification': 'rttiQualification', 'coverage-qualification': 'coverageQualification', 'dwarf-qualification': 'dwarfQualification', 'libatomic-qualification': 'libatomicQualification', 'atomics-qualification': 'atomicsQualification', 'tls-runtime': 'tlsRuntime', 'tls-libc': 'tlsLibc', 'tls-qualification': 'tlsQualification', 'tls-runtime-qualification': 'tlsRuntimeQualification', 'eh-runtime': 'ehRuntime', 'eh-qualification': 'ehQualification', 'eh-runtime-qualification': 'ehRuntimeQualification', 'native-gcov': 'nativeGcov', 'native-linker': 'nativeLinker' }[key] || key;
			assert(!opts[field], `Duplicate option: ${key}`);
			opts[field] = process.argv[i + 1];
		}
		assert(opts.work && opts.runtime && opts.output, 'Required: --work DIR --runtime DIR --output NEW_DIR');
		console.log(JSON.stringify(await packageWasi(opts)));
	} catch (error) { console.error(error.message); process.exitCode = 1; }
}
