# Crystal 1.21.0 portability — 2026-09-05

The official Linux x86_64 compiler and source commit
`57cf7da5094db6c5d3c058c6d054a757b5ced19e` were used without source patches. The source of
`markd` v0.5.0 was pinned to `d61dd52d40e659b53cb78712a7b1190cfdb9bc66` for compiler dependencies.
The bootstrap compiler reports LLVM **20.1.8**. The host configuration probe used native
LLVM **16.0.6**, within Crystal's supported range; these are separate compiler inputs.

| Gate | Actual result |
| --- | --- |
| Standard-input program → WASI relocatable object | Passed, compiler exit 0; valid WebAssembly with a version-2 linking section |
| Invalid Crystal syntax | Passed, compiler exit 1 with `unexpected token` at the invalid fixture |
| Upstream Crystal compiler → WASI object | Blocked, compiler exit 1 |
| Target linking/execution | Not performed |
| Browser compiler and standard I/O acceptance | Not performed |

The WASI target needs `-Dwithout_mt`: the default execution-context path requests an event-loop
method that the pinned WASI implementation does not provide. With the upstream single-threaded
option, `STDIN.gets_to_end`, splitting, integer conversion, collection mapping, summation, and
`puts` compile to a relocatable object. The printed native link command is retained in the receipt;
it is not executed or interpreted as execution evidence.

The full compiler-host probe reaches `src/process.cr:550` and fails with:

```text
Error: undefined method 'prepare_args' for Crystal::System::Process.class
```

The upstream WASI process implementation also contains unimplemented process-spawn/replace
operations. This is an actual host portability blocker after dependency resolution, before any
attempt to link the LLVM compiler runtime. The experiment establishes no browser-hosted compiler
artifact. `readiness.ready`, `browserCompiler`, and `browserStdinStdout` remain false.

Reproduce using the commands in [README.md](README.md). The manifest pins the compiler archive
and source revisions; the generated local receipt records the observed versions, exact commands,
hashes, and diagnostics for all three compiler invocations. The overall probe exit code is **1**
until every compile-time gate passes. Browser readiness remains a separate future acceptance gate.

The six focused tests, including the producer repository check, passed. The updated repository
producer-count invariant and `git diff --check` also passed.
