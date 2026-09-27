# Locked precompiled crate producer (phase 1)

`../scripts/build-crate-registry.mjs` builds an **explicit, already resolved DAG** of
multi-file Rust library crates into `.rlib` files and deterministic gzip delivery
files. It writes a receipt-bearing registry index last. It does not invoke Cargo,
contact a registry, execute build scripts, or publish a release.

This is a producer-side foundation, not an enabled browser package feature.
`wasm-idle` must not select this registry before a compatible producer build,
real browser consumer probe, release, and consumer receipt update. This change
neither replaces the shipped sysroot nor changes a default producer command.

## Supported profile

- Entry paths such as `src/lib.rs`, sibling modules, nested `mod.rs`, and declared
  ordinary resource files are snapshotted into each crate's private work tree.
- The caller supplies exact package versions, resolved features, and dependency
  IDs. Dependency aliases are passed as `--extern alias=path`; the transitive
  closure alone is copied into `-L dependency=...`.
- Edition 2021/2024; a single WASI target per registry; `rlib`, panic-abort, O2,
  one codegen unit, no debuginfo. The fixed profile is part of every build key.
- Crates with `build.rs`, proc macros, Cargo build dependencies, native C build
  steps, arbitrary rustc flags, dynamic feature resolution, or Cargo-provided
  compile-time environment are outside this profile. `Cargo.toml` can be listed
  as data but is never interpreted. Dependency targets are always library crates.

A library being written in Rust alone does not establish that it fits this
profile. No named crates.io package or browser compatibility is claimed merely
because the producer tests pass.

## Trust and build environment

Run this utility only on **curated, audited source** inside the existing isolated
producer environment, with no secrets, immutable input mounts, restricted
filesystem visibility, no network, and external CPU/memory/disk/process limits.
It is not a sandbox: even without `build.rs`, compiler input can read files using
macros such as `include_str!`. Subprocess timeout and path/inventory checks do not
prevent that. The supplied compiler is trusted executable code.

Use the native companion rustc built from the same patched Rust/LLVM producer
checkout and the exact target sysroot used by the browser compiler. An unrelated
system rustc with the same version string is not a replacement. The plan pins
producer-manifest bytes, compiler executable bytes, exact `rustc -vV` output, and
target-library inventory. The manifest records the producer source commit and
patched tree. The executable hash alone does not attest its host dynamic
libraries; retain the producer image/build receipt too.

Those checks bind selected inputs, not all Rust artifact compatibility rules.
Only a real compile/link/run with the matching browser rustc can demonstrate
that these metadata and object files work together. Consequently **every output
is marked `promotion: "requires-browser-consumer-probe"`**, with no flag that
turns that marker into an approval. The consumer must fail closed on unpromoted
or unknown toolchain/target/profile combinations.

## Layout and plan

The source root contains one directory per locked crate ID. Include every file
in each directory in its inventory (including licenses and Cargo.toml when
present); extra files, symlinks, changed bytes, or an omitted entry are rejected.

```text
sources/
  math-0_1_0/
    src/lib.rs
    src/arithmetic.rs
    LICENSE
  example-0_1_0/
    src/lib.rs
    LICENSE
```

Schema illustration below: the angle-bracket values are placeholders, not valid
receipts. Replace them with lowercase SHA-256 values obtained from the reviewed
inputs. `bytes` must equal the corresponding actual file byte count.

```json
{
  "schemaVersion": 1,
  "target": "wasm32-wasip1",
  "producerManifestSha256": "<64-hex-digest>",
  "rustcExecutableSha256": "<64-hex-digest>",
  "rustcVersionSha256": "<64-hex-digest-of-exact-verbose-output>",
  "sysrootInventorySha256": "<64-hex-inventory-digest>",
  "crates": [{
    "id": "math-0_1_0",
    "name": "math",
    "version": "0.1.0",
    "edition": "2024",
    "entry": "src/lib.rs",
    "features": [],
    "dependencies": {},
    "sources": [
      { "path": "src/lib.rs", "bytes": 123, "sha256": "<64-hex-digest>" },
      { "path": "src/arithmetic.rs", "bytes": 456, "sha256": "<64-hex-digest>" },
      { "path": "LICENSE", "bytes": 789, "sha256": "<64-hex-digest>" }
    ]
  }]
}
```

