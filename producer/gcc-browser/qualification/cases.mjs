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
	{ id: 'ps-assembly', fixture: 'ps.cpp', request: { language: 'cpp', emit: 'assembly', cpu: 'x86-64', optimization: '2', standard: 'gnu++20' } },
	{ id: 'ps-object', fixture: 'ps.cpp', request: { language: 'cpp', emit: 'object', cpu: 'x86-64', optimization: '2', standard: 'gnu++20' } },
	{ id: 'ps-executable', fixture: 'ps.cpp', request: { language: 'cpp', emit: 'executable', cpu: 'x86-64', optimization: '2', standard: 'gnu++20' },
		stdin: '6 5\n9 1 5 3 9 -2\n', stdout: '5 3 3 25 1 handled\n' },
	{ id: 'pragma-assembly', fixture: 'pragma.cpp', request: { language: 'cpp', emit: 'assembly', cpu: 'x86-64', optimization: '0', standard: 'gnu++20' },
		check: 'pragma' },
	{ id: 'pragma-object', fixture: 'pragma.cpp', request: { language: 'cpp', emit: 'object', cpu: 'x86-64', optimization: '0', standard: 'gnu++20' },
		check: 'pragma-object' },
	{ id: 'profile-assembly', fixture: 'avx2-profile.cpp', request: { language: 'cpp', emit: 'assembly', cpu: 'avx2-fma', optimization: '2', standard: 'gnu++20' },
		check: 'avx2-fma' },
	{ id: 'profile-baseline-reject', fixture: 'avx2-profile.cpp', request: { language: 'cpp', emit: 'assembly', cpu: 'x86-64', optimization: '2', standard: 'gnu++20' },
		expectFailure: true },
	{ id: 'invalid-after-success', fixture: 'broken.cpp', request: { language: 'cpp', emit: 'executable', cpu: 'x86-64', optimization: '2', standard: 'gnu++20' },
		expectFailure: true }
];
