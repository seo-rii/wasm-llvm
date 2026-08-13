# Emscripten LLD browser artifacts

This directory preserves and verifies the canonical LLVM 16.0.4 Emscripten LLD artifact set used
by older compiler producers. `manifest.json` pins the LLVM source commit and
`artifacts/producer-receipt.json` records the exact files, sizes, and SHA-256 hashes.

```sh
pnpm verify:emscripten-lld-artifacts
```

The current files are imported canonical artifacts. Their original Emscripten build invocation was
not recorded, so they must not be regenerated from an inferred command. A future replacement must
add a source-to-artifact build script, pin the Emscripten toolchain, and produce a new receipt before
these files are changed. Consumers deploy the verified files to static hosting; they are not npm
package content.
