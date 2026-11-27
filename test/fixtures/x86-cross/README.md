# Linux x86-64 compiler fixtures

The wasm-idle consumer PR check uses these producer bundles to compile C and C++ in
Chromium and run the resulting static ELF executables on Linux. Each archive contains
the complete original bundle, including compiler receipts, target sysroot, provenance
and notices. The manifest digests identify the inputs independently of the tar compression.

| Archive | Compiler | Manifest | Manifest SHA-256 |
| --- | --- | --- | --- |
| `clang.tar.xz` | Clang/LLD 22.1.8 | `cross-toolchain.v1.json` | `9b2a5471a3664b95562fbff63b0712065f07fc41f594a31f74999ebf53af2942` |
| `gcc.tar.xz` | GCC 16.2.0 | `gcc-toolchain.v1.json` | `3170bee5a1a10f8474eab5d5bdeb6802ddb4c34a624804d6d51fbf8c650af86e` |

The Clang input is the `x86-cross-bundle-93f7bda4da6c5543702173cd6e1e8148043036b5`
CI artifact. Its receipt identifies the LLVM revision, patches and SDKs. The GCC input
is the GCC 16 bundle recorded in the [producer's x86 regression results](../../../docs/gcc-wasi-relaxed-simd-20261106.md).
Its `sources.lock.json` lists compiler and host library sources, and the archive includes
the GCC patch used by the build. See the [Clang recipe](../../../producer/clang-browser/cross/README.md)
and [GCC recipe](../../../producer/gcc-browser/README.md) for the corresponding build commands.

`gnu-provenance.json` in each archive records the Ubuntu source package names and
versions for the target headers, CRT and libraries. Their corresponding source packages
are available from Ubuntu. Clang uses [glibc](https://launchpad.net/ubuntu/+source/glibc/2.39-0ubuntu8.9),
[GCC 13](https://launchpad.net/ubuntu/+source/gcc-13/13.3.0-6ubuntu2~24.04.1)
and [Linux](https://launchpad.net/ubuntu/+source/linux/6.8.0-147.147).
GCC uses [glibc](https://launchpad.net/ubuntu/+source/glibc/2.44-1ubuntu2),
[GCC 16](https://launchpad.net/ubuntu/+source/gcc-16/16.2.0-3ubuntu1)
and [Linux](https://launchpad.net/ubuntu/+source/linux/7.3.0-10.10).

To refresh a fixture, qualify the new bundle using the producer and consumer
checks, then archive its directory with normalized outer tar metadata:

```sh
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  --mode='u=rwX,go=rX' --format=gnu -C "$bundle" -cf - . | xz -4 --threads=1 > "$archive"
```

Update the manifest digest here and the producer revision and digest in the
wasm-idle x86 qualification workflow together.
