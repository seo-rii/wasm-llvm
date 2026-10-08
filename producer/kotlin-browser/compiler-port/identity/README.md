# Compiler reference identity host boundary

This unit ports the selected official compiler's reference identity storage. It
does not compile user Kotlin by itself. The browser compiler and language
readiness remain unverified.

`prepareIdentitySources({ sourceRoot, outputRoot })` checks the exact upstream
source bytes, patch, generator and adapter hashes. It writes seven transformed
official files and `IdentityIndex.kt` only below producer `out/`; original source
files are unchanged. The returned `replacedOriginalPaths` must be excluded when
the prepared files are added to C.

The four real users are `SmartIdentityTable`, IR attribute merging, Wasm GC/vtable
reverse type lookup and WasmSerializer's repeated-reference table. Their used
operations are preserved by an explicit per-owner index, using the upstream
SmartIdentityTable array search with `===`. Null keys/values, replacement return
values, absent versus stored null, and reference-ID assignment remain distinct.
This index does not claim the unused equality/hash or mutable views of a JDK
`IdentityHashMap`.

Large-table lookup is linear. No compiler product performance or total GC heap
bound has been established. The index retains its own entries for its compiler
owner's lifetime, with no global object-ID or strong-reference cache.

The three official `System.identityHashCode(this)` implementations retain their
identity equality with one fresh private `Any()` hash token per instance. Numeric
hashes are host-local; stability and equal objects having equal hashes are the
contract. The selected Wasm Any source explicitly warns that its private
identityHashCode must not be used for arbitrary objects, because String reuses
its storage. This port neither exposes that primitive nor invokes user hashCode
or equals to compare identity keys. The two IR class-hash expressions use the
real common `KClass.hashCode`, retaining a shared hash for equal class instances.

`WasmSerializer`'s OutputStream, the IntelliJ reverse-map helper, and the Java
ClassTypeConstructorImpl unmodifiable snapshot/live-collection implementation
are separate unclosed host boundaries. This preparation does not replace their
semantics or advertise full compiler support.

The final corpus compared 6,803 index/SmartIdentityTable observations against the
actual JDK IdentityHashMap and selected official JVM table on portable JVM, Node
Wasm and Chromium 153.0.8010.12. It includes 2,048 seeded mutations, keys whose
equals/hashCode throw, equal distinct keys, null, the >10 transition, null factory
retry, overwrite during iteration and structural invalidation. Chromium ran the
real compiled unit twice in a module Worker after static initialization, with
network access disabled and zero requests during the observations.

An additional 223 JVM observations compared the full selected original and
ported ConeTypes, IrTypeBase, ClassifierBasedTypeConstructor and IrElementBase
files, using genuine bootstrap builtins/error descriptors, IR factory objects
and IrAttribute keys. Hash stability, identity/class equality and equal hashes
for equal objects match; original numeric identity hashes are not compared.
Attribute source overwrite, copy filtering, self-copy and null removal match.
The exact unchanged ConeTypeProjection and ConeLookupTags sources close the
selected sealed family for this JVM reference. Ten preparation integrity guards
passed. The verified bootstrap helper revision is not proved equal to the
selected source commit.

The four full type/attribute families have not executed in Wasm, and the full
WasmSerializer/CompiledModuleFragment have not independently run in this corpus.
Actual whole-C assembly also reports ConeTypes javaClass comparisons and the
fragment's Java Map.putIfAbsent/computeIfAbsent APIs. These boundaries remain
visible, and are not replaced by broad compatibility stubs in this unit.

Run a fresh comparison with an unused output directory, then the browser and
integrity checks. Apply the workspace rule for restricted background logs to
the long compiler command:

```sh
node producer/kotlin-browser/compiler-port/identity/build-probe.mjs --output-root out/kotlin-identity-rebuild
node producer/kotlin-browser/compiler-port/identity/browser-probe.mjs --output-root out/kotlin-identity-rebuild
node --test producer/kotlin-browser/compiler-port/identity/integrity.test.mjs
```

The checked-in receipt contains exact pins, commands and bootstrap identity,
output hashes, independent validation scopes, and the verified index execution
chain. The final type-source replay reused unchanged successful index artifacts
only after source, observer, bootstrap, flags, receipt and output digest checks.
It did not rerun their compilation. Failed setup attempts remain recorded: the
original sealed sibling/API boundary was corrected using real source, and a
disk-exhausted Chromium launch/guard fixture setup was retried after scoped
cleanup. Generated Wasm, KLIB, JAR and observation files stay under `out/`.
