# Swift browser target acceptance — 2026-09-05

The new acceptance command compiled the checked-in Swift fixture with native Swift **6.3.3**
and the full `swift-6.3.3-RELEASE_wasm` SDK. It then executed that program in Chromium
**149.0.7827.55**, using `@bjorn3/browser_wasi_shim` **0.4.2** and a fresh module Worker for
each case. Standard input was delivered in reads of at most three bytes.

| Case | Observed result |
| --- | --- |
| Integer sum, Korean text, final newline | `sum=60`, `text=안녕`, `eof=true` |
| Negative integer, final line without newline | `sum=4`, `text=last`, `eof=true` |
| Empty input | `sum=0`, `text=<eof>`, `eof=true` |

All cases returned exit code zero, exact stdout including newlines, and empty stderr.
The generated program imported only `wasi_snapshot_preview1` functions. A successful run
records the fixture and generated Wasm SHA-256 values, native compiler version, SDK identifier,
Chromium version, and actual case results in a fresh `out/swift-browser-target/probe-*` directory.

Reproduce with an installed official toolchain and SDK:

```sh
pnpm install --frozen-lockfile
pnpm probe:swift-browser-target -- --chromium /path/to/chromium
pnpm swift:test
pnpm check
```

The focused Swift suite passed **187 tests**, and the repository check passed for nine producers
and 117 Node modules. Browser acceptance and both checks exited zero.

This result establishes browser execution of a program built by a **native** compiler. It does
not produce or verify browser-hosted `swiftc.wasm`, `swiftpm.wasm`, or the full compiler bundle.
The receipt keeps those readiness gates false. The existing source-build and package contracts
remain necessary before exposing Swift compilation in `wasm-idle`.
