# libc++ header modules experiment

Status: experiment only. Nothing in the shipped artifacts or the browser hosts uses modules.

Most C++ compile time in the browser goes into parsing the standard library again for every
translation unit. A precompiled `<bits/stdc++.h>` removes that cost only for sources that start
with that umbrella header. Clang header modules could cover any set of standard includes: each
`#include <vector>` becomes an import of a prebuilt `.pcm`, and modules combine freely.

`scripts/probe-header-modules.mjs` measures this with the WASI clang module in Node's V8:

```sh
node producer/clang-browser/scripts/probe-header-modules.mjs \
  --compiler artifacts/clang-browser \
  --sysroot artifacts/clang-browser/sysroot.tar.zip \
  --wasi-sysroot /path/to/wasi-sysroot-33.0+m.tar.gz --runs 3
```

The probe compiles a `<bits/stdc++.h>` program and a program with five selected standard headers
using textual includes, a precompiled `<bits/stdc++.h>`, and implicit modules
(`-fmodules -fimplicit-module-maps` with a cache directory). For each mode it links and runs the
program to check its output, and it reports the precompiled header and module cache sizes.

## What modules need on WASI

- The complete libc++ headers and `module.modulemap`. The shipped sysroot is pruned to the
  headers that `<bits/stdc++.h>` reaches, and libc++'s module map lists every header in one `std`
  module, so the probe overlays the complete `noeh` libc++ and WASI libc headers from the pinned
  WASI SDK sysroot (about 7 MB of libc++ headers).
- `-D_WCHAR_H_CPLUSPLUS_98_CONFORMANCE_`. wasi-libc does not declare the const-correct
  `wcschr`/`wcsstr` overloads that glibc provides, so libc++ defines them in its textual
  `<wchar.h>`; inside the `std` module that header is entered from several submodules and the
  definitions collide. The macro selects the plain C signatures instead, which changes overload
  resolution for those wide-string functions.
- `-D_WASI_EMULATED_SIGNAL`, `-D_WASI_EMULATED_PROCESS_CLOCKS`, `-D_WASI_EMULATED_MMAN` and
  `-D_WASI_EMULATED_GETPID`, because `<csignal>` and other members of `std` otherwise stop with
  `#error` on WASI. With these, code using the emulated APIs compiles and then needs the matching
  `libwasi-emulated-*` library at link time instead of failing at compile time.

The same failures occur with the native WASI SDK 33 clang, so they come from libc++'s module map
on wasi-libc rather than from the browser host.

## Results

LLVM 22.1.8 shipped `Oz` clang, Node 24, on a shared 8-core build machine:

| Program | Textual | Precompiled `<bits/stdc++.h>` | Modules, cold cache | Modules, warm cache |
| --- | --- | --- | --- | --- |
| `<bits/stdc++.h>` | 7.5 s | 1.7 s | 29.6 s | 2.4 s |
| five selected headers | 11.0 s | not applicable | 41.4 s | 4.0 s |

| Artifact | Raw | gzip |
| --- | --- | --- |
| precompiled `<bits/stdc++.h>` | 19.8 MB | 12.4 MB |
| module cache (12 files) | 46.6 MB | 27.5 MB |
| of which `std.pcm` | 41.2 MB | 24.5 MB |

All modes produced the expected program output.

## Conclusion

Warm modules make arbitrary standard-library includes 2.5 to 3 times faster, close to the
precompiled header. They cost a 30 to 40 second first build of the whole `std` module and a
47 MB cache per C++ standard and flag set, which is too large to ship and too slow to build on the
first run. Adoption would also change the sysroot contract (complete libc++ headers) and accept
the two semantic differences above. The precompiled `<bits/stdc++.h>` covers the dominant
competitive-programming case at a fifth of the first-build cost, so it is the better default;
modules remain an option for workloads that do not use the umbrella header.
