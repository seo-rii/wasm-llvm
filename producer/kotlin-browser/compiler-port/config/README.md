# Compiler configuration on the browser host

The preparation tool preserves the pinned official configuration methods and
replaces only the IntelliJ identity key and Java `Collections.unmodifiable*`
boundary. Keys with the same display name remain distinct. List, set, map and
collection wrappers are live views and reject mutations, including iterator,
list iterator and map entry mutations. `get(key, default)`, `getList`, `getMap`
and `getSet` keep their original raw-value behavior. `copy()` remains shallow.

```sh
node producer/kotlin-browser/compiler-port/config/check.mjs
```

Run through the workspace background-log procedure. The actual checked-in
receipt compares 74 observations on the original Kotlin configuration/JVM,
portable JVM and portable wasmJs/Node: all agree. It covers identity, defaults,
live containers, rejected mutations, shallow copies and read-only behavior.
The JVM reference changes only IntelliJ's import to its package in the verified
bootstrap JAR; the original configuration and Java collection algorithms stay.

One host difference is recorded separately: retaining a map entry after an
external structural map mutation yields a JVM value but a Wasm concurrent
modification exception. [Java's entry contract](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/Map.Entry.html)
leaves this behavior undefined; those observations are excluded from the
equivalence count. The container and fresh entry-set views stay live. A compiler
consumer must not rely on stale entry lifetime.

Browser execution of this unit is `not-run`. The full browser compiler is not
built, and this result does not establish fresh Kotlin compilation in a browser.
