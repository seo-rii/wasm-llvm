# Official compiler source preparation

`closure.lock.json` is a source-root inventory for an actual `wasmJs` compiler
build attempt at Kotlin commit `4d78aae1e337cd40f69baa865aed950fe807a775`.
It contains 3,908 verified inputs (25,340,879 bytes), including 3,417 selected
Kotlin files and the corresponding generated Java/schema inputs. It is a build
candidate: successful source preparation does not prove that its symbol closure
is complete or that the compiler runs in a browser.

`compile`, `language` and `role` describe source selection. Java inputs are
recorded for real portable host/codec replacements; they cannot be compiled for
`wasmJs`. CLI drivers, other platform session factories and build-time generators
are not compiled. Required common/Wasm checkers, resolution, inlining and backend
phases must retain their official implementations.

Prepare the checked-in source pins into a fresh output directory:

```sh
python3 -B producer/kotlin-browser/compiler-port/closure.py prepare \
  --output out/kotlin-compiler-port-reproduction
python3 -B producer/kotlin-browser/compiler-port/closure.test.py
```

This command downloads exact source bytes from the pinned revision, verifies
byte count, Git blob SHA-1 and SHA-256, and publishes `inputs.json` only after
every input passes. Existing source bytes are reverified. Paths, file sizes,
duplicate entries and symlinks are rejected before they can select outside
inputs. A failed preparation can leave verified individual source files, but
does not publish a success receipt. Run long preparation commands with the
workspace's private background log/exit-sidecar workflow.

`inventory` creates a new lock from complete cached Git tree snapshots, checking
their Git tree identities and ancestry against the pinned root tree. It is an
explicit inventory-update operation, not a required network Git API dependency
for reproducing an existing lock. Output lock and receipt paths must be fresh.

`closure.references.lock.json` separately records 100 official generator and CLI
reference inputs (801,640 bytes), including `FirSessionConstructionUtils`, the
Web FIR2IR/KLIB phases, the Wasm IR loading/lowering/linking/output phases and the
FIR checkers component generator. All have `compile: false`. It preserves the
initial build candidate lock while making the official entry's dependencies
traceable. Reproduce those sources with `prepare --lock
producer/kotlin-browser/compiler-port/closure.references.lock.json --output
out/kotlin-compiler-port-references`.

The source preparation receipt says `compilerBuild: not-run`, `browserCompiler:
not-built`, and `languageReadiness: false`. Actual build/run evidence belongs to
the compiler entry and build tool; source hashes do not establish runtime
behavior. No precompiled user program or alternative emitter fills this boundary.
