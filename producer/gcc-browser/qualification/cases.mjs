// Importable by the consumer's Chromium acceptance script. Read each fixture
// from new URL(`fixtures/${test.fixture}`, import.meta.url) on the Node side,
// then pass { ...test.request, code } to createCrossGccCompiler().compile().
export const cases = [
	{ id: 'preprocessed', fixture: 'preprocessed.ii', milestone: true,
		request: { language: 'cpp', emit: 'assembly', cpu: 'x86-64', optimization: '2', standard: 'gnu++17', preprocessed: true } },
	{ id: 'c-assembly', fixture: 'baseline.c', request: { language: 'c', emit: 'assembly', cpu: 'x86-64', optimization: '2', standard: 'gnu17' } },
	{ id: 'c-object', fixture: 'baseline.c', request: { language: 'c', emit: 'object', cpu: 'x86-64', optimization: '2', standard: 'gnu17' } },
	{ id: 'c-executable', fixture: 'baseline.c', request: { language: 'c', emit: 'executable', cpu: 'x86-64', optimization: '2', standard: 'gnu17' },
		stdin: '17 -4\n', stdout: '47\n' },
	{ id: 'c-utf8-executable', fixture: 'utf8.c', request: { language: 'c', emit: 'executable', cpu: 'x86-64', optimization: '2', standard: 'c17' },
		stdin: '', stdout: '안녕하세요 🙂\n' },
	{ id: 'cpp-utf8-executable', fixture: 'utf8.cpp', request: { language: 'cpp', emit: 'executable', cpu: 'x86-64', optimization: '2', standard: 'c++20' },
		stdin: '', stdout: '안녕하세요 🙂\n' },
	{ id: 'c-libm-executable', fixture: 'libm.c', nativeLinkArgs: ['-lm'],
		request: { language: 'c', emit: 'executable', cpu: 'x86-64', optimization: '2', standard: 'gnu17' },
		stdin: '0.5\n', stdout: '0.479426\n' },
	{ id: 'ps-assembly', fixture: 'ps.cpp', request: { language: 'cpp', emit: 'assembly', cpu: 'x86-64', optimization: '2', standard: 'gnu++20' } },
	{ id: 'ps-object', fixture: 'ps.cpp', request: { language: 'cpp', emit: 'object', cpu: 'x86-64', optimization: '2', standard: 'gnu++20' } },
	// The Node runner first precompiles bits/stdc++.h with the same flags; its
	// assembly and object must equal the corresponding ordinary outputs.
	{ id: 'ps-pch-assembly', fixture: 'ps.cpp', precompiledHeader: true, sameAs: 'ps-assembly',
		request: { language: 'cpp', emit: 'assembly', cpu: 'x86-64', optimization: '2', standard: 'gnu++20' } },
	{ id: 'ps-pch-object', fixture: 'ps.cpp', precompiledHeader: true, sameAs: 'ps-object',
		request: { language: 'cpp', emit: 'object', cpu: 'x86-64', optimization: '2', standard: 'gnu++20' } },
	{ id: 'ps-executable', fixture: 'ps.cpp', request: { language: 'cpp', emit: 'executable', cpu: 'x86-64', optimization: '2', standard: 'gnu++20' },
		stdin: '6 5\n9 1 5 3 9 -2\n', stdout: '5 3 3 25 1 handled\n' },
	{ id: 'target-threads-executable', fixture: 'target-threads.cpp', request: { language: 'cpp', emit: 'executable', cpu: 'x86-64', optimization: '2', standard: 'gnu++20' },
		stdin: '17\n', stdout: '51 51 1 7\n' },
	{ id: 'pragma-assembly', fixture: 'pragma.cpp', request: { language: 'cpp', emit: 'assembly', cpu: 'x86-64', optimization: '0', standard: 'gnu++20' },
		check: 'pragma' },
	{ id: 'pragma-object', fixture: 'pragma.cpp', request: { language: 'cpp', emit: 'object', cpu: 'x86-64', optimization: '0', standard: 'gnu++20' },
		check: 'pragma-object' },
	{ id: 'pragma-static-init', fixture: 'pragma-static-init.cpp', request: { language: 'cpp', emit: 'assembly', cpu: 'x86-64', optimization: '0', standard: 'c++17' } },
	{ id: 'pragma-deferred-template', fixture: 'pragma-deferred-template.cpp', request: { language: 'cpp', emit: 'assembly', cpu: 'x86-64', optimization: '0', standard: 'c++17' } },
	{ id: 'pragma-stl-assembly', fixture: 'pragma-stl.cpp', request: { language: 'cpp', emit: 'assembly', cpu: 'x86-64', optimization: '2', standard: 'c++17' },
		check: 'pragma-stl' },
	// Source pragmas require AVX2 despite the baseline command-line profile.
	// Assemble an ELF object without requiring AVX2 execution on the CI host.
	{ id: 'pragma-stl-object', fixture: 'pragma-stl.cpp', request: { language: 'cpp', emit: 'object', cpu: 'x86-64', optimization: '2', standard: 'c++17' } },
	{ id: 'profile-assembly', fixture: 'avx2-profile.cpp', request: { language: 'cpp', emit: 'assembly', cpu: 'avx2-fma', optimization: '2', standard: 'gnu++20' },
		check: 'avx2-fma' },
	{ id: 'profile-baseline-reject', fixture: 'avx2-profile.cpp', request: { language: 'cpp', emit: 'assembly', cpu: 'x86-64', optimization: '2', standard: 'gnu++20' },
		expectFailure: true },
	{ id: 'invalid-after-success', fixture: 'broken.cpp', request: { language: 'cpp', emit: 'executable', cpu: 'x86-64', optimization: '2', standard: 'gnu++20' },
		expectFailure: true }
];

// The pinned Chromium consumer predates static libatomic support. The producer
// runs both cases on every qualification, alongside the shared Chromium cases.
export const atomicCases = [
	{ id: 'c-atomic16-executable', fixture: 'atomic16.c', nativeLinkArgs: ['-latomic'],
		request: { language: 'c', emit: 'executable', cpu: 'x86-64', optimization: '2', standard: 'c11' },
		stdin: '17 29\n', stdout: '17 29\n' },
	{ id: 'cpp-atomic16-executable', fixture: 'atomic16.cpp', nativeLinkArgs: ['-latomic'],
		request: { language: 'cpp', emit: 'executable', cpu: 'x86-64', optimization: '2', standard: 'c++20' },
		stdin: '31 43\n', stdout: '31 43\n' }
];

// Older Chromium SDKs lack these implicit runtime libraries. Exercise the
// producer link plan independently until the pinned consumer supports them.
export const runtimeLibraryCases = [
	{ id: 'cpp-filesystem-ts', fixture: 'filesystem-ts.cpp', nativeLinkArgs: ['-lstdc++fs'],
		request: { language: 'cpp', emit: 'executable', cpu: 'x86-64', optimization: '2', standard: 'c++14' },
		stdin: '', stdout: 'directory\n' },
	{ id: 'c-resolver', fixture: 'resolver.c', nativeLinkArgs: ['-lresolv'],
		request: { language: 'c', emit: 'executable', cpu: 'x86-64', optimization: '2', standard: 'gnu17' },
		stdin: '', stdout: '0\n' },
	{ id: 'cpp-stacktrace', fixture: 'stacktrace.cpp', requiresGccArchive: 'libstdc++exp.a', nativeLinkArgs: ['-lstdc++exp'],
		request: { language: 'cpp', emit: 'executable', cpu: 'x86-64', optimization: '2', standard: 'c++23' },
		stdin: '', stdout: 'trace\n' }
];
