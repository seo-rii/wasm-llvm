# pthread-transport-v1

WAMR's source debugger performs GDB RSP I/O on its debug-control pthread.
Emscripten 6.0.0 intentionally does not copy arbitrary incoming `Module`
properties into pthread module realms. The WAMR browser producer bridges the
host's `shared-ring-v1` descriptors into every preloaded pthread without
proxying blocking I/O.

## Host input

Before module startup, the host provides:

```js
createWamrDebugModule({
	noInitialRun: true,
	wasmIdleDebugTransport: {
		rspInput: { descriptor: rx },
		rspOutput: { descriptor: tx }
	}
});
```

`rspInput` is LLDB-to-WAMR and `rspOutput` is WAMR-to-LLDB. A queue may be a
`SharedByteQueue` exposing `descriptor`, or the descriptor itself. Each
descriptor contains:

```ts
interface SharedRingV1 {
	control: SharedArrayBuffer;
	data: SharedArrayBuffer;
	generation: number;
}
```

Control cells 0 through 5 are `READ`, `WRITE`, `STATE`, `EPOCH`, `CAPACITY`,
and `INTERRUPT`. When cell 6 exists it contains `generation`. Capacity is a
power of two between 4 KiB and 16 MiB.

## Pthread handoff

The Emscripten JS library wraps `PThread.loadWasmModuleToWorker`. After the
original load promise resolves, it sends a structured-cloneable descriptor
message without a `cmd` field. The pthread module installs an
`addEventListener("message", ...)` listener and reconstructs typed-array views.
Emscripten's own pthread dispatcher ignores the command-less message.

The wrapper posts the descriptor before its load promise resolves. The pool
therefore cannot become ready before the descriptor is queued, and
`postMessage` ordering from the same sender guarantees that a later pthread
run message is handled after it.

The build uses a preloaded strict pool. It does not use `PROXY_TO_PTHREAD`.
`callMain()` runs on the already-dedicated target Worker and represents the
real WAMR main lifetime. The RSP imports execute and block directly on WAMR's
debug-control pthread. They have no Emscripten `__proxy` annotation because
proxying a blocking read to the application Worker can deadlock.

With `MODULARIZE` and `EXPORT_ES6`, Emscripten 6.0.0 uses its generated main
ES module as the pthread entry module. The producer packages an identical,
independently hashed `wamr-debug.worker.mjs` copy for that role. The host sets
`mainScriptUrlOrBlob` to that asset, and the main loader's built-in fallback
reference is rewritten to the same name.

## Lifecycle

- Closing either host queue stores a nonzero `STATE` and notifies `EPOCH`.
- Reads drain pending bytes before observing close.
- An empty open-ring timeout returns `0`, a closed ring returns `-2`, and a
  failed/stale ring returns `-1`.
- Interpreter stop and exit events increment the input ring's `INTERRUPT`
  counter and notify `EPOCH`. Reads retain their last observed counter across
  calls and return `-3` when it changes, so the debug-control loop immediately
  checks for a stopped thread. Pending bytes and close take precedence over an
  interrupt. Notifications received before a read or between its state check
  and atomic wait remain observable; the one-second read timeout is only a
  fallback for idle transport maintenance.
- Writes reject a closed queue.
- Stale generations and invalid cursor/capacity state fail the transport.
- stdout, stderr, stdin, and worker lifecycle events remain outside RSP.
- A target Worker and all of its Emscripten pthread workers are single-session.
