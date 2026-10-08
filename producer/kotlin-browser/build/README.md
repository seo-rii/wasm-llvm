# Official bootstrap reference build

These tools acquire the official `2.5.0-dev-10106` compiler selected as the
bootstrap by Kotlin commit `4d78aae1e337cd40f69baa865aed950fe807a775`. They do not
build that source commit's compiler and do not compile Kotlin inside a browser.
The compiler's source commit is unknown and remains `null` in receipts.

From the repository root:

```sh
node producer/kotlin-browser/build/bootstrap.mjs prepare
node --experimental-wasm-exnref producer/kotlin-browser/build/baseline.mjs --output out/kotlin-browser-baseline/my-fresh-run
node --test producer/kotlin-browser/build/*.test.mjs
```

The output directory must be new. The prepare command verifies cached artifacts
and reuses matching Gradle-cache bytes before downloading. Its nine pinned files
total about 71 MiB, including separate JVM, wasmJs and wasmWasi standard
libraries. Binary sizes and SHA-256 values are pinned in `bootstrap.lock.json`;
all bytes are verified before the compiler executes. The installed JVM is
recorded separately from the upstream build's JDK requirement.

The reference build invokes the official `KotlinWasmCompiler`, first producing
a KLIB and then linking that KLIB with the matching official wasmWasi stdlib.
Language/API version 2.4, bounds checks, assertions and the new exception
proposal are explicit options. Node 24.1.0 needs `--experimental-wasm-exnref`
to validate this profile; Chromium must be validated independently.

`receipt.json` binds each copied source and generated Wasm to its hash, records
the actual import/export list, `_start`, exported memory and start section, and
keeps execution results `not-run`. Each completed case also has a separate
build receipt. Expected Hello World and Fibonacci output is a test assertion,
not an observed execution result. The browser consumer records its actual runs
in separate evidence.

The published stdlib in these builds is unpatched. The candidate-source WASI
allocation patch is a different input and has not been rebuilt by these tools.
R0/R1 at the selected source commit, the browser compiler, and public Kotlin
readiness remain unverified. No compiler artifacts, KLIBs or generated programs
are checked into this producer directory.
