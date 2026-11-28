# Linux x86-64 compiler fixtures

The wasm-idle consumer PR check uses these producer bundles to compile C and C++ in
Chromium and run the resulting static ELF executables on Linux. Each archive contains
a complete producer bundle, including compiler receipts, target sysroot, provenance
and notices. The manifest digests identify the inputs independently of the tar compression.

| Archive | Compiler | Manifest | Manifest SHA-256 |
| --- | --- | --- | --- |
| `clang.tar.xz` | Clang/LLD 22.1.8 | `cross-toolchain.v1.json` | `dbb80dbe1fc999b4d927585d54922d3a5402cbd781ffb45f558d2d06738a5fc3` |
| `gcc.tar.xz` | GCC 16.2.0 | `gcc-toolchain.v1.json` | `b241298ff39c2d8b9fa572062b5f4c21863f6ff7bbd2b6b61809c2e2748cc5f3` |
| `gcc13.tar.xz` | GCC 13.3.0 | `gcc-toolchain.v1.json` | `78dde7f8f1088d52ecfd05d11cec721c3ac211d45f2fa7e6c222abab885a3705` |

The GCC 13 compiler modules and build receipt come from the
[GCC 13 producer run](https://github.com/seo-rii/wasm-llvm/actions/runs/40202085573).
Its sysroot also includes the target `unwind.h` from Ubuntu's
`libgcc-13-dev_13.3.0-6ubuntu2~24.04.1_amd64.deb`. Both the GNU provenance
and the packaged inventory record the header digest. Its source lock and two
GCC patches accompany the compiler.

The GCC 13 and Clang fixtures include the C++23 stacktrace support archive
from Ubuntu's `libstdc++-13-dev_13.3.0-6ubuntu2~24.04.1_amd64.deb`.
The SHA-256 of its `libstdc++exp.a` is
`a52b9d446117215e82d524d5b7a265b92985abd26e0679fa93b2b33a176954ee`.

The Clang input is the `x86-cross-bundle-93f7bda4da6c5543702173cd6e1e8148043036b5`
CI artifact. The fixture manifest counts all 2,605 target and resource files.
Its receipt identifies the LLVM revision, patches and SDKs.
The GCC 16 fixture combines the [GCC 16 compiler build](https://github.com/seo-rii/wasm-llvm/actions/runs/46007423138)
with the [Ubuntu GNU sysroot](https://github.com/seo-rii/wasm-llvm/actions/runs/46005445937)
using the GCC packager. Its `sources.lock.json` lists compiler and host library sources,
and the archive includes the GCC patch used by the build. See the [Clang recipe](../../../producer/clang-browser/cross/README.md)
and [GCC recipe](../../../producer/gcc-browser/README.md) for the corresponding build commands.

`gnu-provenance.json` in each archive records the Ubuntu source package names and
versions for the target headers, CRT and libraries. Their corresponding source packages
are available from Ubuntu. Clang uses [glibc](https://launchpad.net/ubuntu/+source/glibc/2.39-0ubuntu8.9),
[GCC 13](https://launchpad.net/ubuntu/+source/gcc-13/13.3.0-6ubuntu2~24.04.1)
and [Linux](https://launchpad.net/ubuntu/+source/linux/6.8.0-147.147).
GCC 16 uses [glibc](https://launchpad.net/ubuntu/+source/glibc/2.44-1ubuntu2.1),
[GCC 16](https://launchpad.net/ubuntu/+source/gcc-16/16.2.0-3ubuntu1)
and [Linux](https://launchpad.net/ubuntu/+source/linux/7.3.0-11.12).

To refresh a fixture, qualify the new bundle using the producer and consumer
checks, then archive its directory with normalized outer tar metadata:

```sh
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  --mode='u=rwX,go=rX' --format=gnu -C "$bundle" -cf - . | xz -4 --threads=1 > "$archive"
```

Update the manifest digest here and the producer revision and digest in the
wasm-idle x86 qualification workflow together.
