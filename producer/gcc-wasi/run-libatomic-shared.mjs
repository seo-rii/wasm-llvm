#!/usr/bin/env node
// Native qualification host only. The guest implements every atomic helper.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { sharedCases, assertSharedLibatomicResult } from './libatomic-shared-fixtures.mjs';
import { nativeAtomicSharedCases, assertNativeAtomicSharedResult } from './atomics-native-fixtures.mjs';

if (!isMainThread) {
  const control = new Int32Array(workerData.control);
  let instance, top;
  const reply = (type, extra = {}) => parentPort.postMessage({ type, id: workerData.id, ...extra });
  parentPort.on('message', async message => {
    try {
      if (message.type === 'initialize') {
        reply('init-armed');
        if (Atomics.wait(control, 0, 0, 30000) === 'timed-out') throw new Error('Initialization barrier timed out');
        instance = await WebAssembly.instantiate(workerData.module, { env: { memory: workerData.memory } });
        for (const name of ['__stack_pointer', '__heap_base', '__data_end', '__tls_size']) {
          assert(instance.exports[name] instanceof WebAssembly.Global, `Missing ${name}`);
          assert.equal(typeof instance.exports[name].value, 'number');
        }
        reply('initialized', { stack: instance.exports.__stack_pointer.value >>> 0,
          heapBase: instance.exports.__heap_base.value >>> 0, dataEnd: instance.exports.__data_end.value >>> 0,
          tlsSize: instance.exports.__tls_size.value >>> 0 });
      } else if (message.type === 'configure') {
        top = message.top; instance.exports.__stack_pointer.value = top;
        reply('configured', { top: instance.exports.__stack_pointer.value >>> 0 });
      } else if (message.type === 'run') {
        reply('armed');
        if (Atomics.wait(control, 1, 0, 30000) === 'timed-out') throw new Error('Execution barrier timed out');
        const started = Number(process.hrtime.bigint()) / 1e6;
        const value = instance.exports[workerData.entry](...workerData.arguments);
        const ended = Number(process.hrtime.bigint()) / 1e6;
        assert.equal(instance.exports.__stack_pointer.value >>> 0, top, 'Guest did not restore its assigned stack');
        reply('done', { value, started, ended, stack: top });
      } else throw new Error('Unknown native qualification worker command');
    } catch (error) { reply('error', { error: String(error?.stack || error) }); }
  });
} else {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    assert(['--program', '--fixture', '--output'].includes(process.argv[i]));
    assert(process.argv[i + 1]); options[process.argv[i].slice(2)] = process.argv[i + 1];
  }
  const fixture = [...sharedCases, ...nativeAtomicSharedCases].find(item => item.id === options.fixture);
  assert(fixture, 'Unknown production libatomic shared fixture');
  const output = path.resolve(options.output); await fs.mkdir(output);
  const bytes = await fs.readFile(options.program), module = await WebAssembly.compile(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module), [{ module: 'env', name: 'memory', kind: 'memory' }]);
  const memory = new WebAssembly.Memory({ initial: fixture.request.sharedMemory.initialPages,
    maximum: fixture.request.sharedMemory.maximumPages, shared: true });
  const controlBuffer = new SharedArrayBuffer(8), control = new Int32Array(controlBuffer);
  const nativeWidth = fixture.kind === 'atomics-native-shared';
  const report = { schemaVersion: 1, kind: nativeWidth ? 'gcc-wasi-native-atomics-shared-execution' : 'gcc-wasi-native-libatomic-shared-execution',
    status: 'running', fixture: fixture.id, executionHost: 'Node worker_threads', workers: [], terminatedWorkers: 0 };
  const workers = fixture.run.workerArguments.map((arguments_, id) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { id, module, memory,
      control: controlBuffer, entry: fixture.request.sharedMemory.entry, arguments: arguments_ } });
    const events = [], listeners = new Set();
    const announce = event => { events.push(event); for (const listener of listeners) listener(); };
    worker.on('message', announce); worker.on('error', error => announce({ type: 'error', error: String(error) }));
    worker.on('exit', code => announce({ type: 'exit', code }));
    report.workers.push({ id, arguments: arguments_, events });
    return { worker, events, wait(type) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`Worker ${id}: ${type} timed out`)), 45000);
        const finish = (error, value) => { clearTimeout(timer); listeners.delete(check); if (error) reject(error); else resolve(value); };
        const check = () => {
          const error = events.find(event => event.type === 'error' || event.type === 'exit');
          const value = events.find(event => event.type === type);
          if (error) finish(new Error(JSON.stringify(error))); else if (value) finish(null, value);
        };
        listeners.add(check); check();
      });
    } };
  });
  try {
    workers.forEach(({ worker }) => worker.postMessage({ type: 'initialize' }));
    await Promise.all(workers.map(worker => worker.wait('init-armed')));
    Atomics.store(control, 0, 1); Atomics.notify(control, 0, workers.length);
    const initialized = await Promise.all(workers.map(worker => worker.wait('initialized')));
    const heapBase = initialized[0].heapBase;
    for (const entry of initialized) {
      assert.equal(entry.heapBase, heapBase); assert(entry.dataEnd <= heapBase);
      assert.equal(entry.stack, heapBase); assert.equal(entry.tlsSize, 0);
    }
    let cursor = Math.ceil((heapBase + 16) / 16) * 16;
    const regions = workers.map((worker, id) => {
      const low = cursor + 16, high = low + fixture.run.stackBytes;
      assert.equal(low % 16, 0); assert.equal(high % 16, 0);
      assert(high + 16 <= memory.buffer.byteLength, 'Worker stacks exceed fixed shared memory');
      cursor = high + 16;
      worker.worker.postMessage({ type: 'configure', top: high });
      return { id, low, high };
    });
    const configured = await Promise.all(workers.map(worker => worker.wait('configured')));
    configured.forEach((value, id) => assert.equal(value.top, regions[id].high));
    const view = new Uint8Array(memory.buffer);
    for (const region of regions) for (const offset of [region.low - 16, region.high]) view.fill(0xa5, offset, offset + 16);
    workers.forEach(({ worker }) => worker.postMessage({ type: 'run' }));
    await Promise.all(workers.map(worker => worker.wait('armed')));
    Atomics.store(control, 1, 1); Atomics.notify(control, 1, workers.length);
    const completed = await Promise.all(workers.map(worker => worker.wait('done')));
    const overlapMilliseconds = Math.min(...completed.map(value => value.ended)) - Math.max(...completed.map(value => value.started));
    assert(overlapMilliseconds > 0, 'Guest calls did not actually overlap');
    for (const region of regions) for (const offset of [region.low - 16, region.high]) {
      assert(view.slice(offset, offset + 16).every(value => value === 0xa5), 'Worker stack guard changed');
    }
    assert.throws(() => memory.grow(1), RangeError);
    const snapshot = new Uint8Array(memory.buffer).slice(), values = completed.map(value => value.value);
    report.observation = (nativeWidth ? assertNativeAtomicSharedResult : assertSharedLibatomicResult)(fixture, { values, memory: snapshot });
    report.values = values; report.stackRegions = regions; report.overlapMilliseconds = overlapMilliseconds;
    report.guardsUnchanged = true; report.fixedMemory = true;
    await fs.writeFile(path.join(output, 'memory.bin'), snapshot);
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = String(error?.stack || error); process.exitCode = 1; }
  finally {
    // A trap, timeout or setup failure always discards the entire cohort and
    // its shared memory. Await actual termination before returning any result.
    await Promise.all(workers.map(async ({ worker }) => { await worker.terminate(); report.terminatedWorkers++; }));
    await fs.writeFile(path.join(output, 'execution.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ status: report.status, values: report.values, observation: report.observation }));
}
