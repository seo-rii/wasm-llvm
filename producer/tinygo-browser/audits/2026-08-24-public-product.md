# TinyGo public browser product audit

Date: 2026-08-24

## Conclusion

The public `TINYGO` path is the receipt-bound upstream TinyGo 0.40.1 compiler, not the legacy
wasm-idle AST-to-C subset. It uses the pinned Go 1.24.6 package-graph provider, TinyGo's real
builder/compiler packages, LLVM/Clang/LLD 20.1.1, and Binaryen 129. The public wasm-idle bundle
contains only `upstream.js`, disposable Worker chunks, and the verified toolchain assets; it does
not publish or fall back to the legacy `runtime.js` implementation.

## Producer evidence

- Workflow: [TinyGo browser compiler producer run 32684251651](https://github.com/seo-rii/wasm-llvm/actions/runs/32684251651)
- Head: `0302d42e3b1506c761650669fdec589f9301129f`
- Result and duration: success, 11 minutes 5 seconds
- Artifact: `tinygo-browser-0302d42e3b1506c761650669fdec589f9301129f`, id `9505308308`
- Compile protocol: v6, identity mode `upstream-package-graph`

| Product file | Bytes | SHA-256 |
| --- | ---: | --- |
| `tinygo-compiler.wasm` | 70,288,208 | `8cef7783f7c998606a86e72d78fc7b22d030a95c29bc5530d0b70f31f3c7ae22` |
| `tinygo-package-graph.wasm` | 25,870,831 | `b7b28719bf97d5c5e140c3ec6f8f40a40fc7d02216e0160e460a34b79f61cb14` |
| `tinygoroot.tar.gz` | 28,919,804 | `a1d9e2e00699b2de96fab87deb104a57c2bdc714163f9e6f129d19e20f2cd665` |
| `lld.wasm` | 20,795,796 | `14f08c475b24ef45313cab7a086693525955c2c000b833faaaf48ad35b2521f8` |
| `producer-receipt.json` | 7,572 | `48f0a4a2729cea41d75032281e89b1111e197b68ce4baba8767af64997743d2c` |
| `package-graph-provider-receipt.json` | 10,368 | `98a3aac1c0aed9e447d92bace9a138397edc18102feda62cfe455c1f0ec48506` |
| `tinygo-source-receipt.json` | 6,009 | `28b3d929596e6f2bf02cab39908d502938bcda7e752fb67bcdfd3f90b9d2ee7a` |

The producer acceptance and strict artifact verifier passed before upload. The final producer fix
also preserves empty `cgoInputs` and `cgoLinkerFlags` as JSON arrays; this is required for ordinary
programs that have no CGo link inputs.

## Independent consumer evidence

The wasm-idle consumer compiled and executed two workspaces from the downloaded artifact:

| Consumer | Result | Receipt SHA-256 |
| --- | --- | --- |
| Node, public default program | protocol v6, 43 packages, stdout `fibonacci=11\n` | `2251e10f97164912e0686b61772e4fca4e099aa99e04d29285c99a7aabdd559a` |
| Node, independent CGo/C/C++/assembly/embed workspace | protocol v6, 46 packages | `eb699ff4714de30e770e6539f287649441413823730b1be266faaec46ae695db` |
| Headless Chromium 147, same independent workspace | protocol v6, 46 packages | `e2821350073547754babfffaa1c7449d7155380a3a9bfc3f8e4da5420aaf2b4a` |

The rich Node and Chromium consumers produced identical bytes and SHA-256 values for the program,
target C, hosted C++, Clang assembly, and `go:embed` objects, as well as the unoptimized and final
Wasm modules. Both executed with exit status 0, empty stderr, and exact stdout:

```text
hello Ada count=2 total=3 semantics=9/9 cgo=5/20 cxxasm=16
```

The final Wasm was 253,126 bytes with SHA-256
`8f2898450a6a63aff207d065042aadced885f9a031694113dbcdc46832b8a74d`.

## Public wasm-idle path

The generated static bundle uses the same product hashes. The gzip root is stored as
`tinygoroot.tar.gz.bin` so HTTP servers do not transparently decode it; its bytes remain identical
to the producer archive. The public page probe ran in a cross-origin-isolated Chromium context,
selected `TINYGO`, loaded the verified assets, completed every Worker phase, accepted stdin `5`,
and printed `fibonacci=11` with no page errors. The compiler Worker uses a 2 GiB wasm32 memory
ceiling and phase deadlines; the worker is terminated on timeout, abort, or crash.

## Deliberate profile limits

- target: `wasip1` only;
- no implicit network module download; complete offline vendor trees are supported;
- no C++ exceptions, RTTI, threads, or global constructors/destructors;
- only receipt-approved C++ and linker flags;
- Clang assembler-with-cpp is supported, but Go/Plan 9 assembly remains unavailable because the
  pinned upstream TinyGo loader does not select it for this target.

These are explicit compatibility boundaries of the upstream profile, not locally reimplemented
language semantics.