A dependent crate declares e.g. `"dependencies": { "numbers": "math-0_1_0" }`.
The name in user Rust code is then `numbers`; alias and package identity are
not conflated. Missing IDs, cycles, duplicate IDs/features, unsafe paths, and
unknown plan fields are rejected before any compiler process is started.

Use the exported `inventoryDirectory(directory)` helper to obtain canonical
`files` and `sha256`. The inventory hash covers UTF-8
`JSON.stringify(files, null, 2) + '\n'`, with records sorted by full relative path
and fields in `path`, `bytes`, `sha256` order. Inventory the **target lib directory**
`<sysroot>/lib/rustlib/<target>/lib`, not the whole host toolchain root. Feature
lists and crate definitions are sorted before build-key generation. The exact
verbose-version hash includes the terminating newline emitted by rustc.

## Run

Run from the repository root with Node 20 or newer on the producer's Linux host.
The output parent must already exist; the output itself must not exist or be
inside the source/sysroot input trees. Pass the real native compiler executable,
not a rustup symlink that selects a mutable default toolchain.

```sh
node producer/rust-browser/scripts/build-crate-registry.mjs \
  --plan /inputs/crates.lock.json \
  --sources /inputs/crates \
  --sysroot /inputs/matching-toolchain \
  --rustc /inputs/matching-toolchain/bin/rustc \
  --producer-manifest producer/rust-browser/manifest.json \
  --out /output/crates-p1
```

Each compiler process receives only PATH, LANG, LC_ALL, TZ, HOME and TMPDIR;
RUSTFLAGS, Cargo/rustup wrappers, preload hooks and operator environment variables
are not inherited. The imported `buildCrateRegistry` API also accepts an
AbortSignal and `timeoutMs` (default 120000, maximum 600000).

Limits include 64 crates; 1024 files per crate; 8192 files and 64 MiB of source in
aggregate; 8 MiB per source; 4096 files and 512 MiB for the target-library
inventory; 64 MiB per output rlib and 256 MiB of raw rlibs in aggregate. The
subprocess output capture is capped at 4 MiB. These are not process memory or
filesystem quotas; enforce those in the outer build environment.

Output files use a **recipe key**, not the output digest, in their names. Keys
include compiler/sysroot/provenance identities, every declared source receipt,
resolved features and dependent recipe keys. The registry separately records
raw/gzip lengths and SHA-256 content receipts. Identical fake-compiler inputs are
reproducible in tests; actual rustc reproducibility requires the pinned producer
image, native companion, and probe run. The utility does not promise that merely
matching a recipe key proves identical output bytes.

On failure the newly reserved output directory is removed; an existing output
is never overwritten. Partial output is not publishable: `registry.v1.json` is
written only after all crates succeed, the compiler/sysroot identities are
rechecked, and private work trees are removed. Archive-magic checking is only a
basic structural check, not proof of valid Rust metadata.

## Required promotion and deferred consumer work

Before any release, compile at least one browser program against every entry,
then test dependency aliases, transitive and diamond graphs, alternate resolved
features, mismatched toolchains, corrupt/truncated files, cancellation, and clean
workspace isolation. Include multi-file and resource-reading libraries. Use the
actual pinned browser rustc and execute the output for each published target;
`--extern` must reference verified rlibs and `-L dependency` only the selected
closure. Do not silently retry an unknown prebuilt artifact as trusted source.

Publish the promoted artifacts only through the normal reviewed release process.
After that release, a separate wasm-idle change can introduce the registry
resolver, verified downloads, target/compiler-aware cache keys and UI dependency
selection. The independent wasm-idle multi-file user-crate API is not supplied by
this producer utility; multi-file support here describes library build inputs.

## Tests and current evidence

```sh
node --test producer/rust-browser/test/crate-registry.test.mjs
```

The tests execute the real orchestrator, filesystem snapshotting, subprocess
boundary, gzip and hashing. Their executable is an explicitly labelled Node
**fake compiler**, producing synthetic ar bytes. They validate the build protocol,
not actual Rust compilation, ABI compatibility, or a released package catalog.
No browser consumer is enabled by this PR.
