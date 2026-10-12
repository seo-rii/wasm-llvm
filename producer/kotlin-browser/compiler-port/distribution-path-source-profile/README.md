This profile excludes exactly three complete distribution-path files from the
browser compiler source set: `PathUtil.kt`, `KotlinPaths.kt` (including the
complete `KotlinPathsFromBaseDirectory` class), and `KotlinPathsFromHomeDir.kt`.
Their source identity is Kotlin commit `4d78aae1e337cd40f69baa865aed950fe807a775`.
Every complete original and assembled predecessor is preserved. There are no
replacement classes, filesystem implementations, or changed consumer bodies.

The selected files refer to one another. The only other primary source referring
to these Kotlin distribution declarations is `KotlinNativePaths.kt`, which the
existing JVM utility profile already excludes. Preparation requires that real
profile's canonical receipt and externally captured SHA-256, preserves its five
original files, and requires all five existing exclusions to be absent.

The remaining `PathUtil` use in `PartialLinkageErrorMessages.kt` resolves through
its exact `import com.intellij.util.PathUtil`; its `getFileName` call is a
different declaration. The exception requires the complete pinned original
consumer body, exact import and call, and the recorded assembled owner. Any
other occurrence, copied owner, changed consumer body or changed import is
rejected. Identifiers, aliases, backticks, literals, Unicode escapes and joined
names remain visible to the conservative full-source scan. Arbitrary computed
dynamic names and a resolved compiler IR call graph are outside this proof.

Call `prepareDistributionPathSourceProfile` after service-loader preparation
with `sourceRoot`, a new `outputRoot`, actual `retainedSources`,
`preparedJvmUtilityProfile: { outputRoot, expectedReceiptSha256 }`, and the
recorded property imports. It returns zero common sources, exactly three
`sourceSetExclusions`, complete original references and a preparation receipt.

`verifyDistributionPathSourceProfile` and
`verifyFinalDistributionPathSourceProfile` require the original `sourceRoot`,
`outputRoot` and externally captured `expectedReceiptSha256`. The final verifier
also receives the actual source vector, requires every other row's complete
metadata, body, physical owner and order to remain identical, and returns
`{ receipt, predecessorRetainedSources }`. The predecessor restores only the
three verified rows in their original positions. Pass it only to the existing
service/disk/JVM/NIO source-profile tail verifiers. Any later selector must first
verify and reverse its own exact delta before invoking this final verifier;
the exact three-row graph comparison is never relaxed.

The focused proof uses the completed failed native-phase whole compiler's
actual 3,550-source compiler argument vector. It performs 3,550 → 3,547 selection,
checks exact-reason negative cases and a restored positive, then calls all four
unchanged public tail APIs on the verified three-row predecessor. The immutable
historical BUILD files and directory metadata, including its root, are checked
before and after. These checks establish source selection and composition.
They do not establish filesystem support, successful whole compilation, or
browser language readiness.

Run `node probe.mjs <new out/distribution-path-proof-... directory>` for the
focused source and composition proof. `update-lock.mjs` regenerates only this
unit's lock from the pinned primary originals and existing dependency tools.
