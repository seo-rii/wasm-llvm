# Portable compiler source and light-tree host boundary

This patch is applied to an isolated browser compiler source closure. It retains
the selected official new parser, source-element kinds/offset strategies,
light-source identity and Raw FIR delegation. It excludes JVM file discovery,
PSI-backed source variants and the old stream reader from this source set.
Upstream files and the original JVM source set remain unchanged.

The source identity is Kotlin commit
`4d78aae1e337cd40f69baa865aed950fe807a775`. `sources.lock.json` pins each original
Git blob/SHA-256 and the exact transformed bytes. `patches/source-host.patch`
contains the mechanical source changes.

The actual entry contracts are:

- `KtInMemoryTextSourceFile(name: String, path: String?, text: String)`.
- `KtSourceFile.getContentsAsText(): String`, an interface member.
- The upstream `org.jetbrains.kotlin.toSourceLinesMapping()` extension. It
  preserves the supplied string, uses UTF-16 offsets and zero-based positions,
  and counts LF separators including raw CRLF strings. The JVM reader that
  normalizes separators is excluded.
- The original `KtLightSourceElement` and `KotlinLightTreeStructure` class names.
  Their carrier interfaces live in `org.jetbrains.kotlin.portable.source`.
  The adapter delegates node text/offsets/navigation to the real `LightSyntaxTree`.
- `LibraryPath` identifies a canonical POSIX location in the read-only virtual
  library mount. Relative paths resolve at the explicit virtual root `/`.
  Traversal, noncanonical segments, NUL and backslashes are rejected. This is
  not the developer machine's filesystem or a general `java.nio.file.Path` API.

All 136 concrete fake source kind names come from the selected source's actual
official parser declaration tree, recorded in `fake-source-kinds.json` with
UTF-16 name ranges and parser snapshot hash. The generator emits an exhaustive
type-based name function instead of runtime JVM class-name reflection. Kind
data/equality, error-reporting flags, fake/real source behavior and offset
strategies remain upstream code. `portableObjectsHash` uses the same ordered,
null-aware 31-folding algorithm as `java.util.Objects.hash`.

The source-lines mapping uses the official common `List.binarySearch` over a
cached `IntArray.asList()` view. The bootstrap's common Wasm stdlib has no
`IntArray.binarySearch` overload, including with an explicit import. The view
preserves mutations of the upstream public offsets array and avoids copying
offsets or creating a view per lookup. The mapping's exact-match, duplicate
midpoint, insertion-point and negative-offset behavior remains upstream code.
`sources.lock.json` pins the original common search and Wasm array-view sources
from the same Kotlin commit; no search algorithm is rewritten.

`source-lines-probe.mjs` compiles the whole original JVM mapping file, relocating
only its two IntelliJ imports to the genuine bootstrap distribution. It then
compares that mapping with the prepared common code on JVM, Node Wasm and an
offline Chromium module Worker. The committed
`evidence/source-lines.json` records 16,524 identical observations, including
empty and large arrays, duplicate starts, array mutation, raw CR/LF, UTF-16
surrogate/combining text, NUL, integer limits and offsets beyond the input.
Chromium 153.0.8010.12 made no external or offline requests. The original stream
reader and PSI declarations are compiled for the JVM reference but are not
executed; no normalization is introduced in the browser's text mapping.

```sh
node --test producer/kotlin-browser/compiler-port/host/source-lines.test.mjs
node producer/kotlin-browser/compiler-port/host/source-lines-probe.mjs \
  out/kotlin-compiler-port/sources out/kotlin-source-lines-probe-NEW
```

The probe uses the already verified bootstrap and the pinned stdlib source cache
at `out/kotlin-stdlib-probe/builds/run-c4fcdcdc/sources`. Its output directory must
be fresh. These focused results prove the source-location boundary; they do not
claim execution of actual FIR diagnostics or a complete browser compiler.

`MultiplatformParsing2Fir` now reports real error production markers to the
existing `FirSyntaxErrors.SYNTAX` factory with `KtOffsetsOnlySourceElement` and
the same per-file diagnostic context used by the old parser error listener.
Its parser and Raw FIR conversion calls remain official. The compiler entry
must register `FirSyntaxErrors` and stop on collected syntax errors before
recording or lowering malformed FIR. This patch does not invent a parser or
return success for unsupported compiler services.

```js
import { prepareHostSources } from './host/prepare.mjs';
const prepared = await prepareHostSources({
  sourceRoot: verifiedOriginalSourceClosure,
  outputRoot: isolatedClosureUnderRepositoryOut,
});
// Compile prepared.commonSources together with the real compiler closure.
```

Preparation was actually run: original/transformed hashes, `git apply --check`,
application and reverse-check passed for all eight patched files. The original
source cache stayed unchanged. Node syntax and patch whitespace checks passed.
Generated source and the receipt stay under `out/`; preparation is not a Kotlin
type-check or browser execution result.

Raw/resolved FIR, checker execution and the full browser compiler have not
passed through this boundary yet. Remaining real compiler dependencies,
portable diagnostic positioning/PSI metadata and registry class keys must be
closed by the compiler build. Language readiness remains false. No native
program demonstration substitutes for browser-hosted compilation.
