# Kotlin candidate source notices

The four `fixtures/upstream-*.kt` files are unchanged copies of test inputs from
[JetBrains/kotlin](https://github.com/JetBrains/kotlin/tree/4d78aae1e337cd40f69baa865aed950fe807a775),
revision `4d78aae1e337cd40f69baa865aed950fe807a775`.

Kotlin is copyright JetBrains s.r.o. and Kotlin Programming Language
contributors and is distributed under the Apache License, Version 2.0. The
upstream license text is preserved verbatim in [LICENSE.kotlin.txt](LICENSE.kotlin.txt).
`manifest.json` records its original path, Git blob, size, and SHA-256. The fixture
ledger records each copied fixture's upstream path and exact identity.

The eight other `.kt` fixtures, including Hello World and Fibonacci, are new
inputs authored for this producer and use
the repository's MIT license. The build/source inventory scripts do not ship an
upstream compiler, JDK, stdlib, syntax library, generated runtime, or other binary.
Their source references and checksums document candidate inputs, not a completed
distribution license inventory. A compiler release still requires notices for
every linked/generated/packaged dependency and accepted reproducible provenance.
