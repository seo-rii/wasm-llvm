# Official compiler version algorithms

This unit ports the selected official version helpers into the browser compiler
source set. It keeps Maven's item tree, canonicalization, unlimited numeric
components and qualifier order, and all Kotlin tooling version bodies. It does
not skip KLIB ABI/version checks. The compiler's own version is produced from
an explicit, SHA-bound build input and the actual upstream resource rule.

The source revision is
[`4d78aae1e337cd40f69baa865aed950fe807a775`](https://github.com/JetBrains/kotlin/tree/4d78aae1e337cd40f69baa865aed950fe807a775).
`sources.lock.json` records the original Git blobs/SHA-256, portable bytes,
small tooling patch, policy generator, actual JDK policy origin and resource
generation inputs. Original source caches are never modified. Generated Kotlin
policy/resource source and compiled outputs stay in ignored `out/`.

| Original | Common boundary |
| --- | --- |
| `MavenComparableVersion.java` | Same Integer/String/List algorithms; arbitrary non-negative decimal magnitude replaces `BigInteger`; private list storage uses composition because Wasm's `ArrayList` is final. |
| `KotlinToolingVersion.kt` | Original functions/properties, signed `Int` overflow and original case-sensitive hash retained; only `Serializable`, host casing/digit and regex dot boundaries change. |
| `KotlinCompilerVersion.java` | Original constants and pre-release/version decisions; explicit producer resource and profile test override replace classloader resource and JVM test property access. Java fields/static methods and the overridable canonical getter remain callable by a real javac client. |

The excluded Maven `main` is its console demonstration, a JVM CLI shell.
The comparison, canonical, equality/hash and reparsing APIs remain. No actual
compiler consumer is replaced with an empty or successful placeholder.

`VersionUnicode.kt` follows the fixed English/ROOT JVM casing policy, including
the actual random-access word iterator path for final Sigma. The UTF-16 offset
behavior around supplementary characters is preserved. Its data is captured
from the actual reference OpenJDK `17.0.20.1+1-1-deb12u1-Debian`; the Java
executable, complete module image, release file and CI generator hashes are
recorded. Browser locale and browser Unicode tables are not used. A future JDK
or policy upgrade must generate and pin new data and rerun the differential.
The OpenJDK policy adaptation/data has GPL 2 with Classpath exception notices
in [LICENSES.md](LICENSES.md); the Apache notices remain on the Kotlin/Maven
adaptations. This is a concrete distribution input for the release license
inventory, not a completed release-license gate.

`prepareVersionSources({ sourceRoot, additionalSourceRoot, outputRoot,
buildVersionInput, buildVersionInputSha256 })` returns six `commonSources`,
three `replacedOriginalPaths`, exact originals for the reference run, the
generated resource and a preparation receipt. The additional verified cache
defaults to `out/kotlin-versions-reference-inputs`; missing inputs fail.

The producer input has schema version 1, kind
`official-compiler-version-build-input`, the selected source commit, a
provenance string and `properties` containing `deployVersion`, `buildNumber`
and `defaultSnapshotVersion`. The pinned default is independently read from
the actual `gradle.properties` bytes. The SHA passed by the caller is the
input trust root. The actual upstream rule is:

- Present `deployVersion`: `default.snapshot` selects the pinned default,
  otherwise its own value; a present `buildNumber` does not override it.
- Absent `deployVersion`: a present `buildNumber`, otherwise the pinned default.
- `ProcessResources` replaces `@snapshot@` with that result. This preparation
  reproduces the pinned token rule; it does not run the upstream Gradle task.

Missing input/digest, wrong source/property pins, unresolved `@snapshot@`,
multiline inputs, source symlinks and output replacement are rejected. The
selected original nullable `getVersion()` branch for `@snapshot@` is retained
in code but the production profile does not admit that unresolved resource.
Bootstrap B's version or target T's version is never an implicit default.
Root's explicit compiler input selects the actual upstream
`defaultSnapshotVersion=2.5.255-SNAPSHOT`, with both overrides absent.

The differential uses the selected original Java sources and unchanged tooling
Kotlin on JVM, common sources on JVM, actual common sources compiled to
`wasmJs`, and Chromium in a real module Worker. JVM default locale is Turkish,
while the original version algorithms explicitly use ROOT/English. It observes
all 1,114,112 code points for lowercase changes/identity, all BMP digit
characters, three full final-Sigma masks over every BMP character, Unicode
contexts, arbitrary 1,024-digit numeric components, 4,096 zero prefixes,
canonical/equals/hash/compare return values, reparsing, tooling classifier
numbers/overflow and compiler version/pre-release behavior. It emits actual
observations and compares them directly; no expected responses are generated.
A separate real javac client verifies the preserved public Java member surface.

The first replay exposed the missing supplementary-character boundary path;
the next exposed `ArrayList`'s final Wasm variant. Their original logs/receipts
remain as failed attempts. The final checked-in evidence records the corrected
snapshot and its exact successful comparison, including repeated offline
Chromium execution and the provenance guards.

Run with the parent's approved component JVM slot (each compiler is capped
at 768 MiB and all steps are sequential):

```sh
node producer/kotlin-browser/compiler-port/versions/build-probe.mjs \
  --source-root out/kotlin-compiler-port/sources \
  --output out/kotlin-versions-probe-review \
  --version-input producer/kotlin-browser/compiler-port/compiler-version-input.json \
  --version-input-sha256 <approved-input-digest>
node producer/kotlin-browser/compiler-port/versions/browser-probe.mjs \
  --output-root out/kotlin-versions-probe-review
node --test producer/kotlin-browser/compiler-port/versions/integrity.test.mjs
```

Long runs require private background logs under `~/logs`. Compiler/bootstrap
source equality to the selected commit is unproved; bootstrap B is explicitly
recorded as `2.5.0-dev-10106`, not the R0 compiler. No whole compiler, browser
source-to-program compilation, metadata compatibility bypass or public Kotlin
support is claimed. Those gates remain pending and readiness remains false.
