# GNU C++26 debugger functions on WASI

The optional `gnu-debugger-registration-v1` component compiles GCC's original
`libstdc++-v3/src/c++26/debugging.cc`. It supplies `std::is_debugger_present`,
`std::breakpoint`, and `std::breakpoint_if_debugging` from `<debugging>`. The GCC
frontend, Wasm backend, base GNU libraries, and default bundle remain unchanged.

The small `libstdc++debugger.a` contains that GNU implementation, not the other
experimental interfaces normally found in `libstdc++exp.a`. The pinned wasi-sdk
signal archive satisfies its real `raise` dependency. The public header does not
need signal-emulation macros in user code. This adds no custom Wasm host import.
Existing GNU and wasi-libc licenses remain included in the extended bundle.

## Observer registration contract

GCC defines the volatile integer
`__gnu_cxx::debugger_signal_for_breakpoint` specifically for debugger registration.
Its Wasm export name is `_ZN9__gnu_cxx30debugger_signal_for_breakpointE`. The
exported `WebAssembly.Global` contains the **address of C++ data in linear memory**;
changing the export value is not how the observer registers.

The supported host is a Chromium Worker controlled by an explicit CDP observer:

1. Attach to the particular execution Worker and successfully enable its
   `Debugger` domain. Merely opening DevTools or seeing an attached target does
   not register a debugger.
2. Before guest execution, read the exported address and write the four-byte
   little-endian signed integer `-1` through `instance.exports.memory`.
3. `std::is_debugger_present()` now observes that registered state. The guest does
   not write it on behalf of the debugger.
4. Clear the integer to `0` **before** disabling/detaching the observer. Terminate
   the run/Worker if observer control is lost unexpectedly; Chromium does not
   clear the GNU cell automatically.

The qualified harness performs the writes with CDP `Runtime.evaluate` and records
their acknowledgments and the actual four memory bytes. It does not infer
registration from `TargetInfo.attached` or promise automatic detection of other
DevTools or DWARF-extension sessions. The ordinary Node WASI path starts with
state `0`; native tests also exercise the GNU state transitions directly.

`std::breakpoint()` emits the backend's real `unreachable` instruction. A registered
conditional breakpoint does the same. With exception pauses enabled, CDP stops
in an actual Wasm frame. Resuming exposes the `WebAssembly.RuntimeError` and ends
the guest; this profile does not resume normal C++ execution after that call.
An unconditional breakpoint also traps without a debugger. Unregistered
`std::breakpoint_if_debugging()` returns normally. Positive signal registration
values, POSIX debugger discovery, resumable traps, and unrelated libstdc++exp APIs
are outside this profile.

## Build and package

The following commands consume an already qualified compiler and base GNU
runtime. They create new output directories and reopen their source/tool/library
identities. No compiler rebuild is required because no compiler source changes.

```sh
python3 producer/gcc-wasi/build-debugger-runtime.py \
  --work "$GCC_WASI_WORK_DIR" --gnu "$GCC_LIBSTDCXX_WORK_DIR" \
  --sdk "$WASI_SDK_PATH" --output "$DEBUGGER_RUNTIME"
node producer/gcc-wasi/test-debugger-native.mjs \
  --runtime "$DEBUGGER_RUNTIME" --output "$DEBUGGER_NATIVE"
node producer/gcc-wasi/package-debugger.mjs \
  --base "$BASE_BUNDLE" --runtime "$DEBUGGER_RUNTIME" \
  --qualification "$DEBUGGER_NATIVE/qualification.json" --output "$DEBUGGER_BUNDLE"
```

Packaging independently rebuilds the pinned GNU unit and all five native fixtures
and reruns both fresh and retained programs. It verifies the base manifest,
compiler/runtime provenance, and sysroot before adding exactly two archives.
Only `sysroot.tar`, the manifest, and associated measurements/proofs change.
Historical base proofs live under `provenance/base`; they retain their original
scope. The original and extended manifest qualification statuses remain
`unverified`. Qualification and publication remain separate operations.

On the same filesystem, preserved immutable bundle payloads can share hardlinks
to avoid duplicating compiler/proof data. Keep the base and extension immutable;
copy a file before changing it. Packaging also works across filesystems by
copying those payloads.

## SDK and actual Worker qualification

A bundle advertising `capabilities.debugger: true` must include both auxiliary
archives in its explicit runtime library list. The SDK accepts `c++26` and
`gnu++26` only for a verified WASI bundle with that capability, and conditionally
exports the GNU registration address. Older bundles and x86 GCC retain their
previous accepted standards and behavior. There is no new option that pretends
a debugger is connected.

The existing SDK harness compiles the guest with the actual Wasm-host GCC, WABT,
and LLD in a compiler Worker, then executes it with the SDK and independent Node
WASI. The separate CDP harness exercises retained native-compiler C++ probe
exports and the Wasm-host-compiler program's C++ main in execution Workers. Both
use the same pinned GNU debugger implementation. Native probes call the real
standard functions directly; the native program's main is separately checked by
Node WASI.

```sh
node "$SDK_ROOT/scripts/verify-gcc-wasi.mjs" \
  --manifest "$PRIVATE_QUALIFICATION_MANIFEST" \
  --suite "$PRODUCER_ROOT/producer/gcc-wasi/test-debugger-worker.mjs" \
  --save-intermediates --output "$DEBUGGER_SDK_QUALIFICATION"
node producer/gcc-wasi/test-debugger-worker.mjs \
  --runtime "$DEBUGGER_RUNTIME" \
  --native-qualification "$DEBUGGER_NATIVE/qualification.json" \
  --sdk-qualification "$DEBUGGER_SDK_QUALIFICATION/qualification.json" \
  --output "$DEBUGGER_HOST_QUALIFICATION" --chromium "$CHROMIUM_EXECUTABLE" \
  --shim "$WASI_SHIM_DIST" --temporary-root "$PRIVATE_TEMPORARY_ROOT"
```

The test suite covers disconnected and enabled-but-unregistered observers,
registration, clearing before detach, conditional and unconditional traps, and
clean new instances. Its guest source never changes the registration cell.
Private qualification manifests differ only in status and do not promote the
source bundle. Actual receipts retain compiler arguments, source and artifact
hashes, measured stdout, memory writes, paused Wasm frames, and cleanup results.
