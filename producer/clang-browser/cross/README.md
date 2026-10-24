# x86-64 GNU/Linux cross compiler

This opt-in producer builds WASI-hosted Clang and ELF LLD that emit native
`x86_64-unknown-linux-gnu` files. Native output is a downloadable artifact. It is never
instantiated as WebAssembly. The existing WASI compiler, WASI libc++ sysroot, clangd and
release packaging retain their current defaults.

The recipe and fixture tests are implemented; they do not constitute an executed LLVM
build. A newly packaged bundle has `qualification.status: "unverified"`. Admit a bundle
only after the producer qualification and the consumer's Chromium qualification pass
against the same manifest SHA-256. Native Linux execution of generated fixtures is a
separate integration gate. Preserve those reports alongside the immutable bundle.

## Build the compiler

Use a Linux builder with CMake, Ninja, Git, tar, Node 20 or newer, a native C/C++ compiler,
network access and sufficient disk and memory for two LLVM builds. Work and output paths
must be fresh, separate directories. This command builds the native TableGen tools, then
the WASI compiler with the X86 backend and the ELF-only LLD patch:

```sh
CLANG_TARGET_PROFILE=x86_64-linux-gnu \
  WASM_LLVM_TOOLCHAIN_WORK_DIR=/build/native-cross-work \
  WASM_LLVM_TOOLCHAIN_OUT_DIR=/build/native-cross-compiler \
  NINJA_JOBS=2 \
  node producer/clang-browser/scripts/build-toolchain.mjs --compiler-only
```

`pnpm build:clang-native` is an equivalent entry point with the same required directory
environment variables. The compiler host remains `wasm32-wasip1`. The profile enables the
existing synchronous `exec_v1` and initial-cwd imports, and requires the pinned LLVM,
WASI SDK and Emscripten SDK inputs. It refuses target, host, source and SDK overrides
that would invalidate those pins. Clang's resource headers are preserved in full,
including the x86 SIMD headers. WASI target libraries and compatibility PBDS headers
are not included in this output.

The build produces `compiler/clang`, `compiler/lld`, `compiler/resource-include/`, the
profile, patches, LLVM notice and `compiler-build.json`. The receipt binds the modules,
resource headers, source revision, applied patches, SDK trees and build tools. It is
evidence of its inputs and outputs, not an independent claim that the resulting compiler
works. `NINJA_JOBS` controls build parallelism; peak Wasm linker memory still needs to be
measured on the builder.

## Import a native GNU sysroot

Run this on a Debian or Ubuntu **amd64** installation with matching native GNU development
packages installed (`g++`, `libc6-dev`, `libstdc++-<major>-dev` and `libgcc-<major>-dev`).
The importer queries dpkg ownership and the selected native compiler. It copies only
selected GNU headers, CRT objects, static libraries and associated copyright notices,
including notices' referenced common license texts. Input symlinks must resolve to the
selected package-owned files. The normalized output has regular files and directories.

```sh
node producer/clang-browser/cross/import-sysroot.mjs --preflight
node producer/clang-browser/cross/import-sysroot.mjs \
  --output /build/native-gnu-sysroot \
  --provenance /build/native-gnu-provenance.json
```

Use `--compiler g++-14`, for example, to select a particular installed version. Output
and provenance paths must be new. Preflight is read-only. Pin the builder's distribution
and package versions for repeated production builds; the importer records the actual
installed versions, without claiming that current distribution repositories are frozen.

The receipt records GCC directory and compiler versions, glibc and distribution identity,
each binary/source package name and version, the source acquisition metadata available
from dpkg, notices, and a SHA-256 for every normalized file. Those records are useful for
source acquisition and redistribution review; they are not source archives. Preserve the
corresponding GNU sources and source availability information with a distributed release.

The packager requires the real GNU `bits/stdc++.h` and PBDS implementation, x86-64 CRT
objects, `libstdc++.a`, `libgcc.a`, `libgcc_eh.a`, `libc.a` and `libm.a`. It validates static
archive object architecture, resolves the GNU libm linker script, verifies the entire
file inventory, and rejects the existing WASI compatibility shims. Clang's own resource
headers are added from the matching compiler build, rather than the native GCC install.

## Package and qualify

```sh
node producer/clang-browser/cross/package.mjs \
  --compiler /build/native-cross-compiler/compiler \
  --sysroot /build/native-gnu-sysroot \
  --provenance /build/native-gnu-provenance.json \
  --output /build/native-cross-bundle
node producer/clang-browser/cross/qualify.mjs \
  --bundle /build/native-cross-bundle \
  --output /build/native-cross-node-check
```

