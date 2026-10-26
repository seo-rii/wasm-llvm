// No Node imports: the same assertions run against actual Chromium Worker
// results and the standalone Emscripten/Node qualification.
function require(value, message) {
	if (!value) throw new Error(message);
}

export function assertX86Elf(input, expectedType) {
	const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
	require(bytes.length >= 64 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46, 'Expected ELF magic');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	require(bytes[4] === 2 && bytes[5] === 1 && bytes[6] === 1, 'Expected little-endian ELF64');
	require(view.getUint16(18, true) === 62, 'Expected x86-64 e_machine');
	require(view.getUint16(16, true) === expectedType, `Expected ELF type ${expectedType}`);
	require(view.getUint16(52, true) === 64, 'Invalid ELF64 header size');
	return { bytes, view };
}

export function assertStaticExecutable(input) {
	const { bytes, view } = assertX86Elf(input, 2);
	const offset = Number(view.getBigUint64(32, true));
	const count = view.getUint16(56, true);
	require(view.getUint16(54, true) === 56 && count > 0 && Number.isSafeInteger(offset) &&
		offset >= 64 && count * 56 <= bytes.length - offset, 'Invalid ELF program headers');
	for (let i = 0; i < count; i++) {
		require(view.getUint32(offset + i * 56, true) !== 3, 'Static executable contains PT_INTERP');
	}
	require(view.getBigUint64(24, true) !== 0n, 'Executable has no entry point');
}

export function functionAssembly(assembly, name) {
	require(/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(name), 'Unsafe fixture function name');
	const match = new RegExp(`^${name}:\\s*\\n([\\s\\S]*?)^\\s*\\.size\\s+${name}\\s*,`, 'm').exec(assembly);
	require(match, `Assembly lacks the complete function ${name}`);
	return match[1];
}

export function assertPragmaAssembly(assembly) {
	const add = functionAssembly(assembly, 'avx2_add');
	const fma = functionAssembly(assembly, 'fma_multiply_add');
	require(/\bvpaddd\b/.test(add) && /%ymm\d+/.test(add), 'GCC target pragma did not emit AVX2 YMM integer addition');
	require(/\bvfmadd(?:132|213|231)ps\b/.test(fma) && /%ymm\d+/.test(fma), 'GCC target pragma did not emit packed FMA');
	const optimized = functionAssembly(assembly, 'optimized_in_push');
	const restored = functionAssembly(assembly, 'unoptimized_after_pop');
	require(!/\bj[a-z]+\s/.test(optimized), 'GCC optimize pragma did not remove the fixed-count loop');
	require(/\bj[a-z]+\s/.test(restored), 'GCC pop_options did not restore command-line -O0');
	for (const name of ['baseline_after_pop', 'vectorized_baseline_after_pop']) {
		const body = functionAssembly(assembly, name);
		require(!/%[yz]mm\d+|\bv(?:padd|mov|fmadd)\w*\b/.test(body), `GCC pop_options leaked AVX into ${name}`);
	}
	require(/\bpaddd\b/.test(functionAssembly(assembly, 'vectorized_baseline_after_pop')),
		'Post-pop O3 fixture did not exercise baseline SSE vectorization');
}

export function assertCaseResult(test, result) {
	if (test.expectFailure) {
		require(Number.isInteger(result.exitCode) && result.exitCode !== 0, `${test.id}: expected a compiler error`);
		require(!result.artifact, `${test.id}: failed compilation returned a stale artifact`);
		require(typeof result.stderr === 'string' && result.stderr.trim().length > 0, `${test.id}: missing compiler diagnostic`);
		return;
	}
	require(result.exitCode === 0, `${test.id}: compiler failed: ${result.stderr}`);
	require(result.artifact?.bytes?.length > 0, `${test.id}: compiler returned no artifact`);
	require(result.artifact.compiler === 'gcc', `${test.id}: wrong compiler`);
	require(result.artifact.compilerHost === 'wasm32-emscripten', `${test.id}: wrong compiler host`);
	require(result.artifact.target === 'x86_64-linux-gnu', `${test.id}: wrong output target`);
	require(result.artifact.cpu === test.request.cpu, `${test.id}: wrong CPU profile`);
	const bytes = new Uint8Array(result.artifact.bytes);
	if (test.request.emit === 'assembly') {
		require(result.artifact.format === 'assembly', `${test.id}: wrong artifact kind`);
		const assembly = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		require(/\.ident\s+"GCC:/.test(assembly), `${test.id}: assembly lacks a GCC identity`);
		if (test.milestone) require(/triangular:/.test(assembly) && /%r[a-z0-9]+/.test(assembly), 'Preprocessed milestone lacks x86-64 function');
		if (test.check === 'pragma') assertPragmaAssembly(assembly);
		if (test.check === 'pragma-stl') {
			const body = functionAssembly(assembly, 'pragma_stl_transform');
			require(/\bvpaddd\b/.test(body) && /\bvpxor\b/.test(body) && /%ymm\d+/.test(body),
				'Pragmas before STL headers did not enable AVX2 auto-vectorization');
		}
		if (test.check === 'avx2-fma') {
			require(/\bvpaddd\b/.test(assembly) && /%ymm\d+/.test(assembly), 'AVX2 profile lacks integer SIMD');
			require(/\bvfmadd(?:132|213|231)ps\b/.test(assembly), 'AVX2/FMA profile lacks FMA');
		}
	} else if (test.request.emit === 'object') {
		require(result.artifact.format === 'elf-object', `${test.id}: wrong artifact kind`);
		assertX86Elf(bytes, 1);
	} else {
		require(result.artifact.format === 'elf-executable', `${test.id}: wrong artifact kind`);
		assertStaticExecutable(bytes);
	}
}
