# Native WebAssembly source-debug baseline

This fixture exercises the native baseline that must pass before debugging
transport failures are attributed to the browser ports.

Pinned inputs:

- LLVM/Clang/LLDB `22.1.8` (`llvmorg-22.1.8`,
  `ca7933e47d3a3451d81e72ac174dcb5aa28b59d1`)
- Official `LLVM-22.1.8-Linux-X64.tar.xz` release archive, SHA-256
  `df0e1ecf16caf3489a272a5eea4eec9b0d82878f6477fa309504f918a0006384`
- WAMR `2.4.5` (`WAMR-2.4.5`,
  `25bd7eb63e828e4bd242cc9b38d260b4b31c6605`)
- `wasm32-wasi`, classic interpreter, embedded DWARF, `-O0`

The release archive digest matches its GitHub SLSA provenance subject. The
provenance resolves the `llvmorg-22.1.8` workflow input to the LLVM commit
listed above.

## C baseline

Compile `main.c` with a WASI sysroot and the pinned Clang:

```sh
/path/to/llvm-22.1.8/bin/clang \
  --target=wasm32-wasi \
  --sysroot=/path/to/wasi-sysroot \
  -resource-dir /path/to/llvm-22/lib/clang/22 \
  -g \
  -O0 \
  -fstandalone-debug \
  -fdebug-compilation-dir=/workspace \
  -ffile-prefix-map="$PWD=/workspace" \
  main.c \
  -o program.wasm

llvm-dwarfdump --verify program.wasm
```

The official binary archive does not include the WebAssembly compiler-rt
builtins. The exact-archive revalidation therefore used its Clang and
`wasm-ld` with the `libclang_rt.builtins-wasm32.a` resource directory from the
verified LLVM 22.1.8 Debian package. A standalone packaged compiler must ship
an equivalent pinned builtins archive. The resulting fixture module has
SHA-256
`beeff9d0f1121f93f22c5468dde405b99c38c8efe3f1c31a8ce47ff3b899becb`.
The audited Clang, sysroot, and resource directory were:

```text
/data/llvm-22.1.8-official/bin/clang
/usr
/tmp/wasm-native-debug.FGYI1jMW/llvm22/root/usr/lib/llvm-22/lib/clang/22
```

Build native WAMR from the pinned checkout:

```sh
cmake \
  -S product-mini/platforms/linux \
  -B build \
  -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DWAMR_BUILD_INTERP=1 \
  -DWAMR_BUILD_FAST_INTERP=0 \
  -DWAMR_BUILD_DEBUG_INTERP=1 \
  -DWAMR_BUILD_AOT=0 \
  -DWAMR_BUILD_JIT=0 \
  -DWAMR_BUILD_FAST_JIT=0 \
  -DWAMR_BUILD_LIBC_WASI=1 \
  -DWAMR_BUILD_LIBC_BUILTIN=0 \
  -DWAMR_BUILD_MULTI_MODULE=0 \
  -DWAMR_BUILD_SIMD=0 \
  -DWAMR_BUILD_MEMORY64=0 \
  -DWAMR_BUILD_SHARED_MEMORY=0

cmake --build build --parallel
```

Run WAMR first, then invoke the pinned LLDB from this directory:

```sh
iwasm --heap-size=1048576 -g=127.0.0.1:1234 program.wasm
lldb -b -s lldb.commands program.wasm
```

The heap option reserves WAMR's debugger scratch memory. Without it, WAMR
still supports breakpoints and variable reads but warns that expression
evaluation memory could not be allocated.

The verified baseline covers source breakpoint resolution, continue,
step-in/over/out, recursive stack unwinding, top-frame locals, globals, raw
linear-memory reads, stdout, and normal exit.

### Automated C baseline

Run the pinned native pair without reserving the fixture's historical port:

```sh
node run-native-baseline.mjs \
  --iwasm /path/to/iwasm \
  --lldb /path/to/llvm-22.1.8/bin/lldb \
  --program /path/to/program.wasm
```

The runner allocates a loopback port, writes a temporary copy of
`lldb.commands` with that endpoint, launches WAMR before LLDB, and always
terminates both processes when either side fails or times out, escalating to
`SIGKILL` after a bounded shutdown grace period. Native WAMR can buffer its
readiness diagnostic when stdout is piped, so the runner accepts either the
diagnostic or a short startup grace period; the LLDB connection remains the
authoritative readiness check.

