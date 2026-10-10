# Full member ordering in common Kotlin

This translates the complete 233-line `MemberComparator.java` selected from
Kotlin commit `4d78aae1e337cd40f69baa865aed950fe807a775`, retaining its Apache
license header and the real descriptor and renderer APIs.

Both comparators retain all eight declaration priorities, name comparisons,
enum-entry encounter order, type-alias underlying types, callable receiver and
parameter types, parameter counts, type-parameter bounds, member kinds, class
kind and companion flags. The full comparator then uses the original verbose
renderer options and containing-module name tie-break. The explicit enabled
receiver assertion preserves the original null error message. Unsupported pairs
still throw `AssertionError`; their class description uses common `KClass`,
so its text does not promise Java class identity or cross-host equivalence.

`prepareMemberComparatorSources({ sourceRoot, outputRoot })` verifies the pinned
Java input and exact common source, preserves the
Java reference, and publishes one common Kotlin source. Its verifier replays
the complete receipt and rejects changed outputs, references and claims.

The differential compiles the entire original Java comparator and entire
common comparator against verified, genuine JVM bootstrap dependencies. It
constructs actual modules, builtins, function/property/constructor descriptors,
type aliases and type parameters. One explicit class-descriptor subclass sets
the companion flag through the genuine descriptor implementation.

The 38,090 raw observations match without normalization: exact comparison
integers for every fixture pair, both stable sorts, and unsupported-pair
exception categories. Cases include every priority, receiver and parameter
types and counts, upper-bound counts/types, member and class kinds, companion
flags, Unicode names and module tie-breaks. Unsupported-pair message text is
checked for its protocol prefix, but is not compared between class systems.

```sh
node --test producer/kotlin-browser/compiler-port/member-comparator/prepare.test.mjs
node producer/kotlin-browser/compiler-port/member-comparator/probe.mjs out/NEW_UNIQUE_OUTPUT
```

The bootstrap artifacts do not publish a source commit. This JVM result does
not prove closure of the common descriptor/renderer graph, Wasm execution,
offline browser execution, or whole compiler acceptance. Public Kotlin
readiness remains false.
