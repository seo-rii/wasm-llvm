# Genuine character constant formatting

This layer retains the complete upstream constant source and the verified
`NullValue` common type binding. It replaces only `CharValue`'s fixed hexadecimal
format expression and its seven JDK category comparisons. The genuine printable
character cases, including backspace, tab, newline, form feed and carriage return,
are unchanged. Uppercase, four-digit hexadecimal output is independent of locale.

Character classification uses the existing shared `AstCharacter` table, pinned
to the complete JDK 17 UTF-16 category capture. It adds no character facade,
second table, source exclusion or compiler receiver. Preparation verifies the
entire AST preparation and null-constant predecessor; composition must bind their
actual selected canonical files exactly once.

The differential observer checks every UTF-16 code unit, including surrogates and
unassigned characters. It compares all returned UTF-16 units, represented as hex
in the raw records, without text normalization. JVM observations instantiate
`CharValue` from each complete original/common constant source. A separate
projection retains exactly the three formatting methods inside a minimal value
holder and runs on JVM, Node Wasm and an offline Chromium module Worker.

The projection does not contain the descriptor/type/visitor hierarchy. Full
constant-family Wasm execution and browser compiler readiness remain unverified.
Bootstrap dependencies are version/hash pinned; their source identity is unknown.

```sh
node --test producer/kotlin-browser/compiler-port/char-constant-format/integrity.test.mjs
node producer/kotlin-browser/compiler-port/char-constant-format/probe.mjs out/kotlin-char-constant-proof-unique
```
