import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';

const source = await readFile(
	new URL('../src/wasm-debug-transport.js', import.meta.url),
	'utf8'
);

function createDescriptor(interrupt = 0) {
	const control = new SharedArrayBuffer(7 * Int32Array.BYTES_PER_ELEMENT);
	const data = new SharedArrayBuffer(4096);
	const header = new Int32Array(control);
	Atomics.store(header, 4, 4096);
	Atomics.store(header, 5, interrupt);
	Atomics.store(header, 6, 1);
	return { control, data, generation: 1 };
}

function loadTransport(librarySource, input, output, atomicOperations = Atomics) {
	const context = {
		Atomics: atomicOperations,
		Date,
		Int32Array,
		SharedArrayBuffer,
		Uint8Array,
		HEAPU8: new Uint8Array(32),
		LibraryManager: { library: {} },
		mergeInto(target, library) {
			Object.assign(target, library);
		}
	};
	vm.runInNewContext(librarySource, context);
	const library = context.LibraryManager.library;
	const transport = library.$WasmIdleDebugTransportV1;
	context.WasmIdleDebugTransportV1 = transport;
	assert.equal(transport.setTransport({ rspInput: input, rspOutput: output }), true);
	return { library, transport, heap: context.HEAPU8 };
}

async function createReader(context, input, output, gate) {
	const worker = new Worker(
		`
		const { parentPort, workerData } = require('node:worker_threads');
		const vm = require('node:vm');
		const assert = require('node:assert/strict');
		const loadTransport = ${loadTransport.toString()};
		const atomicOperations = new Proxy(Atomics, {
			get(target, property) {
				if (property !== 'wait') return target[property];
				return (...args) => {
					parentPort.postMessage({ waiting: true });
					if (workerData.gate) Atomics.wait(new Int32Array(workerData.gate), 0, 0);
					return Atomics.wait(...args);
				};
			}
		});
		const { library } = loadTransport(workerData.source, workerData.input, workerData.output, atomicOperations);
		parentPort.on('message', () => {
			const result = library.wasm_idle_rsp_read(0, 1, 3000);
			parentPort.postMessage({ result });
		});
		parentPort.postMessage({ ready: true });
		`,
		{ eval: true, workerData: { source, input, output, gate } }
	);
	context.after(() => worker.terminate());
	const [ready] = await once(worker, 'message');
	assert.deepEqual(ready, { ready: true });
	return worker;
}

test('stop notification before a read remains pending across calls', () => {
	const input = createDescriptor();
	const { library, heap } = loadTransport(source, input, createDescriptor());
	library.wasm_idle_rsp_interrupt();
	library.wasm_idle_rsp_interrupt();
	new Uint8Array(input.data)[0] = 65;
	Atomics.store(new Int32Array(input.control), 1, 1);
	assert.equal(library.wasm_idle_rsp_read(0, 1, 0), 1);
	assert.equal(heap[0], 65);
	assert.equal(library.wasm_idle_rsp_read(0, 1, 0), -3);
	assert.equal(library.wasm_idle_rsp_read(0, 1, 0), 0);
});

test('a stop in another worker wakes a blocked packet read', { timeout: 5000 }, async (context) => {
	const input = createDescriptor();
	const output = createDescriptor();
	const { library } = loadTransport(source, input, output);
	const worker = await createReader(context, input, output);
	const waiting = once(worker, 'message');
	worker.postMessage('read');
	assert.deepEqual((await waiting)[0], { waiting: true });
	const completed = once(worker, 'message');
	library.wasm_idle_rsp_interrupt();
	assert.deepEqual((await completed)[0], { result: -3 });
});

test('a stop between checking the ring and waiting cannot be lost', { timeout: 5000 }, async (context) => {
	const input = createDescriptor();
	const output = createDescriptor();
	const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
	const { library } = loadTransport(source, input, output);
	const worker = await createReader(context, input, output, gate);
	const waiting = once(worker, 'message');
	worker.postMessage('read');
	assert.deepEqual((await waiting)[0], { waiting: true });
	const completed = once(worker, 'message');
	library.wasm_idle_rsp_interrupt();
	Atomics.store(new Int32Array(gate), 0, 1);
	Atomics.notify(new Int32Array(gate), 0);
	assert.deepEqual((await completed)[0], { result: -3 });
});

test('interrupt counters wrap and close takes precedence over a pending stop', () => {
	const input = createDescriptor(-1);
	const { library } = loadTransport(source, input, createDescriptor());
	library.wasm_idle_rsp_interrupt();
	assert.equal(library.wasm_idle_rsp_read(0, 1, 0), -3);
	assert.equal(library.wasm_idle_rsp_read(0, 1, 0), 0);
	library.wasm_idle_rsp_interrupt();
	Atomics.store(new Int32Array(input.control), 2, 1);
	assert.equal(library.wasm_idle_rsp_read(0, 1, 0), -2);
});

test('a stale application worker cannot interrupt a replacement session', () => {
	const input = createDescriptor();
	const { library } = loadTransport(source, input, createDescriptor());
	const header = new Int32Array(input.control);
	Atomics.store(header, 6, 2);
	library.wasm_idle_rsp_interrupt();
	assert.equal(Atomics.load(header, 5), 0);
	assert.equal(Atomics.load(header, 3), 0);
	assert.equal(library.wasm_idle_rsp_read(0, 1, 0), -1);
});
