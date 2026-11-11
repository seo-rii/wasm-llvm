# Common deque API for the official compiler

This component adapts the deque operations in six complete official Kotlin
compiler files to `kotlin.collections.ArrayDeque`. It preserves the existing
type checker, constraint incorporation, supertype traversal, function inlining,
partial linkage and dead-code elimination algorithms. User source never enters
this transformation.

| Existing operation | Common operation | Preserved behavior |
| --- | --- | --- |
| `push(value)` | `addFirst(value)` | Insert at the head |
| `pop()` | `removeFirst()` | Remove the head; fail when empty |
| `getLast()` | `last()` | Read the tail; fail when empty |
| `peek() ?: fallback` | `firstOrNull() ?: fallback` | Preserve the empty-context fallback |
| `peek().member` | `firstOrNull()!!.member` | Keep a null failure when an empty result is dereferenced |
| `poll()` / `pollFirst()` | `removeFirstOrNull()!!` | Remove the head in the existing nonempty loop |

The two polling loops check their private queues before polling. The explicit
null assertion preserves the failure category of the original subsequent
dereference if that invariant is violated. Existing `add`, `addLast`,
`removeLast`, iteration, identity comparisons and scope cleanup stay unchanged.
In particular, the algorithms that mix head insertion with tail insertion keep
their original traversal order.

The pinned recipe replaces exact source spans and verifies the complete inverse.
Preparation authenticates all 3,571 selected source files and their order, with
the same 18 JVM signature sources. Six files are replaced; none are added or
excluded. The final verifier passes the complete authenticated predecessor to
the official-main, tower, PSI and exception guards. Native lexical and module
checks continue to inspect the actual compiler inputs.

Runtime comparison uses complete original and transformed source files in the
official JVM-hosted compiler. Four unchanged official caller files must also be
recompiled in both overlays because the type checker's deque getter has a
different JVM descriptor and its callers contain inlined bytecode. This is a
requirement of the comparison harness; the browser port compiles the complete
source graph together. The runtime record identifies the loaded class origins
and the exact user programs compiled and executed.

The runtime fixtures do not establish coverage of every compiler method or
every partial-linkage condition. Collection exception messages and JVM binary
compatibility are not promised. The full compiler remains a source-port project:
a successful host adaptation or generated-program runtime check does not mean
Kotlin compilation works inside a browser, and public Kotlin remains disabled.

In particular, the changed `ConstraintIncorporator.anyNestedArgument` loop is
used when `EliminateSecondKindIncorporation` is disabled. That feature is enabled
by default in the pinned compiler's Kotlin 2.5 settings, so the default runtime
fixtures do not establish execution of that loop. Invalid-program fixtures
compare rejection, not exact diagnostic text.

The actual whole-source build reduced diagnostics from 1,250 to 1,221. Exactly
29 diagnostics disappeared from the six changed files; the four remaining
diagnostics in those files concern unrelated host APIs. Every surviving
diagnostic retained its source, line, column, message and multiplicity. The
comparison reopened 7,142 original/current source files and 13 compiler/library
inputs, with the same source order, compiler options, heap and deadline.

Source and diagnostic tests passed 77 checks with no skipped tests. Runtime
comparison passed 16 Node executions and 16 fresh offline Chromium Workers;
eight runtime integrity checks include six rejected mutations of actual evidence.
The whole build's 10,290 frozen inputs were unchanged. Its compiler exit remains
1: there is still no complete compiler KLIB or browser-side Kotlin compilation.

The [recorded evidence](evidence/current-foundation-v1.json) binds the actual
source graph, build and runtime records. Reopen it with:

```sh
node producer/kotlin-browser/compiler-port/common-deque-api/verify.mjs \
  producer/kotlin-browser/compiler-port/common-deque-api/evidence/current-foundation-v1.json
```

The preservation guide identifies the required worktree snapshots, runtime
artifacts, predecessor archive and retained external caches. Verification fails
when those recorded inputs are missing or changed.
