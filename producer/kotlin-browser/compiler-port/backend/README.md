This patch family connects the selected official Wasm backend to a browser
compiler host with bounded memory output. It retains the official whole-program
code-generation and IR-linking helper bodies from the pinned CLI driver; their
complete source slices and hashes are checked before generation.

`ByteWriter` and LEB128 keep the official byte algorithms with a common byte sink.
The JVM filesystem result writer is excluded from this compiler profile.
`BrowserWasmWriter.kt` uses the official IR linker and `WasmIrToBinary` converter
to return bytes; it does not encode Kotlin or Wasm instructions itself. The first
profile requires raw wasmWasi output, normal exceptions and a bounded artifact.

The source preparation is part of `../build.mjs`. It checks original blob/byte
hashes, patch applicability and reversal, transformed source hashes and the
unmodified code-generation slices. The whole compiler build still fails on other
real source dependencies. Backend integration and source-to-program correctness
have not executed. The independent official byte-writer probe verifies its own
small boundary and cannot stand in for a browser compiler.
