# Experimental synchronous tool host profile

This opt-in profile lets the real Clang driver invoke a host-provided linker from
`llvm::sys::ExecuteAndWait`. The existing WASI producer remains unchanged. The
baseline driver reports `WASI does not support spawning subprocesses` when linking;
this profile forwards the driver's original executable and arguments through a
versioned import. It does not parse diagnostic text or reconstruct driver options.

The profile is experimental. Its presence is not a shell, POSIX subprocess, full
CLI, or release qualification claim. A consumer must provide this exact import,
validate its memory accesses and allowlist a pinned child executable. A normal
WASI host cannot instantiate the candidate without the extra import.

## exec_v1 ABI

Module `wasm_idle_tool_host`, function `exec_v1`:

```text
(programPtr:i32, programLen:i32, argvPtr:i32, argc:i32,
 envPtr:i32, envc:i32, flags:i32) -> i32
```

Each argv/environment table entry has an eight-byte little-endian layout:
`{pointer:u32, byteLength:u32}`. The pointed-to bytes are length-delimited, without
a required terminator. argv includes argv0 and preserves empty arguments. Flag
bit 0 means inherit the current environment; zero means use the explicit table,
including an empty environment. All other flags are reserved and must fail.

The call is synchronous. The host child inherits the current cwd, filesystem and
fd 0/1/2. The host must copy and validate the tables and strings before dispatch,
including overflow, memory bounds, NUL, maximum string/count/total bytes and
recursion limits. It must re-create memory views after memory growth. No Promise
may be returned in place of completion. Return a nonnegative signed integer for
the exact child exit status, `-1` for rejected/failed startup, or `-2` for abnormal
termination. The latter two set LLVM's execution-failed result and a diagnostic.

The host must allowlist the executable and use already verified/prepared bytes.
The initial consumer maps `wasm-ld`/`ld.lld` to its pinned LLD. It must not execute
host commands, fetch a path supplied by the guest, or load arbitrary JavaScript.
Child diagnostics retain their original fd. The compiler owns response-file and
argument interpretation; the host only transports them.

File redirects, child-specific timeouts/memory limits and affinity requests fail
explicitly. Three absent redirect slots mean inherited stdio and are accepted.
Process statistics are reset to unavailable. `ExecuteNoWait` stays unsupported.
Cancellation is owned by the outer execution group, including the synchronous
child; this import does not implement native processes, signals or fork.

The linked Clang and LLD modules both retain the exact `exec_v1` import. In the
pinned LLVM revision, `lld/Common/ErrorHandler.cpp` calls `ExecuteAndWait` for
its optional error-handling script. Import presence does not grant that feature:
the host must return `-1` for every LLD child-execution request, including a directly
invoked linker. Only a top-level Clang invocation may dispatch the pinned linker.
The verifier requires the same seven-i32-to-i32 signature for both tools and
records this per-tool dispatch policy.

## Initial working directory

Both Clang and LLD include a C constructor at priority 101 that calls
`wasm_idle_process_v1.initial_cwd(pointer:i32, capacity:i32) -> i32` with a 4096-byte
buffer. The host writes the absolute UTF-8 cwd followed by NUL and returns its byte
count including NUL, or `-1` if it cannot do so. The initializer validates the count,
absolute prefix and terminator, rejects embedded NUL, then calls the real WASI
libc `chdir()`. A failed initialization exits 125 before the tool's main function.

This runs through the normal command constructors. It does not call malloc/chdir
from JavaScript before `_start`, inject a `PWD` value, or rewrite compiler/linker
arguments. Initializing Clang alone is insufficient: LLD must receive the same
process cwd so relative linker inputs, output paths and response files resolve
consistently. The consumer must implement this additional import for both modules.

## Isolated cached rebuild

