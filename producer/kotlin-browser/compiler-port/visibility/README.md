This unit ports the selected `DescriptorVisibilities.java` algorithms to a common
Kotlin class. It retains private/private-to-this, protected receiver/subclass,
module and friend access checks, original descriptor traversal, underlying
type-alias constructor checks, visibility ordering and mapping, and the three
receiver sentinels. The original obsolete-API markers and deprecated receiver
remain marked. Illegal visibility operations retain their failures.

The browser profile explicitly selects the original `ModuleVisibilityHelper.EMPTY`
factory in place of dynamic JVM service discovery. This does not bypass the
real `shouldSeeInternalsOf` check. Custom compiler services/plugins are outside
this profile. The reflective `DescriptorUtils.getParentOfType` traversal uses a
typed reified `is` test and preserves its strict/non-strict parent walk.

The original unmodifiable set and ordering map use the already validated common
read-only collection host. Public JVM bridges are emitted for differential
linkage with genuine compiler dependencies; Kotlin adds its companion structure
and final static bridges. JVM subclass hiding/bytecode layout is not a common
compiler-host API guarantee.

With the source closure and verified bootstrap already prepared, run from
wasm-llvm, using a private background log and exit sidecar:

```sh
node producer/kotlin-browser/compiler-port/visibility/check.mjs
```

The differential compiles the exact original Java implementation independently
and uses real module, package, class, function, builtins and receiver factories.
It compares visibility metadata and all nine-by-nine ordering pairs, source-file
identity, top-level and member access, friend relations, protected subclass and
receiver rules, illegal operations, mapping failure and immutable collections.
No replacement descriptor/type objects supply test results.

The reference helper classes are hash-verified bootstrap artifacts whose source
commit remains unknown. This validates the selected visibility implementation
against those real dependencies; it does not establish a same-upstream full R0
baseline. The concrete common descriptor/type/DescriptorUtils closure is still
required, so isolated Wasm execution and full browser compilation remain unrun.