A successful run verifies the resolved `main.c:13` breakpoint, recursive
argument and local values, the `global_bias` value, a raw linear-memory read,
LLDB's zero exit, and the guest's `total=15` stdout. Process orchestration,
dynamic-port rewriting, transcript rejection, and failure cleanup are covered
without native toolchain dependencies:

```sh
node --test test/native-wasm-debug.test.mjs
```

The memory command resolves `&global_bias` through DWARF instead of pinning a
numeric linear-memory address. Relinking the fixture with the same pinned
compiler can move `.data`, so a literal address would make the baseline depend
on one historical Wasm binary rather than the source-debug contract.

The same runner selects `lldb-rust.commands` and Rust-specific transcript
checks with `--language rust`:

```sh
node run-native-baseline.mjs \
  --language rust \
  --iwasm /path/to/iwasm \
  --lldb /path/to/llvm-22.1.8/bin/lldb \
  --program /path/to/rust-program.wasm
```

This verifies both `main.rs` breakpoints, step-over from the initialized
`seed`, recursive `n`, `doubled`, `child`, and `result` values, LLDB's zero
exit, and the guest's `rust-total=15` stdout. These checks deliberately use
generic DWARF inspection and do not imply that LLVM 22.1.8 has a Rust language
plugin.

## DAP attach baseline

The official LLVM archive contains `lldb-dap`. Run the automated stdio client
against the same C fixture:

```sh
node run-native-dap-baseline.mjs \
  --iwasm /path/to/iwasm \
  --lldb-dap /path/to/llvm-22.1.8/bin/lldb-dap \
  --program /path/to/program.wasm
```

It verifies the browser session's intended partial order:

```text
initialize request
initialize response
attach request
  attachCommands:
    target create /path/to/program.wasm
    process connect -p wasm connect://127.0.0.1:1234
initialized event
stopped event
configurationDone request
configurationDone response
attach response
threads request/response
stackTrace request/response
continue request plus continued event
exited event
terminated event
disconnect request/response
```

The attach uses `stopOnEntry: true`; `threads` and `stackTrace` return the
stopped `_start` frame, `continue` produces zero-exit `continued`, `exited`,
and `terminated` events, and `disconnect` succeeds while WAMR preserves
`total=15`. LLDB-DAP deliberately delays its successful `attach` response
until after `configurationDone`. The target can emit `stopped` before the
configuration response, and the `continued` event can race the successful
`continue` response, so the verifier enforces the required causal edges rather
than one over-constrained total ordering.

The dependency-free test uses a fake adapter to fragment DAP frames, validates
paths containing spaces, and covers both legal continue orderings:

```sh
node --test test/native-wasm-dap.test.mjs
```

## Rust baseline

`main.rs` was compiled with the exact stage-2 Rust compiler built from
`48c2cee70232ecc3a6a8e285b2e15620b39f82a7`. That compiler reports
`rustc 1.99.0-dev` and LLVM `22.1.8`.
The audited compiler binary was
`/data/wasm-rust-producer-48c2cee/build/rust-build/x86_64-unknown-linux-gnu/stage2/bin/rustc`.

```sh
/path/to/stage2/bin/rustc \
  --target wasm32-wasip1 \
  -C debuginfo=2 \
  -C opt-level=0 \
  -C strip=none \
  -C linker=/path/to/llvm-22.1.8/bin/wasm-ld \
  --remap-path-prefix=/path/to/fixture=/workspace \
  main.rs \
  -o rust-program.wasm

llvm-dwarfdump --verify rust-program.wasm
iwasm --heap-size=1048576 -g=127.0.0.1:1234 rust-program.wasm
lldb -b -s lldb-rust.commands rust-program.wasm
```

The tested stage-2 sysroot did not contain its expected `rust-lld`, so the
pinned LLVM archive's `wasm-ld` was selected explicitly. DWARF verification
reported no errors and recorded `/workspace` as the compilation directory.
The resulting Rust fixture module has SHA-256
`de2a773f20c7482848936dd2d6e472c0ab05e11c6f7899b339c49bfe110b61a9`.

The Rust session resolved the `main.rs:16` entry breakpoint and `main.rs:11`
recursive-function breakpoint, stepped from line 11 to line 12, showed the
recursive stack and correct top-frame `n`, `doubled`, `child`, and `result`
values, printed `rust-total=15`, and exited with status zero.