`build.py` uses an existing matching source checkout and Ninja build as read-only
inputs. It copies and patches only `Program.cpp`, recompiles that translation unit,
replaces its member in a private copy of `libLLVMSupport.a`, compiles the cwd
initializer, and relinks private Clang and LLD modules sequentially. It never
invokes Ninja's build mode or edits a cached source or artifact.
The input source commit and Program.cpp hash must match `profile.json`.

```sh
python3 producer/clang-browser/tool-host/build.py \
  --source /path/to/pinned/llvm-project \
  --build /path/to/existing/wasi-raw \
  --output /path/to/new/private-output \
  --wasm-opt /path/to/pinned/emsdk/upstream/bin/wasm-opt \
  --wasm-opt-sha256 EXPECTED_BINARYEN_EXECUTABLE_SHA256
```

Use the Binaryen from the producer's pinned Emscripten SDK. `--plan-only` validates
and prints the commands and input identities without creating output. The
destination must not exist or overlap the source/build/toolchain inputs. Defaults
are two linker/Binaryen threads, a 10 GiB address-space limit per child, and a
45-minute timeout per child. This can fail on a constrained machine; a failed
candidate is preserved and cannot overwrite a previously completed output.

`--address-space-gib` sets inherited Linux `RLIMIT_AS` for each process; the old
`--memory-gib` spelling remains an alias. It limits virtual address space, not
resident RAM or the sum of a process tree. The receipt separates this enforced
limit from observed Linux `wait4` maximum RSS and CPU time, including failed and
timed-out children. The RSS observation is not a container-wide memory limit.
Killing a driver and its child together can leave only the driver's usage in
`wait4`; it must not be described as the linker's final CPU time or peak RSS.
Available host memory and competing jobs must be checked before each large link.

For a detached build, record its exit status separately from its log. Inspect the
small metadata files while it runs; the status helper does not read active logs:

```sh
python3 -B producer/clang-browser/tool-host/status.py \
  --output /path/to/private-output --exit-status /path/to/build.status
```

`--timeout-seconds` can explicitly raise the wall-clock cap to at most 14400 seconds
per child on a heavily contended machine; its default remains 2700. The O1/CGO1
candidate reached a 7200-second deadline after the last separate linker observation
showed only 756.2 CPU seconds at 7080.9 wall seconds. This justifies a distinct,
longer wall allowance, not a claim that the linker completed or a repeat without
resource admission. The memory and thread limits still apply. An external queue
may additionally inherit `RLIMIT_CPU` and require available RAM/disk before launch;
record that policy separately because this helper does not enforce it.

The link explicitly disables the SDK's implicit `wasm-opt`, keeps target features,
and then runs the explicitly hash-pinned Binaryen at `-Oz`. The output contains
raw and optimized Wasm, deterministic gzip, exact import/signature inventory,
commands, bounded resource settings and a receipt hashing each cached link input.
After completion the script verifies that those inputs, the original Program.cpp,
its object and the baseline binary have not changed.

For an initial correctness gate, `--skip-optimize` keeps the raw linker output and
records `optimization: none`; this does not claim the optimized size or performance
profile. All code, import, gzip and unchanged-input verification still runs.
Here `optimization` describes the optional Binaryen stage. Input objects and LTO
retain their own separately recorded optimization settings.

