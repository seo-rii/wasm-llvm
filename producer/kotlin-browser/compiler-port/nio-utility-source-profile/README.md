# NIO utility source profile

The latest genuine 3,540-source compiler invocation reports 44 entries in
`compiler/util-io/src/org/jetbrains/kotlin/io/PathUtils.kt`. This profile excludes
only that complete original source after proving that none of its six top-level
extensions or its JVM `PathUtilsKt` facade has a conservative incoming reference
from the actual final selected graph. The recovered pre-utility roster has one
canonical incoming caller, KlibLayoutReader; it must disappear through the
existing verified disk profile before final verification can succeed. It does not port NIO or filesystem operations.

Preparation hash-checks all 3,838 pinned original Kotlin/Java inputs, records their
references and dynamic-name sites, snapshots the full target and binds every
selected source's logical path, physical owner, bytes, hash and order. Comments,
literals, aliases, wildcard uses, escaped Unicode, backticks, qualified names and
conservatively joined reflective names are scanned. Arbitrary computed names and
compiler IR reachability remain unproven.

The profile runs after assembly and before the existing five-file JVM utility,
seven-file KLIB disk and single-file service profiles. Final verification requires
no incoming reference and verifies the exact downstream profiles and receipts;
the unresolved pre-disk caller is explicitly rejected by the public final guard.
Reached PathUtil, KotlinPaths, MP parser, Wasm lowering and genuine memory/compiler
boundaries remain present with exactly their preparation owners and bytes.

`probe.mjs` replays the completed compiler's exact source/argument inventory,
then runs the real four-profile pipeline. `prepare.test.mjs` exercises adversarial
actual-roster, owner, receipt, original-body and incoming-reference cases. These
source-selection proofs do not establish a new compiler build or browser readiness.
