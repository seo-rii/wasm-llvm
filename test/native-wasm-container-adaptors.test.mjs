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
		'(int) nested_heap[0][1] = 4'
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