The cached input uses full `-flto`, which merges its IR for optimization. Setting
ThinLTO jobs or a cache directory cannot make that input an incremental ThinLTO
build; changing modes requires rebuilding the input objects. See the upstream
[ThinLTO design](https://clang.llvm.org/docs/ThinLTO.html). The helper pins full-LTO
codegen to one partition and records the mode and optional optimizer/codegen level
overrides. No override preserves the cached command's optimization defaults.

After an observed 10 GiB address-space failure, a separate correctness candidate
can explicitly lower link-time optimization while retaining all input objects:

```sh
# Add to the isolated build command above, after checking current resource headroom:
--threads 1 --address-space-gib 16 --timeout-seconds 7200 \
  --lto-opt-level 1 --lto-codegen-level 1 --skip-optimize
```

This changes the candidate's optimization provenance. It does not establish the
baseline producer's size/performance qualification, and it never changes the
read-only cached objects or default producer settings. Clang and LLD still link
sequentially, and every candidate must pass the actual consumer CLI gate.

The receipt identifies an incremental local candidate, not a reproducible clean
distribution. Cached objects are identified by their actual hashes; their source
association is not proven solely by the checkout's HEAD. A fresh full producer
profile and clean browser release suite are required before release promotion.
The full producer also exposes a clean-build option. It requires fresh, separate
work/output directories and permits only compiler outputs, so it cannot silently
enter the existing release packager:

```sh
CLANG_TOOL_HOST=ON \
  WASM_LLVM_TOOLCHAIN_WORK_DIR=/path/to/new-tool-host-work \
  WASM_LLVM_TOOLCHAIN_OUT_DIR=/path/to/new-tool-host-output \
  node producer/clang-browser/scripts/build-toolchain.mjs --compiler-only
```

This applies the checksum-pinned patch after the existing producer patches and
adds `-DLLVM_WASM_IDLE_TOOL_HOST=1` only to the WASI build. Its compiler receipt
records the profile and hashes of the extra source/notice/ABI materials. The
default `CLANG_TOOL_HOST=OFF` keeps the existing source and output contract.

The source pack preserves the original and patched translation unit, this patch,
the cached source diff, upstream/producer source pins, build recipe and the LLVM
license. It is an incremental reproduction pack, not the complete LLVM source
archive. Full sources remain available at the pinned repository revisions. LLVM's
`Apache-2.0 WITH LLVM-exception` notice is retained alongside the candidate.

## Validation

```sh
python3 -B -m unittest discover -s producer/clang-browser/tool-host -p test_build.py
node --test test/clang-tool-host.test.mjs
python3 -B producer/clang-browser/tool-host/test-abi.py \
  --build /path/to/existing/wasi-raw \
  --candidate /path/to/private-output \
  --output /path/to/new-abi-results
```

The ABI fixture links the actual patched LLVM Support archive. It verifies empty,
spaced and UTF-8 argv, inherited/explicit/empty environments, ordinary nonzero
exit, host failures, unavailable statistics, and unsupported-request rejection
before the host is called. Its import records the request and supplies a status;
this is a protocol test, not evidence that the Clang driver or linker ran. The
consumer's real compile/link/run fixture supplies that evidence separately.
The second fixture links the actual cwd constructor and WASI libc: `getcwd()` and
a relative file read must work in a directory containing Korean and a space even
when `PWD` is deliberately wrong. Invalid host responses and nonexistent cwd
must exit 125, then a fresh valid instance must still succeed.
Node disables the Wasm trap handler for this small protocol fixture so its large
virtual-memory reservation does not defeat the test runner's address-space cap;
this fixture makes no performance claim.

After a candidate has a complete verified producer receipt, run the independent
producer CLI fixture with an external process deadline:

```sh
timeout 300 node --disable-wasm-trap-handler \
  producer/clang-browser/tool-host/smoke-cli.mjs \
  /path/to/private-output /path/to/new-cli-results
```

This runs actual Clang and LLD bytes in Node's WASI host, including a genuine
non-root cwd with Korean/spaced paths, a response file, `-I`/`-D`, `-E`/`-S`/`-c`,
an ordinary diagnostic exit, and linking two object files through the real driver
bridge. It executes the resulting freestanding Wasm export and expects `42`.
The shared private filesystem contains real pinned linker bytes at its executable
path. The receipt records each command, actual child dispatch, stdout/stderr,
module identities, fixture hash and producer receipt hash. It does not qualify
the container VFS, Workers, Chromium, cancellation, or complete C/C++ sysroots;
those remain the consumer and release gates. The output directory must be new.
