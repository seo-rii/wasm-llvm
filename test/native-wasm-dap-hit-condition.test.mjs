import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exerciseNativeHitCondition } from './native-wasm-debug/run-native-hit-condition-baseline.mjs';

// Model LLDB's remaining ignore count, including the old adapter's empty-field
// bug, to prove this protocol scenario would catch both forms of that regression.
function adapter({ clearIgnored = true, unstableId = false, wrongLine = false } = {}) {
	let ignoreCount = 0;
	let n = 0;
	let updates = 0;
	let condition = '';
	const requests = [];
	return {
		requests,
		async request(command, args = {}) {
			requests.push({ command, arguments: args });
			if (command === 'setBreakpoints') {
				const breakpoint = args.breakpoints[0];
				if (!breakpoint) return { breakpoints: [] };
				const next = breakpoint.hitCondition ?? '';
				if (next !== condition) {
					condition = next;
					if (next) ignoreCount = Number(next) - 1;
					else if (clearIgnored) ignoreCount = 0;
				}
				return { breakpoints: [{ id: unstableId ? ++updates : 12, verified: true, line: 6 }] };
			}
			if (command === 'continue') {
				n += ignoreCount + 1;
				ignoreCount = 0;
			}
			if (command === 'stackTrace') return { stackFrames: [{ id: 91, name: 'probe',
				source: { path: '/workspace/hit-count.c' }, line: wrongLine ? 8 : 6 }] };
			if (command === 'scopes') return { scopes: [{ name: 'Locals', variablesReference: 42 }] };
			if (command === 'variables') return { variables: [{ name: 'n', value: String(n) },
				{ name: 'answer', value: String(n + 10) }] };
			return {};
		},
		async waitForEvent(event) {
			if (event === 'stopped') return { reason: 'breakpoint', threadId: 1 };
			if (event === 'exited') return { exitCode: 0 };
			return {};
		}
	};
}

test('qualifies DAP positive hit conditions on the third and subsequent hit', async () => {
	const client = adapter();
	const result = await exerciseNativeHitCondition(client, Promise.resolve(), { case: 'setting' });
	assert.deepEqual(result.stops.map((stop) => stop.n), ['3', '4']);
	assert.deepEqual(client.requests.filter((item) => item.command === 'setBreakpoints')
		.map((item) => item.arguments.breakpoints), [[{ line: 6, hitCondition: '3' }], []]);
	assert.ok(client.requests.some((item) => item.command === 'variables'));
});

for (const name of ['clear-omitted', 'clear-empty']) {
	test(`qualifies ${name} before execution and during a stopped call`, async () => {
		const client = adapter();
		const result = await exerciseNativeHitCondition(client, Promise.resolve(), { case: name });
		assert.deepEqual(result.stops.map((stop) => stop.n), ['1', '2']);
		const updates = result.updates.map((update) => update.specification);
		const clear = name === 'clear-empty' ? { line: 6, hitCondition: '' } : { line: 6 };
		assert.deepEqual(updates, [{ line: 6, hitCondition: '4' }, clear,
			{ line: 6, hitCondition: '4' }, clear]);
		assert.deepEqual(result.updates.map((update) => update.breakpoint.id), [12, 12, 12, 12]);
	});
	test(`rejects unpatched DAP behavior for ${name}`, async () => {
		await assert.rejects(exerciseNativeHitCondition(adapter({ clearIgnored: false }),
			Promise.resolve(), { case: name }), /wrong call stopped; use a patched lldb-dap/);
	});
}

test('rejects replacing a breakpoint instead of clearing the existing ID', async () => {
	await assert.rejects(exerciseNativeHitCondition(adapter({ unstableId: true }),
		Promise.resolve(), { case: 'clear-empty' }), /preserve breakpoint ID/);
});

test('rejects hits from the wrong source line', async () => {
	await assert.rejects(exerciseNativeHitCondition(adapter({ wrongLine: true }),
		Promise.resolve(), { case: 'setting' }), /requested source line/);
});
