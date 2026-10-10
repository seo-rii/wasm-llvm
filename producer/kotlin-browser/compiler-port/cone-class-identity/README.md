# Final Cone class equality guards

This unit changes three JVM-only guards in the full official `ConeTypes.kt`
source at Kotlin commit `4d78aae1e337cd40f69baa865aed950fe807a775`:

```kotlin
if (javaClass != other?.javaClass) return false
```

becomes `if (other !is ConeCapturedType) return false`, with the corresponding
concrete name for `ConeIntersectionType` and `ConeUnionType`.

All three pinned classes are final: the captured type is a data class, and the
intersection and union classes have no `open` modifier. An instance of another
runtime class cannot be a subtype of any of them. The replacement therefore
rejects exactly the same null and different-class arguments. A future open
declaration fails preparation even if a caller updates its input hash.

The existing `this === other` check, explicit cast, constructor identity,
nullability, collection comparisons and every hash statement remain unchanged.
Captured attributes, intersection approximation bounds and union attributes
remain deliberately absent from equality. `ConeFlexibleType` keeps its broader
subtype equality; no general reflection adapter is introduced.

## Preparation

Call `prepareConeClassIdentitySources({ sourceRoot, outputRoot,
preparedIdentity })` immediately after the existing identity preparation and
before global import binding. The identity predecessor must match its complete
14,982-byte pinned source, its receipt and its locked preparation recipe. This
unit does not modify the predecessor or its seven-source recipe.

The result supplies one `commonSources` file at the original logical path,
that path in `replacedOriginalPaths`, and an `identityReceipt`
`predecessorBindings` entry compatible with the checked composition loop.
The 14,974-byte output preserves every predecessor byte outside three recorded
guard spans. Original sources and predecessor receipt/bytes are preserved in
the private preparation output, including a separately bound original input
filename. Recorded byte offsets refer to each sequential replacement's input.
`verifyConeClassIdentity(outputRoot)` rebuilds
the output and complete receipt from those verified snapshots and the current
locked tools.

The original Cone source, projection and lookup-tag declarations, and the four
remaining hierarchy files have individual source pins. No fixture source is
returned by the shipping preparer.

## Focused validation

```sh
node --test producer/kotlin-browser/compiler-port/cone-class-identity/prepare.test.mjs
node producer/kotlin-browser/compiler-port/cone-class-identity/probe.mjs out/NEW_UNIQUE_OUTPUT
```

The JVM probe compiles all seven actual pinned sources twice, first as original
sources and then with the prepared Cone source. It instantiates all fourteen
selected concrete type kinds using genuine bootstrap dependency objects and
compares raw equality, equal-hash and stability observations. It includes
constructor identity, nullability, ignored metadata, collection order and
list/set distinctions, null and unrelated arguments, and preserved flexible
family equality. Empty intersection construction retains its original
`NoSuchElementException` behavior.

The common JVM and Node Wasm probe executes exact source-projected equality
and hash bodies for the three final classes. Its constructor fields are
explicit `IdentityPayload` and `ValuePayload` fixtures in a separate probe
package; they are absent from the compiler source list. The original method
bodies are verified before projection, and the intersection's actual private
hash cache is retained. This proves those method boundaries under controlled
identity/structural payloads, including equal-hash collisions and an empty
fixture collection. It does not prove the full Cone initialization/type graph
on Wasm or permit empty genuine intersection construction.

The preparation guards reject future openness, changed identity predecessors,
payload-body changes, method projection changes, tampered claims/receipts,
overlapping inputs/outputs, reused publication and symlinked sources.

The verified bootstrap helper artifacts have an unpublished source commit;
their compatibility is demonstrated by execution. Full Cone Wasm execution,
browser execution and whole compiler acceptance remain separate gates. Public
Kotlin readiness remains false.

The [sealed differential evidence](evidence/differential.json) preserves the
actual successful compiler/runtime receipt and its raw reference outputs:
1,864 genuine-source JVM records and 1,013 exact method-boundary records match
without normalization. It separately records the later preparation-only
filename-provenance guard and five passing integrity tests. The compiled
methods and shipping output are unchanged by that provenance strengthening;
the successful compiler probe was not repeated.
