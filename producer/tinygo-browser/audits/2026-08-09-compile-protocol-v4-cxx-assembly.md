# TinyGo compile protocol v4 C++/assembly audit

Date: 2026-08-09

## Result

The browser compiler remains a patched build of upstream TinyGo 0.40.1, not a wasm-idle-authored
language subset. Compile protocol v4 preserves the v2 generated-`go:embed` and v3 CGo/C handoffs,
then adds two deliberately bounded native-source capabilities:

- `target-cxx-freestanding`: workspace `CXXFiles` compiled by the packaged Clang driver to LLVM
  ThinLTO bitcode; and
- `target-clang-assembly`: uppercase `.S` selected from a CGo package, compiled by Clang's
  assembler-with-cpp to a relocatable WebAssembly object.

The source-locked producer, independent wasm-idle Node consumer, and headless Chromium consumer all
compiled and executed the 45-package acceptance workspace. Its exact output was
`hello Ada count=2 total=3 cgo=5/20 cxxasm=13\n`.

## Identity and artifacts

| Item | Evidence |
| --- | --- |
| TinyGo | 0.40.1, commit `db9f1182f5f2a64ea496752899626578d2b313a7` |
| Compile protocol | version 4, `wasm-llvm-tinygo-link-plan-v4` |
| Compiler | 70,278,896 bytes, SHA-256 `ea209810bc713d3cb74c2401d4f048f8e4e99e267e21e9e7d69e4c11b14ba4f9` |
| Reduced root | 24,266,044 bytes, SHA-256 `82a5b88689cbcd569c731d71be51ae68d2497d45000eeb2deaba0bb231db54f3` |
| Producer receipt | SHA-256 `d1825e7c1791b7bab6ae22ec967a56deb7f16e4296bf36a283cd3be205a64b01` |
| Node acceptance receipt | SHA-256 `e596ee87ebf54bcc2803f3c6abbcb85dca59bda5085436f581fe5dceab4eba6d` |
| Chromium acceptance receipt | SHA-256 `4b7d14e9924c55cdd50f665030d1ad8e6e9ea7c7f162ccd873a971e5afb73288` |

The producer receipt requires the upstream `builder`, `cgo`, `compiler`, `interp`, `loader`,
`transform`, and `go-llvm` package graph. It rejects handwritten `wasmbridge`, frontend, backend,
or subset compiler identities.

## Native-source policy

Freestanding C++ is not general hosted C++ support. Every `CXXFile` is compiled with the equivalent
of C++17, `-ffreestanding`, `-nostdinc++`, `-fno-exceptions`, `-fno-rtti`,
`-fno-threadsafe-statics`, `-fno-use-cxa-atexit`, and disabled unwind tables. Global and exit-time
constructors are errors. No libc++, libc++abi, standard-library headers, exceptions, RTTI,
constructors/destructors, or user `CXXFLAGS` contract is provided.

Assembly support is similarly narrow. Only uppercase `.S` discovered by upstream package loading in
a package that also has CGo input is accepted. Clang performs preprocessing and assembly without
ThinLTO, and the adapter requires a valid WebAssembly module containing the `linking` custom section.
Lowercase `.s`, workspace assembly outside a CGo package, and Go/Plan 9 assembly are rejected.
Pinned GOROOT assembly continues to use upstream TinyGo's existing intrinsic/replacement behavior
and is not reclassified as a workspace native object.

## Object and link evidence

The producer emitted this canonical object inventory:

| Kind | Bytes | SHA-256 |
| --- | ---: | --- |
| program | 264,107 | `88e99182afd6841212fabe8cc7610137dd52f9e9525c02d72eff50040b47d984` |
| target C ThinLTO | 3,044 | `a014cc4363836be617d421efc426119267549d3d98dca2e9afe20e3f2f5d353e` |
| target C++ ThinLTO | 3,704 | `13b5aa74651f61ab5474dfbcf8eb0c8175194dc93cb65e7b5d81bbe4265e2aad` |
| target assembly | 801 | `67f3a97d6e62cfcc3fdb12919ccb1f9310c19c39304769379a6af2535421abba` |
| generated embed | 1,142 | `980f52a81ad5522457ad57519cda9220c41ae267f381ecc788f045bbd547e527` |

The adapter binds the exact expected package/source inventory, transitive dependency hashes,
object kinds/formats/sizes/hashes, capability set, and deterministic order. LLD receives program,
compiler-rt/runtime extras, sorted target C/C++/assembly objects, wasi-libc, and embed objects in the
declared order. Omissions, duplicates, reordered native objects, malformed bitcode, or assembly
without a WebAssembly `linking` section fail before external linking.

The independent wasm-idle Node and Chromium runs produced byte-identical objects, 160,690-byte
unoptimized Wasm (SHA-256 `a09a086cdb515e90568575153877f93f754ad37c3f6b6d85e8b212fd6d039a94`),
and 249,054-byte Binaryen output (SHA-256
`f0328e05805f019e1978d9e1c7ebb72468f4eeb1e3188ac4b3f254ee0edbcca4`).

## Remaining blockers

`readiness.ready` remains false. Before public TinyGo registration, the project still needs:

- an explicit policy and fixtures for hosted C++, libc++/libc++abi, exceptions, RTTI, static
  lifetime, and user C++ flags—or an explicit permanent rejection contract;
- an explicit policy for Go/Plan 9 and non-CGo assembly plus custom `#cgo LDFLAGS`;
- controlled offline module/vendor inputs without implicit network fetches;
- disposable workers with enforceable time and memory budgets for package discovery, compiler,
  LLD, and optimizer phases; and
- broader differential fixtures for generics, package initialization, goroutines, and channels.
