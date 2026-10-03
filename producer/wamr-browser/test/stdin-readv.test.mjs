import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/wasm-debug-stdin.js', import.meta.url), 'utf8');
// Resolve the one Emscripten compile-time errno constant for this library harness.
const librarySource = source.replaceAll('{{{ cDefs.EFAULT }}}', '21');

function createStdin(bytes = []) {
	const heap = new Uint8Array(256 * 1024).fill(0xaa);
	const words = new Uint32Array(heap.buffer);
	const calls = [];
	const originalCalls = [];
	const pending = [...bytes];
	let closed = false;
	const context = {
		Uint8Array,
		HEAPU8: heap,
		HEAPU32: words,
		FS: {
			ErrnoError: class extends Error {
				constructor(errno) {
					super(`errno ${errno}`);
					this.errno = errno;
				}
			},
			read(stream, buffer, offset, length) {
				calls.push({ stream, offset, length });
				if (!pending.length && !closed) throw new Error('stdin would block');
				const data = pending.splice(0, length);
				buffer.set(data, offset);
				return data.length;
			}
		},
		LibraryManager: {
			library: {
				$doReadv(...args) {
					originalCalls.push(args);
					return 73;
				}
			}
		},
		mergeInto(target, library) {
			Object.assign(target, library);
		}
	};
	vm.runInNewContext(librarySource, context);
	const library = context.LibraryManager.library;
	context.WasmIdleOriginalDoReadv = library.$WasmIdleOriginalDoReadv;
	return {
		heap,
		calls,
		originalCalls,
		pending,
		read: library.$doReadv,
		close() {
			closed = true;
		},
		vectors(entries, table = 8) {
			entries.forEach(([pointer, length], index) => {
				words[(table >> 2) + 2 * index] = pointer;
				words[(table >> 2) + 2 * index + 1] = length;
			});
			return table;
		}
	};
}

test('a line exactly filling the first iovec returns without reading again or requiring EOF', () => {
	const stdin = createStdin([55, 51, 10]);
	const table = stdin.vectors([[100, 3], [200, 8]]);
	assert.equal(stdin.read({ fd: 0 }, table, 2), 3);
	assert.equal(stdin.calls.length, 1);
	assert.deepEqual(Array.from(stdin.heap.slice(100, 103)), [55, 51, 10]);
	assert.deepEqual(Array.from(stdin.heap.slice(200, 208)), Array(8).fill(0xaa));
	assert.equal(stdin.heap[99], 0xaa);
	assert.equal(stdin.heap[103], 0xaa);
});

test('scatters short binary reads across vectors without modifying unused bytes', () => {
	const stdin = createStdin([0, 128, 255, 10]);
	const table = stdin.vectors([[100, 2], [200, 5]]);
	assert.equal(stdin.read({ fd: 0 }, table, 2), 4);
	assert.deepEqual(Array.from(stdin.heap.slice(100, 102)), [0, 128]);
	assert.deepEqual(Array.from(stdin.heap.slice(200, 205)), [255, 10, 0xaa, 0xaa, 0xaa]);
	assert.equal(stdin.calls.length, 1);
});

test('subsequent read waits for new input and closed stdin drains before returning EOF', () => {
	const stdin = createStdin([51, 53, 10]);
	const table = stdin.vectors([[100, 3], [200, 8]]);
	assert.equal(stdin.read({ fd: 0 }, table, 2), 3);
	assert.throws(() => stdin.read({ fd: 0 }, table, 2), /stdin would block/);
	stdin.pending.push(51, 56, 10);
	assert.equal(stdin.read({ fd: 0 }, table, 2), 3);
	assert.deepEqual(Array.from(stdin.heap.slice(100, 103)), [51, 56, 10]);
	stdin.pending.push(42);
	stdin.close();
	assert.equal(stdin.read({ fd: 0 }, table, 2), 1);
	assert.equal(stdin.read({ fd: 0 }, table, 2), 0);
});

test('zero-length vectors do not consume input, including unused out-of-bounds pointers', () => {
	const stdin = createStdin([73]);
	const table = stdin.vectors([[0xffffffff, 0], [0xffffffff, 0]]);
	assert.equal(stdin.read({ fd: 0 }, table, 2), 0);
	assert.equal(stdin.calls.length, 0);
	assert.deepEqual(stdin.pending, [73]);
	stdin.vectors([[0xffffffff, 0], [100, 1], [0xffffffff, 0]]);
	assert.equal(stdin.read({ fd: 0 }, table, 3), 1);
	assert.equal(stdin.heap[100], 73);
});

test('non-stdin, positional, single-vector, and zero-vector reads retain the original implementation', () => {
	const stdin = createStdin();
	const cases = [
		[{ fd: 4 }, 8, 2, undefined],
		[{ fd: 0 }, 8, 2, 0],
		[{ fd: 0 }, 8, 2, 17],
		[{ fd: 0 }, 8, 1, undefined],
		[{ fd: 0 }, 8, 0, undefined]
	];
	for (const args of cases) assert.equal(stdin.read(...args), 73);
	assert.deepEqual(stdin.originalCalls, cases);
	assert.equal(stdin.calls.length, 0);
});

test('bounds scratch storage to 64 KiB and leaves the remaining input available', () => {
	const stdin = createStdin(Array(100_000).fill(73));
	const table = stdin.vectors([[1024, 40_000], [50_000, 80_000]]);
	assert.equal(stdin.read({ fd: 0 }, table, 2), 65_536);
	assert.equal(stdin.calls[0].length, 65_536);
	assert.equal(stdin.pending.length, 100_000 - 65_536);
	assert.ok(stdin.heap.slice(1024, 41_024).every((byte) => byte === 73));
	assert.ok(stdin.heap.slice(50_000, 75_536).every((byte) => byte === 73));
	assert.equal(stdin.heap[75_536], 0xaa);
	assert.equal(stdin.read({ fd: 0 }, table, 2), 100_000 - 65_536);
	assert.equal(stdin.pending.length, 0);
});

test('invalid vector tables and destinations fail before consuming input', () => {
	for (const scenario of ['table-before', 'table-after', 'table-size', 'pointer', 'length']) {
		const stdin = createStdin([73]);
		let table = stdin.vectors([[100, 1], [200, 1]]);
		let count = 2;
		if (scenario === 'table-before') table = -8;
		if (scenario === 'table-after') table = stdin.heap.length;
		if (scenario === 'table-size') count = 0x7fffffff;
		if (scenario === 'pointer') stdin.vectors([[100, 1], [0xffffffff, 1]]);
		if (scenario === 'length') stdin.vectors([[100, 1], [stdin.heap.length - 1, 2]]);
		assert.throws(() => stdin.read({ fd: 0 }, table, count), (error) => error.errno === 21);
		assert.equal(stdin.calls.length, 0);
		assert.deepEqual(stdin.pending, [73]);
	}
});

test('snapshots vector destinations before scattering over the vector table itself', () => {
	const stdin = createStdin([1, 2, 3, 4, 5, 6, 7, 8, 9]);
	const table = stdin.vectors([[16, 8], [200, 3]]);
	assert.equal(stdin.read({ fd: 0 }, table, 2), 9);
	assert.deepEqual(Array.from(stdin.heap.slice(16, 24)), [1, 2, 3, 4, 5, 6, 7, 8]);
	assert.deepEqual(Array.from(stdin.heap.slice(200, 203)), [9, 0xaa, 0xaa]);
});
