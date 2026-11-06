#!/usr/bin/env node
// Native qualification host. Guest code, libc and GNU runtime implement TLS semantics.
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

if (!isMainThread) {
  const control = new Int32Array(workerData.control);
  const reply = (type, extra = {}) => parentPort.postMessage({ id: workerData.id, type, ...extra });
  let instance, stackTop, tlsBase, phase = 'new';
  parentPort.on('message', async message => {
    try {
      if (message.type === 'initialize') {
        assert.equal(phase, 'new'); phase = 'initializing'; reply('init-armed');
        if (Atomics.wait(control, 0, 0, workerData.timeoutMs) === 'timed-out') throw new Error('TLS initialization barrier timed out');
        const imports = { env: { memory: workerData.memory } };
        if (workerData.allowSchedYield) {
          const yieldControl = new Int32Array(new SharedArrayBuffer(4));
          imports.wasi_snapshot_preview1 = { sched_yield() { Atomics.wait(yieldControl, 0, 0, 1); return 0; } };
        }
        instance = await WebAssembly.instantiate(workerData.module, imports);
        const globals = {};
        for (const name of ['__stack_pointer', '__heap_base', '__data_end', '__tls_size', '__tls_align', '__tls_base']) {
          assert(instance.exports[name] instanceof WebAssembly.Global, 'Missing ' + name);
          assert.equal(typeof instance.exports[name].value, 'number'); globals[name] = instance.exports[name].value >>> 0;
        }
        if (workerData.reservedBytes !== undefined) {
          for (const name of ['__stack_low', '__stack_high']) {
            assert(instance.exports[name] instanceof WebAssembly.Global, 'Missing ' + name);
            globals[name] = instance.exports[name].value >>> 0;
          }
        }
        assert.equal(typeof instance.exports.__wasm_init_tls, 'function');
        assert.equal(instance.exports.__wasm_init_tls.length, 1);
        assert.equal(typeof instance.exports[workerData.entry], 'function');
        assert.equal(instance.exports[workerData.entry].length, workerData.arguments.length);
        if (workerData.cleanup) {
          assert.equal(typeof instance.exports[workerData.cleanup], 'function');
          assert.equal(instance.exports[workerData.cleanup].length, 0);
        }
        phase = 'initialized'; reply('initialized', { globals });
      } else if (message.type === 'configure') {
        assert.equal(phase, 'initialized'); phase = 'configuring';
        stackTop = message.stackTop; tlsBase = message.tlsBase;
        instance.exports.__stack_pointer.value = stackTop;
        assert.equal(instance.exports.__wasm_init_tls(tlsBase), undefined);
        assert.equal(instance.exports.__tls_base.value >>> 0, tlsBase);
        assert.equal(instance.exports.__stack_pointer.value >>> 0, stackTop);
        phase = 'configured'; reply('configured', { stackTop, tlsBase });
      } else if (message.type === 'run') {
        assert.equal(phase, 'configured'); phase = 'running'; reply('armed');
        if (Atomics.wait(control, 1, 0, workerData.timeoutMs) === 'timed-out') throw new Error('TLS execution barrier timed out');
        const started = Number(process.hrtime.bigint()) / 1e6;
        const value = instance.exports[workerData.entry](...workerData.arguments);
        assert(Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff);
        if (workerData.cleanup) assert.equal(instance.exports[workerData.cleanup](), undefined);
        const ended = Number(process.hrtime.bigint()) / 1e6;
        assert.equal(instance.exports.__stack_pointer.value >>> 0, stackTop);
        assert.equal(instance.exports.__tls_base.value >>> 0, tlsBase);
        assert.equal(workerData.memory.buffer.byteLength, workerData.memoryBytes);
        phase = 'done'; reply('done', { value, started, ended, cleanupCalled: Boolean(workerData.cleanup) });
      } else throw new Error('Unexpected TLS Worker command');
    } catch (error) { phase = 'failed'; reply('error', { error: String(error.stack || error) }); }
  });
}

