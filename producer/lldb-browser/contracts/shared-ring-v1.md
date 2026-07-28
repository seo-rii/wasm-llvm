# shared-ring-v1

`shared-ring-v1` is the transport ABI between the Emscripten LLDB module and
its JavaScript host. It carries bytes only. DAP and GDB RSP framing remain at
their protocol layers.

## Registry

Before module initialization, the host passes:

```js
const registry = {
  protocol: "shared-ring-v1",
  sessions: {
    [sessionId]: {
      dap: { connectionId: 1, rx, tx },
      rsp: { connectionId: 2, rx, tx },
    },
  },
};
```

The same factory call must set
`mainScriptUrlOrBlob` to the absolute URL of the packaged
`lldb-web-dap.pthread.mjs`:

```js
const module = await createLldbWebDapModule({
  noInitialRun: true,
  wasmLldbSharedRingV1: registry,
  mainScriptUrlOrBlob: pthreadWorkerUrl,
});
```

`pthreadWorkerUrl` must be a string; callers using `URL` construct it with
`.href`. Passing the registry after the module factory has resolved is too
late because Emscripten creates its pthread pool during module startup.
The session/channel topology is immutable after that factory call. Ring data
and control state remain mutable because their `SharedArrayBuffer` instances
are shared, but adding a plain-object session later would not update the
structured clones already installed in pthread realms.

`rx` is host-to-LLDB and `tx` is LLDB-to-host. Each direction is:

```ts
interface SharedRingV1 {
  control: SharedArrayBuffer; // at least 6 Int32 cells
  data: SharedArrayBuffer; // capacity bytes
}
```

`connectionId` is a positive, session-generation-unique safe integer.

Emscripten 6.0.0's `EXPORT_ES6 + MODULARIZE + pthreads` path starts every
pthread realm by invoking the generated factory with an empty `moduleArg`.
Custom `Module` properties are therefore not inherited by a pthread. This
producer uses `PROXY_TO_PTHREAD` so LLDB's blocking `main` cannot starve
Emscripten filesystem operations that proxy to the module worker. Its JS
library sends a structured-clone bootstrap message to each worker immediately
after allocation. The packaged pthread sidecar installs the registry on
`globalThis` before it imports the generated module, then hands the queued
Emscripten load message to Emscripten's handler. `SharedArrayBuffer` objects
remain shared across that clone.

The bootstrap message and the later Emscripten load message are posted by the
same parent worker, so Web Worker message ordering makes the registry visible
first. Connection ids returned by `open` consequently resolve to the same
endpoint from every pthread realm.

## Control cells

The control buffer is viewed as an `Int32Array`:

| Cell | Name        | Meaning                                                  |
| ---: | ----------- | -------------------------------------------------------- |
|    0 | `READ`      | Monotonic unsigned read cursor                           |
|    1 | `WRITE`     | Monotonic unsigned write cursor                          |
|    2 | `STATE`     | `0=open`, `1=closed`, `2=failed`                         |
|    3 | `EPOCH`     | Incremented and notified after every state/cursor change |
|    4 | `CAPACITY`  | Must equal `data.byteLength`                             |
|    5 | `INTERRUPT` | Monotonic interrupt generation                           |

Capacity must be a power of two, between 4 KiB and 16 MiB, and less than
`2^31`. At most `CAPACITY` bytes may be outstanding. Cursor arithmetic is
unsigned 32-bit arithmetic; the capacity bound makes wrap-around unambiguous.

The producer's reference JS library uses `Atomics.wait()` and `Atomics.notify()`.
The host must not execute it on a Window main thread.

## Imported functions

The C ABI is:

```c
int32_t wasm_lldb_shared_ring_open(
    const char *session, uint32_t session_length, uint32_t channel);
int32_t wasm_lldb_shared_ring_read(
    int32_t connection, uint8_t *destination, uint32_t length,
    int64_t timeout_microseconds);
int32_t wasm_lldb_shared_ring_write(
    int32_t connection, const uint8_t *source, uint32_t length);
int32_t wasm_lldb_shared_ring_interrupt(int32_t connection);
int32_t wasm_lldb_shared_ring_close(int32_t connection);
```

Channels are `0=dap` and `1=rsp`. Timeout `-1` means infinite, `0` means poll,
and a positive value is a relative timeout.

`open` returns the endpoint's positive `connectionId`, or `-1` on failure.

Read/write return a non-negative byte count, or:

| Value | Name        | LLDB mapping                                   |
| ----: | ----------- | ---------------------------------------------- |
|  `-1` | error       | `eConnectionStatusError`                       |
|  `-2` | timed out   | `eConnectionStatusTimedOut`                    |
|  `-3` | interrupted | `eConnectionStatusInterrupted`                 |
|  `-4` | closed      | `eConnectionStatusEndOfFile` / lost connection |

Reads and writes may be partial. A zero-length operation succeeds with zero;
a positive-length operation never returns zero while the endpoint is open.
Closing or interrupting an endpoint must wake blocked readers and writers.
Implementations must sample `EPOCH` before checking cursor/state values and
wait only while that sampled value is unchanged, so a concurrent update cannot
be lost between the check and `Atomics.wait()`. If bytes and an interrupt are
both pending, a read returns the bytes first and leaves the interrupt pending
for the next read, matching `lldb_private::Connection`.

## Isolation and lifecycle

- `sessionId` is opaque, non-empty UTF-8 and scoped to one launch generation.
- The host rejects opens for absent or stale sessions.
- DAP and RSP use distinct ring pairs.
- stdout, stderr, stdin, and lifecycle events do not use either ring pair.
- A disconnect closes both directions and notifies `EPOCH`.
- Reusing a session id before all old workers have terminated is forbidden.
- Native `main` runs on a proxied pool pthread. The LLDB module worker remains
  available for Emscripten runtime operations, and every pool worker uses the
  packaged pthread bootstrap.
- The host observes Emscripten `onExit` and `onAbort` for adapter lifecycle.
  Returning from the JavaScript `callMain` invocation is not itself a
  cross-worker lifecycle protocol.
