# Selected JS serializer output bindings

This unit binds the complete pinned `JsIrAstSerializer`, the genuine backend-profile `IrICProgramFragments` carrier, and the genuine `JsIrProgramFragments` override to the existing common byte-output contract. It preserves every serializer and fragment body outside 20 exact transport spans: 16 in the serializer and two in each hierarchy declaration. The prior nullable-getter preparation remains intact.

The source is Kotlin commit `4d78aae1e337cd40f69baa865aed950fe807a775`. Generated common files retain upstream copyright notices and Apache-2.0 provenance. `reference/` preserves the exact predecessor bytes. The original full `CacheUpdater` remains an upstream reference; the compiler receives the already verified backend-profile carrier split.

`DataWriter` uses genuine `JsAstByteWriter`, UTF-8 encoding uses the existing source-pinned compiler text implementation, and `saveTo` uses genuine `JsAstStreamOutput`/`CompilerByteSink`. The file stack becomes Kotlin's real `ArrayDeque` with `firstOrNull`, `addFirst`, and `removeFirst`. Primitive bounds, string/name maps, section ordering, AST traversal, metadata, and all remaining fragment algorithms are preserved.

## Preparation contract

Call `prepareSerializerOutputBindings(options)` immediately after the backend-profile preparation, before global property and annotation imports. The same options are accepted by `verifySerializerOutputBindings`:

```js
{
  sourceRoot, outputRoot,
  preparedSerializerNullability, preparedBackendProfile, preparedJsAst,
  preparedOutputCodec, preparedOutputStream, preparedText,
  retainedSources: [{path, filename, bytes, sha256}, /* actual selected Kotlin sources */]
}
```

Every dependency is replayed through its genuine preparer verifier. The return value exposes `commonSources`, `receiptPath`, `receipt`, `predecessorBindings`, `sharedDependencies`, `replacedOriginalPaths`, and `finalSelectionGuardRequired: true`. Shared dependencies use the actual composer owners `jsAstOutputReceipt`, `jsAstOutputStreamReceipt`, and `textReceipt`. Their `componentRelativePath` and `path` bind the canonical selected keys, including `compiler-port-text/CompilerUtf8Algorithm.kt` and `compiler-port-text/CompilerUtf8Api.kt`. Bind the existing sources once without adding helper copies. Replace these exact logical keys once:

| Logical key | Predecessor |
| --- | --- |
| `compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/utils/serialization/JsIrAstSerializer.kt` | `serializerNullabilityReceipt`, same logical key |
| `compiler-port-backend-profile/compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/ic/CacheUpdater.kt` | `backendProfileReceipt`, same generated logical key |
| `compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/transformers/irToJs/JsIrProgramFragment.kt` | exact pinned primary original |

The generated `compiler-port-backend-profile/` prefix is significant. Do not replace the excluded whole native cache implementation or introduce a second carrier declaration.

After every later selection and import layer, call `verifySerializerOutputSelection({sourceRoot, outputRoot, retainedSources})` with the actual final selected snapshot. This verifies all physical source pins and the three canonical output filenames, checks the preparation receipt and exact references, and repeats the incoming-consumer guard. Final header normalization accepts only the sealed ordered 74-property import block, `kotlin.jvm.*`, and the recorded compiler-assertion alias at their insertion point. Unrecorded imports change the bound source body and fail.

Both guards require the same seven exact consumer bodies: carrier, JS fragment, serializer, genuine deserializer, retained `JsModuleArtifact` carrier, and two existing FIR protobuf serializer callers caught by the conservative call scan. The existing backend-profile's 21 exclusions are bound and reintroduction fails. This unit adds no exclusions. The three Wasm IC fragment overrides belong to that prior guarded native-cache profile and remain excluded. Changing the shared abstract without that verified selection is rejected.

The guard is a source-text inventory, not a symbol resolver. It conservatively scans declarations, comments, imports, `serializeTo`/`loadIrFragments`, and member serialize calls. Unknown incoming sources and changed known bodies fail closed. The caller must supply the complete actual selected source list; a preparer cannot establish completeness from a fabricated partial list. A source-set change requires an explicit inventory review.

## Evidence and limits

The JVM observer compiles all three genuine source files against actual original/common AST implementations. Real fragments test both the extension and override dispatch paths, primitive values, NaNs and signed zero, Unicode and malformed UTF-16, append failures, partial writes, and write/flush/close failure combinations. Complete raw bytes, exception class/message/suppression graphs, and call order are compared without normalization.

The Wasm observer projects the exact complete selected `DataWriter` and `saveTo` method bodies into an explicitly bounded test fixture outside compiler namespaces. The fixture supplies prebuilt section bytes/counts; it does not substitute an AST or compiler model. Original JVM, common JVM, and Node-Wasm compare the same raw record arrays, including exhaustive UTF-16 code units and deterministic primitive bit patterns. Raw sink array backing differences remain recorded and are not claimed equivalent.

`fixture.mjs` reconstructs the older 3,513-source completed graph using the exact nullable predecessor and genuine backend-profile splits. It does not rebuild that whole graph. `selection.mjs` separately replays both guards over the newer completed compiler arguments and physical source pins, replacing only these three sources for the final guard.

The output contract is synchronous and owned by one request on one Worker. Native concurrent stream behavior, allocation exhaustion, Java `ThreadDeath` precedence, and sink backing-array identity are outside this profile. Nonnull metadata class names/`qualifiedName` remain a separate Wasm host boundary. Full serializer Wasm execution, a successful whole compiler build, and public language readiness remain **false**.

Local verification after sealing:

```sh
node producer/kotlin-browser/compiler-port/serializer-output-bindings/verify.mjs
```
