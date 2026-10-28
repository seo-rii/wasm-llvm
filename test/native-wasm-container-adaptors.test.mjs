import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyNativeContainerAdaptors } from './native-wasm-debug/run-native-cpp-baseline.mjs';

function transcript() {
	const first = { deque_stack: [1, 2, 3], vector_stack: [4, 5, 6],
		max_heap: [4, 2, 1], min_heap: [1, 4, 2], deque_heap: [1, 4, 2] };
	const second = { deque_stack: [1, 2], vector_stack: [4, 5, 6, 9],
		max_heap: [2, 1], min_heap: [0, 2, 1, 4], deque_heap: [1, 4, 2] };
	return [first, second].map((containers, index) => [
		`stop reason = breakpoint ${index + 1}.1`,
		'(std::__2::stack<int>) empty_stack = size=0 {}',
		'(std::__2::priority_queue<int>) empty_heap = size=0 {}',
		...Object.entries(containers).flatMap(([name, values]) => [
			`(container<int>) ${name} = size=${values.length} { ... }`,
			...values.map((value, child) => `(int) ${name}[${child}] = ${value}`)
		]),
		'(stack<vector<int>>) nested_stack = size=1 { ... }',
		'(priority_queue<vector<int>>) nested_heap = size=2 { ... }',
		'(int) nested_stack[0][0] = 7',
		'(int) nested_stack[0][1] = 8',
		'(int) nested_heap[0][0] = 3',
		'(int) nested_heap[0][1] = 4',
		'(std::deque<int>) block_deque = size=1025 { ... }',
		'(std::deque<LargeElement>) large_deque = size=17 { ... }',
		...Object.entries(index === 0
			? { 'block_deque[0]': 5, 'block_deque[1018]': 1023, 'block_deque[1019]': 1024,
				'block_deque[1024]': 1029, 'large_deque[0].value': 10, 'large_deque[14].value': 150,
				'large_deque[15].value': 160, 'large_deque[16].value': 170 }
			: { 'block_deque[0]': 6, 'block_deque[1018]': 1024, 'block_deque[1019]': 1025,
				'block_deque[1024]': 1030, 'large_deque[0].value': 20, 'large_deque[14].value': 160,
				'large_deque[15].value': 170, 'large_deque[16].value': 180 })
			.map(([name, value]) => `(int) ${name} = ${value}`)
	].join('\n')).join('\n');
}

test('accepts comparator top and heap storage without requiring sorted pop order', () => {
	assert.doesNotThrow(() => verifyNativeContainerAdaptors(transcript()));
});

test('accepts a scalar typedef in LLDB output', () => {
	assert.doesNotThrow(() => verifyNativeContainerAdaptors(transcript().replaceAll('(int)', '(value_type)')));
});

test('requires synthetic summaries for empty adaptors', () => {
	assert.throws(() => verifyNativeContainerAdaptors(transcript().replace('empty_stack = size=0', 'empty_stack = raw')),
		/empty_stack must expose a synthetic size/);
});

test('rejects a max heap with the wrong top', () => {
	assert.throws(() => verifyNativeContainerAdaptors(transcript().replace('max_heap[0] = 4', 'max_heap[0] = 1')),
		/max_heap must show its comparator's top first/);
});

test('rejects a custom min heap with the wrong top', () => {
	assert.throws(() => verifyNativeContainerAdaptors(transcript().replace('min_heap[0] = 1', 'min_heap[0] = 4')),
		/min_heap must show its comparator's top first/);
});

test('rejects stale children after an adaptor push', () => {
	assert.throws(() => verifyNativeContainerAdaptors(transcript().replace('vector_stack[3] = 9', 'vector_stack[3] = 6')),
		/vector_stack must follow bottom-to-top storage order/);
});

test('requires nested synthetic values at both stops', () => {
	assert.throws(() => verifyNativeContainerAdaptors(transcript().replaceAll('(int) nested_heap[0][0] = 3', 'nested_heap = raw')),
		/nested_heap\[0\]\[0\] must expose a synthetic scalar/);
});

test('requires the second real source breakpoint', () => {
	assert.throws(() => verifyNativeContainerAdaptors(transcript().replace('stop reason = breakpoint 2.1', 'unrelated stop')),
		/must reach both source breakpoints/);
});

test('rejects a deque child read from the previous memory block', () => {
	assert.throws(() => verifyNativeContainerAdaptors(transcript().replace('block_deque[1019] = 1024', 'block_deque[1019] = 0')),
		/block_deque\[1019\] must follow block and front-offset changes/);
});

test('rejects stale deque offsets after pop_front', () => {
	assert.throws(() => verifyNativeContainerAdaptors(transcript().replace('block_deque[0] = 6', 'block_deque[0] = 5')),
		/block_deque\[0\] must follow block and front-offset changes/);
});

test('requires the 16-element block layout for large deque values', () => {
	assert.throws(() => verifyNativeContainerAdaptors(transcript().replace('large_deque[15].value = 160', 'large_deque[15].value = 0')),
		/large_deque\[15\]\.value must follow block and front-offset changes/);
});