Packaging requires a new output path, verifies the modules' exact host imports against
the existing ABI verifier and writes the manifest last. It never upgrades qualification
status based on fixture tests. Node qualification runs the actual driver and linker,
checks `--print-targets` for x86-64, compiles and links C and C++ with the GNU headers,
PBDS and exceptions, verifies AVX2 `vpaddd`/YMM assembly, and checks a syntax failure.
The linked outputs must be x86-64 ELF64 executables without a dynamic interpreter.
The resulting `qualification.json` contains command results, driver dispatches and the
manifest/asset hashes. Native executables are inspected but not run by this command.

The `Clang x86-64 cross compiler` workflow builds this profile for relevant pull requests
and supports manual dispatch. Its second job checks out the pinned wasm-idle consumer,
compiles in a Chromium Worker, disassembles AVX2 object output, and runs the generated
baseline executables on Linux with stdin/stdout checks, including PBDS and exception
unwinding. Compiler build logs, exit status, Node reports, browser reports and the bundle
are retained as workflow artifacts for seven days. It does not publish a release.
The two jobs use separate runners so the LLVM build tree does not compete for disk with
the browser test dependencies. Runner capacity and end-to-end success must still be
established by an actual successful workflow run.

`pnpm test:clang-native` runs small structural fixtures for profile selection, provenance,
sysroot validation, deterministic packaging and ELF inspection. Its synthetic ABI/ELF
fixtures are deliberately not compiler or runtime qualification evidence.

## Consumer contract

The consumer pins the SHA-256 of `cross-toolchain.v1.json` outside the downloaded bundle.
The manifest has schema version 1, kind `clang-x86_64-linux-gnu`, host `wasm32-wasip1`,
target `x86_64-unknown-linux-gnu`, CPU profiles `x86-64` and `x86-64-v3`, and static linking.
Each of `assets.clang`, `assets.lld` and `assets.sysroot` has a relative `path`, exact raw
`bytes` and lowercase `sha256`.

| Bundle file | Consumer use |
| --- | --- |
| `clang.wasm` | Run the verified driver as `/bin/clang` |
| `lld.wasm` | Dispatch the verified ELF linker as `/bin/ld.lld` |
| `sysroot.tar` | Mount regular files/directories below `/sysroot` |
| `compiler-build.json` | Compiler source, toolchain and output receipt |
| `gnu-provenance.json` | GNU package/source metadata, notices and full file inventory |
| `LICENSE.LLVM.txt` | Compiler/linker license notice |

Tar entries are relative to the sysroot root (`usr/include/...`,
`usr/lib/gcc/x86_64-linux-gnu/<major>/...`, `lib/clang/22/include/...`). The manifest sets
`sysrootPath: "/sysroot"`, `gccToolchain: "/sysroot/usr"`, the exact `gccInstallation`,
and `resourceDir: "/sysroot/lib/clang/22"`. The public `gnu` summary contains
`gccVersion`, `glibcVersion`, `distribution`, `source: "gnu-provenance.json"`, and
`licenses` listing paths within the sysroot. `provenance.gnuReceipt` pins the complete
receipt's bytes and SHA-256. Assets are raw files; HTTP content encoding is a transport
choice, not another archive layer. No MemFS module is required by this contract.

The host mounts the actual verified modules at the declared executable paths for driver
discovery, implements the existing synchronous tool host and initial cwd ABI, and shares
the filesystem with the child linker. The C++ command includes `--driver-mode=g++`:

```text
/bin/clang --driver-mode=g++ --target=x86_64-unknown-linux-gnu
  --sysroot=/sysroot --gcc-toolchain=/sysroot/usr
  -resource-dir=/sysroot/lib/clang/22 -fuse-ld=lld --ld-path=/bin/ld.lld
  -stdlib=libstdc++ --rtlib=libgcc --unwindlib=libgcc
  -static -fno-pie -march=x86-64-v3 -std=gnu++20 -O2 main.cpp -o main.elf
```

The baseline `x86-64` profile uses the architectural SSE2 baseline; `x86-64-v3` enables
AVX2 and requires a compatible native machine to run the downloaded executable. Never
derive the target CPU from the browser machine with `-march=native`. This is Clang with
the real GNU library implementation. GCC-only optimization/target pragmas and every GNU
extension are not guaranteed to behave as GCC does. Initial qualification covers ordinary
single translation units with static linking; LTO, plugins, PCH and dynamic linking have
no admission path in this profile.