LLVM 22.1.8 reports that it has no Rust language plugin, so richer Rust type
inspection and expression evaluation remain unsupported. Generic DWARF
line/stack/basic-local handling works. The original LLVM 22.1.8 baseline also
exhibited the recursive parent-frame defect below for Rust: at the first line
11 stop, frame 0 correctly reported `n=2`, while its recursive parent should
have reported `n=3` but the backtrace rendered `n=2`.

## Recursive parent-frame fix

Selecting a non-top recursive frame does not fetch that frame's values with
unpatched LLVM 22.1.8. Packet logging shows only `qWasmLocal:0;...`; LLDB
consequently displays the top frame's argument and locals in parent frames.
Stack PCs and source lines are otherwise distinct.

Reproduce it with
`lldb -b -s lldb-parent-frame-bug.commands /path/to/program.wasm`, which sets
the line 8 breakpoint and inspects frames 0, 1, and 2:

```text
frame 0 expected/actual: n=1, doubled=2
frame 1 expected:        n=2, doubled=4
frame 1 actual:          n=1, doubled=2
frame 2 expected:        n=3, doubled=6
frame 2 actual:          n=1, doubled=2
```

With `log enable -f rsp.log gdb-remote packets`, the three reads should cause
`qWasmLocal:0;1`, `qWasmLocal:1;1`, and `qWasmLocal:2;1`. The actual transcript
contains only `qWasmLocal:0;1`; selecting frames 1 and 2 produces no new
`qWasmLocal` request.

Sending those packets explicitly proves that WAMR can read each frame. For the
verified artifact, WAMR returned frame bases `0x0000ff90`, `0x0000ffb0`, and
`0x0000ffd0`. Reading `DW_OP_fbreg +24` from those bases produced `n=1`,
`n=2`, and `n=3`, respectively. The defect is therefore after stack discovery
and before LLDB requests a parent frame's virtual register; it is not a WAMR
frame-index parsing failure.

### LLDB root-cause candidate

At the pinned upstream revision:

- `UnwindWasm::DoGetFrameInfoAtIndex` in
  `lldb/source/Plugins/Process/wasm/UnwindWasm.cpp:58-70` assigns `cfa = 0` to
  every frame.
- `StackID::operator==` in `lldb/source/Target/StackID.cpp:53-65` treats frames
  as equal when both CFA and symbol scope match. Recursive calls have the same
  symbol scope.
- `ExecutionContextRef` stores that `StackID`, then
  `ExecutionContextRef::GetFrameSP` in
  `lldb/source/Target/ExecutionContext.cpp:679-696` asks
  `StackFrameList::GetFrameWithStackID` in
  `lldb/source/Target/StackFrameList.cpp:739-763` for the first equal cached
  frame while a variable is evaluated. This resolves a recursive parent back
  to the top frame before `RegisterContextWasm` can send its concrete frame
  index.
- `RegisterContextWasm` itself already passes
  `frame->GetConcreteFrameIndex()` in `UnwindWasm.cpp:22-35`, reads
  `m_concrete_frame_idx` in `RegisterContextWasm.cpp:65-83`, and encodes it in
  `ProcessWasm.cpp:136-153`. Explicit packets prove that `ProcessWasm` and WAMR
  accept non-zero frame indices.

The producer now carries the smallest correction as
`producer/lldb-browser/patches/0007-wasm-recursive-frame-cfa.patch`: the
synthetic CFA is derived from `call_stack_size - frame_idx` and placed below a
fixed 32-bit ceiling. Frames at different depths are therefore distinct and
ordered as a downward-growing stack. A caller also keeps the same CFA when a
callee is pushed; using the concrete frame index instead would renumber that
caller and make LLDB's step-over plan stop inside the callee.

The checked-in patch includes an upstream-style `TestWasm.py` regression that
creates two recursive `add` frames, inspects each through LLDB's normal
variable API, asserts ordered CFAs and different local values, and checks for
both `qWasmLocal:0;2` and `qWasmLocal:1;2`. The patch was verified against the
pinned LLVM commit, and the packaged browser `lldb-web-dap` now passes a C++
DAP `next` across a real function call plus C, C++, and Rust lazy-variable and
memory checks. A live recursive WAMR/browser fixture must still verify parent
frame locals before arbitrary-frame locals are advertised as a released
runtime capability.