export async function runTlsSharedProgram(input, options) {
  assert(isMainThread);
  assert(input instanceof Uint8Array);
  const { entry, initialPages, maximumPages, stackBytes, cleanup, reservedBytes } = options;
  const allowSchedYield = options.allowSchedYield === true;
  const timeoutMs = options.timeoutMs ?? 45000;
  assert(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry));
  assert(cleanup === undefined || /^[A-Za-z_][A-Za-z0-9_]*$/u.test(cleanup));
  assert(Number.isSafeInteger(initialPages) && initialPages > 0 && initialPages <= 8192 && maximumPages === initialPages);
  assert(Number.isSafeInteger(stackBytes) && stackBytes >= 4096 && stackBytes % 16 === 0);
  assert(reservedBytes === undefined || (Number.isSafeInteger(reservedBytes) && reservedBytes >= 16 && reservedBytes % 16 === 0));
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000);
  assert(Array.isArray(options.workerArguments) && options.workerArguments.length >= 1 && options.workerArguments.length <= 16);
  const argumentsByWorker = Array.from(options.workerArguments, row => {
    assert(Array.isArray(row) && row.length <= 64);
    return Array.from(row, value => { assert(Number.isInteger(value) && value >= -0x80000000 && value <= 0xffffffff); return value | 0; });
  });
  const module = await WebAssembly.compile(Uint8Array.from(input));
  const imports = WebAssembly.Module.imports(module);
  assert.deepEqual(imports.filter(item => item.kind === 'memory'), [{ module: 'env', name: 'memory', kind: 'memory' }]);
  for (const item of imports.filter(item => item.kind !== 'memory'))
    assert(allowSchedYield && item.module === 'wasi_snapshot_preview1' && item.name === 'sched_yield' && item.kind === 'function', 'Unexpected TLS runtime import');
  assert(imports.length <= (allowSchedYield ? 2 : 1));
  const memory = new WebAssembly.Memory({ initial: initialPages, maximum: maximumPages, shared: true });
  const memoryBytes = initialPages * 65536, controlBuffer = new SharedArrayBuffer(8), control = new Int32Array(controlBuffer);
  const report = { schemaVersion: 1, kind: 'native-tls-shared-execution', status: 'running',
    executionHost: 'Node worker_threads', cleanup: cleanup ?? null, workers: [], terminatedWorkers: 0 };
  const workers = [];
  let closed = false;
  try {
    for (const [id, arguments_] of argumentsByWorker.entries()) {
      const worker = new Worker(new URL(import.meta.url), { workerData: { id, module, memory, control: controlBuffer,
        entry, arguments: arguments_, cleanup, timeoutMs, memoryBytes, reservedBytes, allowSchedYield } });
      const events = [], listeners = new Set();
      const announce = event => { if (closed) return; events.push(event); for (const listener of listeners) listener(); };
      worker.on('message', message => announce(message.id === id ? message : { type: 'error', error: 'Wrong Worker id' }));
      worker.on('error', error => announce({ type: 'error', error: String(error) }));
      worker.on('exit', code => announce({ type: 'exit', code }));
      report.workers.push({ id, arguments: arguments_, events });
      const pending = new Set();
      workers.push({ worker, cancel() { for (const finish of pending) finish(new Error('TLS cohort disposed')); }, wait(type) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => finish(new Error(`Worker ${id}: ${type} timeout`)), timeoutMs);
          function finish(error, value) { clearTimeout(timer); listeners.delete(check); pending.delete(finish); if (error) reject(error); else resolve(value); }
          function check() {
            const error = events.find(event => event.type === 'error' || event.type === 'exit');
            const matches = events.filter(event => event.type === type);
            if (error) finish(new Error(JSON.stringify(error)));
            else if (matches.length > 1) finish(new Error('Duplicate Worker response: ' + type));
            else if (matches.length === 1) finish(null, matches[0]);
          }
          pending.add(finish); listeners.add(check); check();
        });
      } });
    }
    workers.forEach(({ worker }) => worker.postMessage({ type: 'initialize' }));
    await Promise.all(workers.map(worker => worker.wait('init-armed')));
    Atomics.store(control, 0, 1); Atomics.notify(control, 0, workers.length);
    const initialized = await Promise.all(workers.map(worker => worker.wait('initialized')));
    const globals = initialized[0].globals;
    for (const { globals: current } of initialized) {
      for (const name of ['__heap_base','__data_end','__tls_size','__tls_align','__stack_pointer',...(reservedBytes === undefined ? [] : ['__stack_low','__stack_high'])]) assert.equal(current[name],globals[name]);
    }
    const heapBase = globals.__heap_base, tlsSize = globals.__tls_size, alignment = globals.__tls_align;
    assert.equal(globals.__stack_pointer,heapBase); assert(globals.__data_end <= heapBase && heapBase <= memoryBytes);
    assert(Number.isSafeInteger(alignment) && alignment >= 1 && alignment <= 65536 && (alignment & (alignment - 1)) === 0);
    const align = (value, boundary) => Math.ceil(value / boundary) * boundary;
    if (reservedBytes !== undefined) {
      assert.equal(globals.__stack_high,heapBase);
      assert.equal(globals.__stack_high-globals.__stack_low,reservedBytes);
      assert(globals.__data_end <= globals.__stack_low && globals.__stack_low % 16 === 0);
    }
    let cursor = reservedBytes === undefined ? align(heapBase + 16,16) : globals.__stack_low;
    const tlsRegions = [], stackRegions = [], guards = [];
    for (const [id] of workers.entries()) {
      let low = 0, high = 0;
      if (tlsSize) {
        low = align(cursor + 16,alignment); high = low + tlsSize; cursor = high + 16;
        guards.push(low - 16,high);
      }
      tlsRegions.push({ id, low, high, alignment });
      const stackLow = align(cursor + 16,16), stackHigh = stackLow + stackBytes;
      guards.push(stackLow - 16,stackHigh); cursor = stackHigh + 16;
      stackRegions.push({ id, low: stackLow, high: stackHigh });
    }
    assert(cursor <= (reservedBytes === undefined ? memoryBytes : globals.__stack_high),'Private TLS and stacks exceed reserved memory');
    const view = new Uint8Array(memory.buffer);
    for (const offset of guards) view.fill(0xa5,offset,offset + 16);
    workers.forEach(({ worker },id) => worker.postMessage({ type: 'configure', tlsBase: tlsRegions[id].low, stackTop: stackRegions[id].high }));
    const configured = await Promise.all(workers.map(worker => worker.wait('configured')));
    configured.forEach((value,id) => { assert.equal(value.tlsBase,tlsRegions[id].low); assert.equal(value.stackTop,stackRegions[id].high); });
    workers.forEach(({ worker }) => worker.postMessage({ type: 'run' }));
    await Promise.all(workers.map(worker => worker.wait('armed')));
    Atomics.store(control,1,1); Atomics.notify(control,1,workers.length);
    const completed = await Promise.all(workers.map(worker => worker.wait('done')));
    const overlapMilliseconds = Math.min(...completed.map(value => value.ended)) - Math.max(...completed.map(value => value.started));
    if (workers.length > 1) assert(overlapMilliseconds > 0,'Guest calls did not overlap');
    for (const offset of guards) assert(view.subarray(offset,offset + 16).every(value => value === 0xa5),'Private TLS/stack guard changed');
    assert.throws(() => memory.grow(1),RangeError);
    const result = { values: completed.map(value => value.value), memory: Uint8Array.from(view), tlsRegions, stackRegions };
    Object.assign(report,{status:'passed',values:result.values,tlsRegions,stackRegions,globals,overlapMilliseconds,guardsUnchanged:true,fixedMemory:true,reservedBytes:reservedBytes ?? null,allowSchedYield,imports});
    return { ...result, report };
  } catch (error) {
    report.status = 'failed'; report.error = String(error.stack || error); error.tlsExecution = report; throw error;
  } finally {
    closed = true;
    for (const worker of workers) worker.cancel();
    await Promise.all(workers.map(async ({ worker }) => { await worker.terminate(); report.terminatedWorkers++; }));
  }
}
