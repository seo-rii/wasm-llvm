# Third-party notices

The Rust and LLVM browser-host patches in this directory are derived from the
`olimpiadi-informatica/wasm-compilers` project at commit
`8a37216d7529e8e7cb5aeac1610f0e654af86850` and have been modified for newer pinned Rust and LLVM
revisions. The upstream work is licensed under Apache License 2.0; see
`LICENSE.wasm-compilers`.

The `libloading_shim` source carried by `patches/rust.patch` includes code from `libloading 0.8.9`,
which is distributed under the ISC license. Its package metadata retains the upstream repository
and license identifier; see `LICENSE.libloading` for the license text. Rust, LLVM, GCC, wasi-libc,
backtrace-rs, and generated standard libraries remain under their respective upstream licenses.
