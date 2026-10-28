# Qualified C3 browser compiler

These are the C3 0.8.5_1 browser compiler assets qualified by
[`producer/c3-browser`](../../producer/c3-browser/README.md). The receipt binds the
loader and uncompressed Wasm module to the locked source, patches, fresh SDK build,
and successful Node/Chromium compile, link, diagnostic, and byte I/O checks.

`c3c.wasm.gz` is a level-9 gzip delivery copy of the qualified `c3c.wasm`; decompress
it before passing the three-file bundle to the producer's strict verifier. The
consumer must verify both the compressed delivery receipt and the uncompressed
asset receipt. This directory contains no application-specific Worker wrapper.

Consumers can pin this directory by immutable Git commit and generate their own
Worker from their reviewed source and this producer receipt. Replacing these
files requires a new complete producer build and both acceptance runs.
