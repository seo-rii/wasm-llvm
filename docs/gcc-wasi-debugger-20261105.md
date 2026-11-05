# GCC WASI C++26 debugger qualification, 2026-11-05

The optional `gnu-debugger-registration-v1` component provides the original GNU
`std::is_debugger_present`, `std::breakpoint`, and `std::breakpoint_if_debugging`
implementation. GCC source remains pinned at
`ac20dcd5f8c5ae858f9b2d9cdf4140c0738e5e27`; no compiler/backend source changes or
replacement C++ implementation are involved.

The auxiliary archive contains only GCC's unmodified `debugging.cc`, accompanied
by wasi-sdk 33's pinned real signal archive. The base GNU runtime, headers,
compiler assets, default exclusions and existing x86 GCC behavior are preserved.
The SDK accepts C++26 only for a verified WASI bundle with the new capability and
both archives. The standalone GCC package gains no compiler payload or dependency.

## Actual validation

| Check | Result |
|---|---|
| Native GNU programs | Five passed: two normal, three genuine unreachable traps |
| Independent admission | 964 reopened files; six dependency checks / 100 headers; original GNU unit rebuilt; five fresh and five retained programs executed |
| Admission mutation controls | 17 rejected, including changed mandatory tools, runtime libraries, headers and source/command evidence |
| Existing producer units | 232 passed, four optional retained-evidence tests skipped |
| GCC SDK units / package-budget units | 191 / 36 passed with Vitest 5.0.5 |
| Base-package admission controls | 25 passed, including the actual base bundle and in-memory corruption cases |
| Actual compiler Worker | C++26 debugger, default C stdin/stdout, default C++ iostream/vector: three passed in Chromium and Node WASI |
| Actual CDP execution Workers | 14 cases: eight normal returns, six terminal traps, four debugger-observed traps with 14 Wasm frame records |
| Local fresh standalone SDK installation | 2,734,175 bytes / 188 files / four packages; 1,953 bytes below the adjusted GCC cap |
| CI fresh standalone SDK installation | 2,734,149 bytes / 188 files / four packages |
| CI aggregate public-package installation | 42,794,687 bytes / 3,402 files / 66 packages; requires a 115 KiB byte-budget adjustment with file/package limits retained |

The browser phase runs actual retained native-GCC C++ probe exports and the
Wasm-host-GCC program's C++ main. The native probes call the original GNU standard
functions; they do not execute the native program's main in this phase. Native
main execution was checked separately by Node WASI. No guest source writes the
registration cell during CDP qualification. The 14 frame records are a stack-frame
sum, not a count of independent pauses.

## Host contract and limits

A real CDP observer enables the particular Worker debugger, then writes `-1` to
GNU's existing `debugger_signal_for_breakpoint` data cell through its exported
linear-memory address. An enabled observer without registration still observes
false. Clearing to `0` before orderly detach restores false; new Workers start
clean. Unexpected observer loss requires terminating the run/Worker. This failure
policy is documented; unexpected disconnect was not injected in this matrix.

`std::breakpoint()` and a registered conditional breakpoint produce the real
Wasm `unreachable` instruction. CDP captures a Wasm pause; resuming propagates the
terminal runtime error. Resuming ordinary C++ after the call, arbitrary DevTools
autodetection, positive signal registration, and other libstdc++exp APIs are
outside this profile. See [the complete build and host contract](../producer/gcc-wasi/DEBUGGER.md).

## Preserved evidence

The extension preserves all 107 base files and all 1,095 base sysroot files,
adding exactly two archives. Historical base proofs are explicitly retained under
`provenance/base`. Native admission and packaging completed before an external
cleanup removed the previous native tool worktree. A later independent check
verified the copied base proof graph and all 26 retained native artifacts. The
browser phase reopens retained artifacts and records its narrower input scope;
it does not claim a fresh reopening of the removed native tools. Reproduction
uses the source pins and scripts with a fresh build tree.

The original and extended manifests remain `unverified`. Actual SDK testing uses
a private candidate differing only in `qualification.status`. No artifact was
published or deployed. The [machine-readable record](gcc-wasi-debugger-20261105.json)
binds source hashes, exact receipts, measured results, completed exit codes, and
private log paths. Earlier failed environment preparations remain separately
recorded from successful runs.

The first package CI run confirmed the GCC allowance, but newer dependencies
permitted by the existing public version ranges increased the aggregate install
above its earlier measurement. The aggregate cap follows this actual install:
42,796,032 bytes, leaving 1,345 bytes of headroom. No dependency range, file count,
or package-count limit changes are needed.
